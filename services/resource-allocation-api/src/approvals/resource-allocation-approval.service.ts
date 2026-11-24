import { requestCategory } from '../allocations/allocation-category';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { parseStrongVersionIfMatch, parseUuidHeader } from '../access/request-headers';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { allocationResponse } from '../allocations/allocation-response';
import { createResourceAllocationForRequest } from '../allocations/create-resource-allocation-for-request';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceRequest } from '../requests/resource-request.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import { ResourceRequestDecisionState } from '../submissions/submission-category';
import { normalizeRequestedWeeklyHours } from '../requests/requested-weekly-hours';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/opaque-cursor';
import type { ApprovalCandidateQueryDto, ApproveRequestDto } from './approve-request.dto';
import { ResourceAllocationApprovalSupport } from './resource-allocation-approval-support';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ApprovalCandidateCursor {
  version: 1;
  groupId: string;
  displayName: string;
  id: string;
}

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

function authorizedDecisionStage(request: ResourceRequest, actor: ResourcePerson): 'WAITING_FOR_PRESENTATION' | 'PENDING_TEAM_DECISION' | null {
  if (request.decisionState === 'WAITING_FOR_PRESENTATION' || request.decisionState === 'PENDING_TEAM_DECISION') return request.decisionState;
  if (request.decisionState !== ResourceRequestDecisionState.RequiresRevalidation) return null;
  if (request.revalidationOriginState === 'WAITING_FOR_PRESENTATION' || request.revalidationOriginState === 'PENDING_TEAM_DECISION') {
    return actor.role === ResourceAllocationRole.Admin ? 'WAITING_FOR_PRESENTATION' : null;
  }
  if (request.revalidationOriginState === ResourceRequestDecisionState.ApprovedWithChanges) {
    return request.revalidationDecisionStage === 'WAITING_FOR_PRESENTATION' ? 'WAITING_FOR_PRESENTATION' : 'PENDING_TEAM_DECISION';
  }
  return null;
}

