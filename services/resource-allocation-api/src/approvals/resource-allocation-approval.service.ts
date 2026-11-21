import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ResourceAllocation } from '../allocations/resource-allocation.entity';
import { allocationResponse } from '../allocations/allocation-response';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { isDatabaseUnavailable } from '../database/database-errors';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceRequest } from '../requests/resource-request.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import type { ApprovalCandidateQueryDto, ApproveRequestDto } from './approve-request.dto';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ApprovalConditions {
  initiativeId: string;
  initiativeCode: string;
  initiativeName: string;
  groupId: string;
  groupName: string;
  resourceProfileId: string;
  resourceProfileName: string;
  startDate: string;
  endDate: string;
  weeklyHours: number;
}

interface ApprovalCandidateCursor {
  version: 1;
  groupId: string;
  displayName: string;
  id: string;
}

@Injectable()
export class ResourceAllocationApprovalService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    private readonly databaseConfigured: boolean,
  ) {}

  async listCandidates(localUserId: string | undefined, requestId: string, query: ApprovalCandidateQueryDto) {
    this.ensureDatabaseAvailable();
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw this.validationError('limit must be an integer between 1 and 100.');

    try {
      const actor = await this.requireActivePerson(this.dataSource.manager, localUserId);
      const request = await this.dataSource.getRepository(ResourceRequest).createQueryBuilder('request')
        .where('request.id = :id AND request.removed_at IS NULL', { id: requestId })
        .getOne();
      if (!request) throw this.notFound('Request');
      if (request.requesterId === actor.id) {
        throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'A person cannot approve their own request.');
      }
      if (!['WAITING_FOR_PRESENTATION', 'PENDING_TEAM_DECISION'].includes(request.decisionState)) {
        throw new ResourceAllocationException('INVALID_REQUEST_TRANSITION', 'Request cannot be approved', 422, 'This request is not waiting for an approval.');
      }
      const conditions = request.requestedConditions as Record<string, unknown>;
      const groupId = this.normalizeUuid(String(conditions.groupId ?? ''), 'request group');
      const group = await this.dataSource.getRepository(ResourceGroup).findOne({ where: { id: groupId, active: true } });
      if (!group) throw this.ineligibleReference();
      this.requireDeciderScope(actor, request, group.id);
      const clock = await this.dataSource.query(`
        WITH operation_clock AS (SELECT clock_timestamp() AS now)
        SELECT now, (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS today
        FROM operation_clock
      `) as Array<{ now: Date; today: string }>;
      if (request.decisionState === 'WAITING_FOR_PRESENTATION' && new Date(clock[0].now).getTime() > request.expirationDueAt.getTime()) {
        throw new ResourceAllocationException('INVALID_REQUEST_TRANSITION', 'Request deadline passed', 422, 'This request is past its presentation deadline and cannot be approved.');
      }
      if (typeof conditions.startDate !== 'string' || conditions.startDate < clock[0].today || !this.isValidDate(conditions.startDate)) {
        throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The requested period has started or is invalid. A valid future period must be reviewed before approval.');
      }

      const cursor = query.cursor ? this.decodeCandidateCursor(query.cursor, group.id) : undefined;
      const builder = this.dataSource.getRepository(ResourcePerson).createQueryBuilder('person')
        .where('person.active = TRUE AND person.group_id = :groupId', { groupId: group.id })
        .orderBy('person.display_name', 'ASC')
        .addOrderBy('person.id', 'ASC')
        .take(limit + 1);
      if (cursor) {
        builder.andWhere('(person.display_name, person.id) > (:displayName, :id)', {
          displayName: cursor.displayName,
          id: cursor.id,
        });
      }
      const found = await builder.getMany();
      const hasNext = found.length > limit;
      const items = found.slice(0, limit).map((person) => ({
        id: person.id,
        displayName: person.displayName,
        groupId: person.groupId,
      }));
      const lastItem = items[items.length - 1];
      return {
        items,
        page: {
          nextCursor: hasNext && lastItem ? this.encodeCandidateCursor({
            version: 1,
            groupId: group.id,
            displayName: lastItem.displayName,
            id: lastItem.id,
          }) : null,
          limit,
        },
      };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async approve(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: ApproveRequestDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const correlation = this.requireCorrelationId(correlationId);
    const key = this.requireIdempotencyKey(idempotencyKey);
    const personId = this.normalizeUuid(input.personId, 'personId');
    const resourceProfileId = input.resourceProfileId === undefined
      ? undefined
      : this.normalizeUuid(input.resourceProfileId, 'resourceProfileId');
    const explanation = input.explanation?.trim();
    if (explanation !== undefined && (!explanation || explanation.length > 2000)) {
      throw this.validationError('explanation must contain between 1 and 2,000 characters when supplied.');
    }
    this.ensureDatabaseAvailable();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const currentRequest = await this.lockCurrentRequest(manager, requestId);
        if (currentRequest.requesterId === actor.id) {
          throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'A person cannot approve their own request.');
        }
        this.requireCurrentRequestScope(actor, currentRequest);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.approve',
          key,
          payload: {
            requestId,
            ifMatch: expectedVersion,
            personId,
            ...(resourceProfileId ? { resourceProfileId } : {}),
            ...(explanation ? { explanation } : {}),
          },
        }, async () => this.approveLocked(manager, {
          requestId,
          expectedVersion,
          actor,
          personId,
          resourceProfileId,
          explanation,
          correlationId: correlation,
        }));
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  private async approveLocked(
    manager: EntityManager,
    input: {
      requestId: string;
      expectedVersion: number;
      actor: ResourcePerson;
      personId: string;
      resourceProfileId?: string;
      explanation?: string;
      correlationId: string;
    },
  ) {
    const request = await manager.getRepository(ResourceRequest).createQueryBuilder('request')
      .setLock('pessimistic_write')
      .where('request.id = :id AND request.removed_at IS NULL', { id: input.requestId })
      .getOne();
    if (!request) throw this.notFound('Request');
    if (request.version !== input.expectedVersion) {
      throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The request changed. Reload and review it before approving.');
    }
    if (request.requesterId === input.actor.id) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'A person cannot approve their own request.');
    }
    if (!['WAITING_FOR_PRESENTATION', 'PENDING_TEAM_DECISION'].includes(request.decisionState)) {
      throw new ResourceAllocationException('INVALID_REQUEST_TRANSITION', 'Request cannot be approved', 422, 'Only a request waiting for presentation or a group decision can be approved here.');
    }

    const requested = request.requestedConditions as unknown as ApprovalConditions;
    const groupId = this.normalizeUuid(requested.groupId, 'request group');
    const group = await manager.getRepository(ResourceGroup).createQueryBuilder('group')
      .setLock('pessimistic_write')
      .where('group.id = :id AND group.active = TRUE', { id: groupId })
      .getOne();
    if (!group) throw this.ineligibleReference();
    this.requireDeciderScope(input.actor, request, group.id);

    const selectedPerson = await manager.getRepository(ResourcePerson).createQueryBuilder('person')
      .setLock('pessimistic_write')
      .where('person.id = :id AND person.active = TRUE AND person.group_id = :groupId', {
        id: input.personId,
        groupId: group.id,
      })
      .getOne();
    if (!selectedPerson) throw this.ineligibleReference('Select an active person assigned to the request group.');

    const initiativeId = this.normalizeUuid(requested.initiativeId, 'request ITDM');
    const initiative = await manager.getRepository(ResourceInitiative).createQueryBuilder('initiative')
      .setLock('pessimistic_write')
      .where('initiative.id = :id AND initiative.active = TRUE', { id: initiativeId })
      .getOne();
    const selectedProfileId = input.resourceProfileId ?? this.normalizeUuid(requested.resourceProfileId, 'request profile');
    const profile = await manager.getRepository(ResourceProfile).createQueryBuilder('profile')
      .setLock('pessimistic_write')
      .where('profile.id = :id AND profile.active = TRUE AND profile.group_id = :groupId', {
        id: selectedProfileId,
        groupId: group.id,
      })
      .getOne();
    if (!initiative || !profile) throw this.ineligibleReference();
    if (selectedProfileId !== requested.resourceProfileId && !input.explanation) {
      throw this.validationError('An explanation is required when correcting the approved resource profile.');
    }

    // Read the deadline and business date after the request and all eligibility rows are locked.
    const clock = await manager.query(`
      WITH operation_clock AS (SELECT clock_timestamp() AS now)
      SELECT now, (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS today
      FROM operation_clock
    `) as Array<{ now: Date; today: string }>;
    const occurredAt = new Date(clock[0].now);
    if (request.decisionState === 'WAITING_FOR_PRESENTATION' && occurredAt.getTime() > request.expirationDueAt.getTime()) {
      throw new ResourceAllocationException('INVALID_REQUEST_TRANSITION', 'Request deadline passed', 422, 'This request is past its presentation deadline and cannot be approved.');
    }
    if (!this.isValidDate(requested.startDate) || !this.isValidDate(requested.endDate) ||
      requested.startDate < clock[0].today || requested.endDate < requested.startDate) {
      throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The requested period has started or is invalid. A valid future period must be reviewed before approval.');
    }
    const weeklyHours = Number(requested.weeklyHours);
    if (!Number.isFinite(weeklyHours) || weeklyHours <= 0 || weeklyHours > 40) throw this.ineligibleReference('The request hours are not valid for allocation.');

    const approvedConditions = {
      personId: selectedPerson.id,
      personName: selectedPerson.displayName,
      resourceProfileId: profile.id,
      resourceProfileName: profile.name,
      groupId: group.id,
      groupName: group.name,
      initiativeId: initiative.id,
      initiativeCode: initiative.code,
      initiativeName: initiative.name,
      startDate: requested.startDate,
      endDate: requested.endDate,
      weeklyHours,
      ...(input.explanation && profile.id !== requested.resourceProfileId ? { explanation: input.explanation } : {}),
    };

    const previousSnapshot = this.requestSnapshot(request);
    request.decisionState = 'APPROVED';
    request.approvedConditions = approvedConditions;
    request.stageEnteredAt = occurredAt;
    const savedRequest = await manager.getRepository(ResourceRequest).save(request);

    const initialState = requested.startDate === clock[0].today ? 'IN_PROGRESS' : 'NOT_STARTED';
    const allocationRepository = manager.getRepository(ResourceAllocation);
    const allocation = await allocationRepository.save(allocationRepository.create({
      sourceRequestId: request.id,
      personId: selectedPerson.id,
      personSnapshot: { personId: selectedPerson.id, displayName: selectedPerson.displayName, role: selectedPerson.role },
      groupId: group.id,
      groupSnapshot: { id: group.id, name: group.name },
      initiativeId: initiative.id,
      initiativeSnapshot: { id: initiative.id, code: initiative.code, name: initiative.name },
      resourceProfileId: profile.id,
      resourceProfileSnapshot: { id: profile.id, name: profile.name },
      approvedStartDate: requested.startDate,
      approvedEndDate: requested.endDate,
      effectiveStartDate: requested.startDate,
      effectiveEndDate: requested.endDate,
      weeklyHours: weeklyHours.toFixed(1),
      state: initialState,
      stateEnteredAt: occurredAt,
      approvedAt: occurredAt,
    }));

    const afterSnapshot = this.requestSnapshot(savedRequest);
    await manager.getRepository(ResourceRequestHistory).insert({
      requestId: request.id,
      actorSnapshot: this.actorSnapshot(input.actor),
      action: 'APPROVED',
      afterSnapshot: {
        requestId: request.id,
        before: previousSnapshot,
        after: afterSnapshot,
        requestedConditions: request.requestedConditions,
        approvedConditions,
        allocationId: allocation.id,
        ...(approvedConditions.explanation ? { explanation: approvedConditions.explanation } : {}),
      },
      correlationId: input.correlationId,
      occurredAt,
    });

    if (request.requesterId !== input.actor.id) {
      await manager.getRepository(ResourceAllocationNotification).insert({
        recipientId: request.requesterId,
        sourceRequestId: request.id,
        eventCode: `REQUEST_APPROVED_${savedRequest.version}`,
        title: 'Resource request approved',
        message: `Your request was approved for ${approvedConditions.startDate} to ${approvedConditions.endDate} at ${weeklyHours.toFixed(1)} weekly hours.`,
        createdAt: occurredAt,
      });
    }

    return {
      id: savedRequest.id,
      requester: savedRequest.requesterSnapshot,
      requestedConditions: savedRequest.requestedConditions,
      approvedConditions: savedRequest.approvedConditions,
      allocation: allocationResponse(allocation),
      decisionState: savedRequest.decisionState,
      receivedAt: savedRequest.receivedAt.toISOString(),
      stageEnteredAt: savedRequest.stageEnteredAt.toISOString(),
      version: savedRequest.version,
    };
  }

  private requireDeciderScope(actor: ResourcePerson, request: ResourceRequest, groupId: string): void {
    if (request.decisionState === 'WAITING_FOR_PRESENTATION') {
      if (actor.role === ResourceAllocationRole.Admin) return;
    } else {
      const canDecide = actor.role === ResourceAllocationRole.Admin
        ? actor.groupId === groupId
        : actor.role === ResourceAllocationRole.Moderator
          ? actor.groupId === groupId
          : actor.role === ResourceAllocationRole.Supervisor || actor.role === ResourceAllocationRole.Manager
            ? actor.coveredGroupIds.includes(groupId)
            : false;
      if (canDecide) return;
    }
    throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'The active profile is not authorized to approve this request in its current queue.');
  }

  private async lockCurrentRequest(manager: EntityManager, requestId: string): Promise<ResourceRequest> {
    const request = await manager.getRepository(ResourceRequest).createQueryBuilder('request')
      .setLock('pessimistic_write')
      .where('request.id = :id AND request.removed_at IS NULL', { id: requestId })
      .getOne();
    if (!request) throw this.notFound('Request');
    return request;
  }

  private requireCurrentRequestScope(actor: ResourcePerson, request: ResourceRequest): void {
    if (actor.role === ResourceAllocationRole.Admin) return;
    const groupId = (request.requestedConditions as Record<string, unknown>).groupId;
    const authorized = typeof groupId === 'string' && (
      actor.role === ResourceAllocationRole.Moderator
        ? actor.groupId === groupId
        : (actor.role === ResourceAllocationRole.Supervisor || actor.role === ResourceAllocationRole.Manager) && actor.coveredGroupIds.includes(groupId)
    );
    if (!authorized) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'The active profile no longer has access to this request group.');
    }
  }

  private requestSnapshot(request: ResourceRequest) {
    return {
      id: request.id,
      requesterId: request.requesterId,
      requesterSnapshot: request.requesterSnapshot,
      requestedConditions: request.requestedConditions,
      approvedConditions: request.approvedConditions,
      decisionState: request.decisionState,
      receivedAt: request.receivedAt.toISOString(),
      stageEnteredAt: request.stageEnteredAt.toISOString(),
      version: request.version,
    };
  }

  private async requireActivePerson(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
    const localAuthEnabled = process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'false' &&
      !(process.env.NODE_ENV === 'production' && process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'true');
    if (!localAuthEnabled) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Local access disabled', 503, 'Local simulated access is not enabled for this runtime.');
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before approving a request.');
    }
    const actor = await manager.getRepository(ResourcePerson).findOne({ where: { localUserId, active: true } });
    if (!actor) throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An active Tech Resource Allocation profile is required.');
    return actor;
  }

  private actorSnapshot(person: ResourcePerson) {
    return { personId: person.id, displayName: person.displayName, role: person.role };
  }

  private parseIfMatch(value: string | undefined): number {
    const match = value?.match(/^"([1-9][0-9]*)"$/);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw this.validationError('A single strong If-Match version is required.');
    return Number(match[1]);
  }

  private requireCorrelationId(value: string | undefined): string {
    if (!value || !uuidPattern.test(value)) throw this.validationError('A valid X-Correlation-ID is required.');
    return value.toLowerCase();
  }

  private normalizeUuid(value: string, field: string): string {
    if (!uuidPattern.test(value)) throw this.validationError(`${field} must be a UUID.`);
    return value.toLowerCase();
  }

  private requireIdempotencyKey(value: string | undefined): string {
    if (!value || !uuidPattern.test(value)) throw this.validationError('Idempotency-Key must be a UUID.');
    return value.toLowerCase();
  }

  private decodeCandidateCursor(value: string, groupId: string): ApprovalCandidateCursor {
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ApprovalCandidateCursor;
      if (cursor.version !== 1 || cursor.groupId !== groupId || typeof cursor.displayName !== 'string' ||
        !uuidPattern.test(cursor.id)) throw new Error('Invalid approval candidate cursor.');
      return cursor;
    } catch {
      throw this.validationError('cursor is invalid for this request’s approval candidates.');
    }
  }

  private encodeCandidateCursor(value: ApprovalCandidateCursor): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private isValidDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  private ineligibleReference(detail = 'The request must use an active person, group, ITDM, and profile that belong together.') {
    return new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, detail);
  }

  private notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }

  private ensureDatabaseAvailable(): void {
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is not configured or available.');
    }
  }

  private translateDatabaseError(error: unknown): never {
    if (error instanceof ResourceAllocationException) throw error;
    if (isDatabaseUnavailable(error)) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is unavailable or not prepared.', undefined, error);
    }
    throw new ResourceAllocationException('INTERNAL_ERROR', 'Internal Server Error', 500, 'Internal Server Error', undefined, error);
  }
}