@Injectable()
export class ResourceAllocationApprovalService extends ResourceAllocationApprovalSupport {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE) dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED) databaseConfigured: boolean,
  ) {
    super(dataSource, databaseConfigured);
  }
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
      const exceptionResolution = ['PRE_N3', 'ESCALATION'].includes(request.decisionState);
      const effectiveState = authorizedDecisionStage(request, actor);
      if (!exceptionResolution && !effectiveState) {
        throw new ResourceAllocationException('INVALID_REQUEST_TRANSITION', 'Request cannot be approved', 422, 'This request is not waiting for an approval.');
      }
      if (exceptionResolution && actor.role !== ResourceAllocationRole.Admin) {
        throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only an active Admin may select a person for exception resolution.');
      }
      const conditions = request.requestedConditions as Record<string, unknown>;
      const groupId = this.normalizeUuid(String(conditions.groupId ?? ''), 'request group');
      const group = await this.dataSource.getRepository(ResourceGroup).findOne({ where: { id: groupId, active: true } });
      if (!group) throw this.ineligibleReference();
      if (!exceptionResolution) {
        this.requireDeciderScope(actor, { ...request, decisionState: effectiveState ?? request.decisionState }, group.id);
      }
      const clock = await this.dataSource.query(`
        WITH operation_clock AS (SELECT clock_timestamp() AS now)
        SELECT now, (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS today
        FROM operation_clock
      `) as Array<{ now: Date; today: string }>;
      if (request.decisionState === 'WAITING_FOR_PRESENTATION' && new Date(clock[0].now).getTime() > request.expirationDueAt.getTime()) {
        throw new ResourceAllocationException('INVALID_REQUEST_TRANSITION', 'Request deadline passed', 422, 'This request is past its presentation deadline and cannot be approved.');
      }
      if (!this.isValidDate(conditions.startDate) || !this.isValidDate(conditions.endDate) || conditions.endDate < conditions.startDate) {
        throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The requested period is invalid. The decision must propose a valid period.');
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
      throw translateResourceAllocationDatabaseError(error);
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
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
    const key = parseUuidHeader(idempotencyKey, 'Idempotency-Key');
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
            ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
            ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
            ...(input.weeklyHours !== undefined ? { weeklyHours: input.weeklyHours } : {}),
            ...(explanation ? { explanation } : {}),
          },
        }, async () => this.approveLocked(manager, {
          requestId,
          expectedVersion,
          actor,
          personId,
          resourceProfileId,
          startDate: input.startDate,
          endDate: input.endDate,
          weeklyHours: input.weeklyHours,
          explanation,
          correlationId: correlation,
        }));
      });
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
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
      startDate?: string;
      endDate?: string;
      weeklyHours?: number;
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
    const effectiveState = authorizedDecisionStage(request, input.actor);
    if (!effectiveState) {
      throw new ResourceAllocationException('INVALID_REQUEST_TRANSITION', 'Request cannot be approved', 422, 'Only a request waiting for presentation or a group decision can be approved here.');
    }

    const requested = request.requestedConditions as unknown as ApprovalConditions;
    const groupId = this.normalizeUuid(requested.groupId, 'request group');
    const group = await manager.getRepository(ResourceGroup).createQueryBuilder('group')
      .setLock('pessimistic_write')
      .where('group.id = :id AND group.active = TRUE', { id: groupId })
      .getOne();
    if (!group) throw this.ineligibleReference();
    this.requireDeciderScope(input.actor, { ...request, decisionState: effectiveState }, group.id);

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
      SELECT now,
        (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS today,
        now + INTERVAL '72 hours' AS response_due_at,
        ((now + INTERVAL '72 hours') AT TIME ZONE 'America/Sao_Paulo')::date::text AS response_due_business_date
      FROM operation_clock
    `) as Array<{ now: Date; today: string; response_due_at: Date; response_due_business_date: string }>;
    const occurredAt = new Date(clock[0].now);
    if (request.decisionState === 'WAITING_FOR_PRESENTATION' && occurredAt.getTime() > request.expirationDueAt.getTime()) {
      throw new ResourceAllocationException('INVALID_REQUEST_TRANSITION', 'Request deadline passed', 422, 'This request is past its presentation deadline and cannot be approved.');
    }
    const startDate = input.startDate ?? requested.startDate;
    const endDate = input.endDate ?? requested.endDate;
    const weeklyHours = input.weeklyHours === undefined
      ? Number(requested.weeklyHours)
      : normalizeRequestedWeeklyHours(input.weeklyHours);
    if (!this.isValidDate(startDate) || !this.isValidDate(endDate) || endDate < startDate) {
      throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The proposed period must be valid and the end date cannot precede the start date.');
    }
    if (!Number.isFinite(weeklyHours) || weeklyHours <= 0 || weeklyHours > 40) throw this.ineligibleReference('The request hours are not valid for allocation.');
    const datesOrHoursChanged = startDate !== requested.startDate || endDate !== requested.endDate || weeklyHours !== Number(requested.weeklyHours);
    if (datesOrHoursChanged && !input.explanation) {
      throw this.validationError('An explanation is required when changing the proposed dates or weekly hours.');
    }
    if (selectedProfileId !== requested.resourceProfileId && !input.explanation) {
      throw this.validationError('An explanation is required when correcting the approved resource profile.');
    }
    if (datesOrHoursChanged) {
      if (startDate < clock[0].response_due_business_date) {
        throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'A proposal awaiting acceptance must start on or after the local business date when its 72-hour response deadline expires.');
      }
    } else if (startDate < clock[0].today) {
      throw new ResourceAllocationException('INVALID_BUSINESS_DATE', 'Invalid business date', 422, 'The requested period has already started. Propose a future period so the requester can review it before allocation.');
    }

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
      startDate,
      endDate,
      weeklyHours,
      ...(datesOrHoursChanged ? { decidedByPersonId: input.actor.id } : {}),
      ...(input.explanation ? { explanation: input.explanation } : {}),
    };

    const previousSnapshot = this.requestSnapshot(request);
    const proposalDecisionStage = request.decisionState === ResourceRequestDecisionState.RequiresRevalidation
      ? request.revalidationOriginState === ResourceRequestDecisionState.ApprovedWithChanges
        ? request.revalidationDecisionStage ?? 'PENDING_TEAM_DECISION'
        : request.revalidationOriginState
      : request.decisionState;
    request.approvedConditions = approvedConditions;
    request.stageEnteredAt = occurredAt;
    request.revalidationOriginState = null;
    request.revalidationDecisionStage = datesOrHoursChanged ? proposalDecisionStage : null;
    request.decisionState = datesOrHoursChanged
      ? ResourceRequestDecisionState.ApprovedWithChanges
      : ResourceRequestDecisionState.Approved;
    request.decisionResponseDueAt = datesOrHoursChanged ? new Date(clock[0].response_due_at) : null;
    const savedRequest = await manager.getRepository(ResourceRequest).save(request);

    if (datesOrHoursChanged) {
      const afterSnapshot = this.requestSnapshot(savedRequest);
      await manager.getRepository(ResourceRequestHistory).insert({
        requestId: request.id,
        actorSnapshot: this.actorSnapshot(input.actor),
        action: 'APPROVAL_CHANGES_PROPOSED',
        afterSnapshot: {
          requestId: request.id,
          before: previousSnapshot,
          after: afterSnapshot,
          requestedConditions: request.requestedConditions,
          approvedConditions,
          dueAt: request.decisionResponseDueAt!.toISOString(),
          explanation: input.explanation,
        },
        correlationId: input.correlationId,
        occurredAt,
      });
      await manager.getRepository(ResourceAllocationNotification).insert({
        recipientId: request.requesterId,
        sourceRequestId: request.id,
        eventCode: `REQUEST_CHANGES_PROPOSED_${savedRequest.version}`,
        title: 'Resource request proposal needs your response',
        message: `The proposed period is ${startDate} to ${endDate} at ${weeklyHours.toFixed(1)} weekly hours. Respond before ${request.decisionResponseDueAt!.toISOString()}; the proposal will be automatically confirmed at the deadline if it remains eligible.`,
        createdAt: occurredAt,
      });
      return {
        id: savedRequest.id,
        requester: savedRequest.requesterSnapshot,
        requestedConditions: savedRequest.requestedConditions,
        approvedConditions: savedRequest.approvedConditions,
        allocation: null,
        decisionState: savedRequest.decisionState,
        confirmationSource: null,
        receivedAt: savedRequest.receivedAt.toISOString(),
        stageEnteredAt: savedRequest.stageEnteredAt.toISOString(),
        dueAt: savedRequest.decisionResponseDueAt!.toISOString(),
        version: savedRequest.version,
      };
    }

    const allocation = await createResourceAllocationForRequest(manager, {
      requestId: request.id,
      category: requestCategory(request.requestedConditions),
      person: selectedPerson,
      group,
      initiative,
      profile,
      startDate,
      endDate,
      weeklyHours,
      occurredAt,
      businessDate: clock[0].today,
    });

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
      confirmationSource: null,
      receivedAt: savedRequest.receivedAt.toISOString(),
      stageEnteredAt: savedRequest.stageEnteredAt.toISOString(),
      dueAt: null,
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

  private normalizeUuid(value: string, field: string): string {
    if (!uuidPattern.test(value)) throw this.validationError(`${field} must be a UUID.`);
    return value.toLowerCase();
  }

  private decodeCandidateCursor(value: string, groupId: string): ApprovalCandidateCursor {
    try {
      const cursor = decodeOpaqueCursor<ApprovalCandidateCursor>(value);
      if (cursor.version !== 1 || cursor.groupId !== groupId || typeof cursor.displayName !== 'string' ||
        !uuidPattern.test(cursor.id)) throw new Error('Invalid approval candidate cursor.');
      return cursor;
    } catch {
      throw this.validationError('cursor is invalid for this request’s approval candidates.');
    }
  }

  private encodeCandidateCursor(value: ApprovalCandidateCursor): string {
    return encodeOpaqueCursor(value);
  }

}
