import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { allocationResponse } from '../allocations/allocation-response';
import { createResourceAllocationForRequest } from '../allocations/create-resource-allocation-for-request';
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
import { ResourceRequestDecisionState } from '../submissions/submission-category';
import { normalizeRequestedWeeklyHours } from '../requests/requested-weekly-hours';
import type { ApprovalCandidateQueryDto, ApproveRequestDto } from './approve-request.dto';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      throw this.translateDatabaseError(error);
    }
  }

  async acceptChanges(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const correlation = this.requireCorrelationId(correlationId);
    const key = this.requireIdempotencyKey(idempotencyKey);
    this.ensureDatabaseAvailable();
    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireActivePerson(manager, localUserId);
        const currentRequest = await this.lockCurrentRequest(manager, requestId);
        if (currentRequest.requesterId !== actor.id) {
          throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only the requester may accept a changed proposal.');
        }
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.acceptChanges',
          key,
          payload: { requestId, ifMatch: expectedVersion },
        }, async () => {
          const request = await this.lockCurrentRequest(manager, requestId);
          if (request.version !== expectedVersion) {
            throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The request changed. Reload and review the proposal before accepting it.');
          }
          if (request.requesterId !== actor.id) {
            throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only the requester may accept a changed proposal.');
          }
          if (request.decisionState !== ResourceRequestDecisionState.ApprovedWithChanges || !request.decisionResponseDueAt) {
            throw new ResourceAllocationException('INVALID_REQUEST_TRANSITION', 'Request cannot be accepted', 422, 'This request has no proposal waiting for acceptance.');
          }
          const clock = await this.readOperationClock(manager);
          const automatic = clock.now.getTime() >= request.decisionResponseDueAt.getTime();
          return this.confirmChangedProposal(manager, request, {
            actorSnapshot: automatic ? this.systemActorSnapshot() : this.actorSnapshot(actor),
            action: automatic ? 'AUTO_ACCEPTED_CHANGES' : 'CHANGES_ACCEPTED',
            correlationId: correlation,
            occurredAt: clock.now,
            businessDate: clock.today,
            automatic,
          });
        });
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  /** Runs the durable 48-hour reminder and 72-hour proposal deadline job. */
  async processProposalDeadlineBatch(limit = 100): Promise<number> {
    this.ensureDatabaseAvailable();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('The proposal deadline worker batch limit must be between 1 and 100.');
    const candidates = await this.dataSource.query(`
      SELECT request.id
      FROM resource_requests AS request
      WHERE request.decision_state = $1
        AND request.removed_at IS NULL
        AND request.decision_response_due_at IS NOT NULL
        AND (
          request.decision_response_due_at <= clock_timestamp()
          OR (
            request.decision_response_due_at <= clock_timestamp() + INTERVAL '24 hours'
            AND NOT EXISTS (
              SELECT 1 FROM resource_allocation_notifications AS notice
              WHERE notice.source_request_id = request.id
                AND notice.event_code = 'REQUEST_CHANGES_REMINDER_48H_' || request.version::text
            )
          )
        )
      ORDER BY request.decision_response_due_at ASC, request.id ASC
      LIMIT $2
    `, [ResourceRequestDecisionState.ApprovedWithChanges, limit]) as Array<{ id: string }>;
    let processed = 0;
    for (const { id } of candidates) {
      if (await this.processProposalDeadline(id)) processed += 1;
    }
    return processed;
  }

  private async processProposalDeadline(requestId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      await lockResourceAllocationAdministrationWrites(manager);
      const request = await manager.getRepository(ResourceRequest).createQueryBuilder('request')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('request.id = :id AND request.decision_state = :state AND request.removed_at IS NULL', {
          id: requestId,
          state: ResourceRequestDecisionState.ApprovedWithChanges,
        })
        .getOne();
      if (!request?.decisionResponseDueAt) return false;
      const clock = await this.readOperationClock(manager);
      if (clock.now.getTime() >= request.decisionResponseDueAt.getTime()) {
        await this.confirmChangedProposal(manager, request, {
          actorSnapshot: this.systemActorSnapshot(),
          action: 'AUTO_ACCEPTED_CHANGES',
          correlationId: randomUUID(),
          occurredAt: clock.now,
          businessDate: clock.today,
          automatic: true,
        });
        return true;
      }
      const reminderDueAt = request.decisionResponseDueAt.getTime() - 24 * 60 * 60 * 1000;
      if (clock.now.getTime() < reminderDueAt) return false;
      const eventCode = `REQUEST_CHANGES_REMINDER_48H_${request.version}`;
      const existing = await manager.getRepository(ResourceAllocationNotification).findOne({
        where: { sourceRequestId: request.id, eventCode },
      });
      if (existing) return false;
      await manager.getRepository(ResourceAllocationNotification).insert({
        recipientId: request.requesterId,
        sourceRequestId: request.id,
        eventCode,
        title: 'Resource request proposal reminder',
        message: `A response is due by ${request.decisionResponseDueAt.toISOString()}. The proposal will be automatically confirmed at that time if it remains eligible.`,
        createdAt: clock.now,
      });
      return true;
    });
  }

  private async confirmChangedProposal(
    manager: EntityManager,
    request: ResourceRequest,
    input: {
      actorSnapshot: Record<string, unknown>;
      action: 'CHANGES_ACCEPTED' | 'AUTO_ACCEPTED_CHANGES';
      correlationId: string;
      occurredAt: Date;
      businessDate: string;
      automatic: boolean;
    },
  ) {
    const approved = request.approvedConditions as Record<string, unknown> | null;
    if (!approved) return this.requireRevalidation(manager, request, input, ['PROPOSAL_MISSING']);
    const groupId = this.uuidCondition(approved.groupId);
    const personId = this.uuidCondition(approved.personId);
    const initiativeId = this.uuidCondition(approved.initiativeId);
    const profileId = this.uuidCondition(approved.resourceProfileId);
    if (!groupId || !personId || !initiativeId || !profileId) {
      return this.requireRevalidation(manager, request, input, ['PROPOSAL_REFERENCES_INVALID']);
    }
    const group = await manager.getRepository(ResourceGroup).createQueryBuilder('group')
      .setLock('pessimistic_write').where('group.id = :id', { id: groupId }).getOne();
    const person = await manager.getRepository(ResourcePerson).createQueryBuilder('person')
      .setLock('pessimistic_write').where('person.id = :id', { id: personId }).getOne();
    const initiative = await manager.getRepository(ResourceInitiative).createQueryBuilder('initiative')
      .setLock('pessimistic_write').where('initiative.id = :id', { id: initiativeId }).getOne();
    const profile = await manager.getRepository(ResourceProfile).createQueryBuilder('profile')
      .setLock('pessimistic_write').where('profile.id = :id', { id: profileId }).getOne();
    const impediments: string[] = [];
    if (!group?.active) impediments.push('GROUP_INACTIVE');
    if (!person?.active) impediments.push('PERSON_INACTIVE');
    else if (person.groupId !== groupId) impediments.push('PERSON_LEFT_GROUP');
    if (!initiative?.active) impediments.push('INITIATIVE_INACTIVE');
    if (!profile?.active) impediments.push('PROFILE_INACTIVE');
    else if (profile.groupId !== groupId) impediments.push('PROFILE_GROUP_MISMATCH');
    const startDate = typeof approved.startDate === 'string' ? approved.startDate : '';
    const endDate = typeof approved.endDate === 'string' ? approved.endDate : '';
    const weeklyHours = Number(approved.weeklyHours);
    if (!this.isValidDate(startDate) || !this.isValidDate(endDate) || endDate < startDate) impediments.push('PROPOSAL_PERIOD_INVALID');
    if (this.isValidDate(startDate) && startDate < input.businessDate) impediments.push('PROPOSED_START_DATE_PASSED');
    if (!Number.isFinite(weeklyHours) || weeklyHours <= 0 || weeklyHours > 40) impediments.push('PROPOSAL_HOURS_INVALID');
    if (impediments.length > 0) return this.requireRevalidation(manager, request, input, impediments);

    const before = this.requestSnapshot(request);
    request.decisionState = ResourceRequestDecisionState.Approved;
    request.revalidationOriginState = null;
    request.revalidationDecisionStage = null;
    request.stageEnteredAt = input.occurredAt;
    request.decisionResponseDueAt = null;
    const saved = await manager.getRepository(ResourceRequest).save(request);
    const allocation = await createResourceAllocationForRequest(manager, {
      requestId: request.id,
      person: person!,
      group: group!,
      initiative: initiative!,
      profile: profile!,
      startDate,
      endDate,
      weeklyHours,
      occurredAt: input.occurredAt,
      businessDate: input.businessDate,
    });
    await manager.getRepository(ResourceRequestHistory).insert({
      requestId: request.id,
        actorSnapshot: input.actorSnapshot as never,
      action: input.action,
      afterSnapshot: {
        requestId: request.id,
        before,
        after: this.requestSnapshot(saved),
        requestedConditions: saved.requestedConditions,
        approvedConditions: saved.approvedConditions,
        allocationId: allocation.id,
        ...(input.automatic ? { automatic: true } : {}),
      } as never,
      correlationId: input.correlationId,
      occurredAt: input.occurredAt,
    });
    await manager.getRepository(ResourceAllocationNotification).insert({
      recipientId: request.requesterId,
      sourceRequestId: request.id,
      eventCode: `REQUEST_CHANGES_${input.automatic ? 'AUTO_ACCEPTED' : 'ACCEPTED'}_${saved.version}`,
      title: input.automatic ? 'Resource request proposal automatically confirmed' : 'Resource request proposal accepted',
      message: `The confirmed allocation is ${startDate} to ${endDate} at ${weeklyHours.toFixed(1)} weekly hours.`,
      createdAt: input.occurredAt,
    });
    return this.changedProposalResponse(saved, allocationResponse(allocation), input.automatic ? 'SYSTEM_DEADLINE' : 'REQUESTER_ACCEPTANCE');
  }

  private async requireRevalidation(
    manager: EntityManager,
    request: ResourceRequest,
    input: { actorSnapshot: Record<string, unknown>; correlationId: string; occurredAt: Date },
    impediments: string[],
  ) {
    const before = this.requestSnapshot(request);
    request.decisionState = ResourceRequestDecisionState.RequiresRevalidation;
    request.revalidationOriginState = ResourceRequestDecisionState.ApprovedWithChanges;
    request.stageEnteredAt = input.occurredAt;
    request.decisionResponseDueAt = null;
    const saved = await manager.getRepository(ResourceRequest).save(request);
    const after = this.requestSnapshot(saved);
    await manager.getRepository(ResourceRequestHistory).insert({
      requestId: request.id,
      actorSnapshot: input.actorSnapshot as never,
      action: 'PROPOSAL_REQUIRES_REVALIDATION',
      afterSnapshot: { requestId: request.id, before, after, impediments, previousProposal: request.approvedConditions } as never,
      correlationId: input.correlationId,
      occurredAt: input.occurredAt,
    });
    const admins = await manager.getRepository(ResourcePerson).find({
      where: { role: ResourceAllocationRole.Admin, active: true },
      select: { id: true },
      order: { id: 'ASC' },
    });
    const requestedGroupId = this.uuidCondition((request.requestedConditions as Record<string, unknown>).groupId);
    const leaders = requestedGroupId
      ? await manager.query(`
          SELECT DISTINCT person.id
          FROM resource_people AS person
          LEFT JOIN resource_groups AS request_group ON request_group.id = $1::uuid
          WHERE person.active = TRUE
            AND (
              (person.role = $2 AND person.group_id = $1::uuid)
              OR person.id = request_group.supervisor_id
              OR person.id = request_group.manager_id
            )
        `, [requestedGroupId, ResourceAllocationRole.Moderator]) as Array<{ id: string }>
      : [];
    const recipients = new Set([
      request.requesterId,
      ...admins.map((admin) => admin.id),
      ...leaders.map((leader) => leader.id),
    ]);
    const eventCode = `REQUEST_REVALIDATION_REQUIRED_${saved.version}`;
    await manager.getRepository(ResourceAllocationNotification).insert([...recipients].map((recipientId) => ({
      recipientId,
      sourceRequestId: request.id,
      eventCode,
      title: 'Resource request needs revalidation',
      message: 'The proposed assignee or request references are no longer eligible. The proposal was not allocated and must be reviewed again.',
      createdAt: input.occurredAt,
    })));
    return this.changedProposalResponse(saved, null, null);
  }

  private changedProposalResponse(
    request: ResourceRequest,
    allocation: ReturnType<typeof allocationResponse> | null,
    confirmationSource: 'REQUESTER_ACCEPTANCE' | 'SYSTEM_DEADLINE' | null,
  ) {
    return {
      id: request.id,
      requester: request.requesterSnapshot,
      requestedConditions: request.requestedConditions,
      approvedConditions: request.approvedConditions,
      allocation,
      decisionState: request.decisionState,
      confirmationSource,
      receivedAt: request.receivedAt.toISOString(),
      stageEnteredAt: request.stageEnteredAt.toISOString(),
      dueAt: request.decisionResponseDueAt?.toISOString() ?? null,
      version: request.version,
    };
  }

  private async readOperationClock(manager: EntityManager): Promise<{ now: Date; today: string }> {
    const rows = await manager.query(`
      WITH operation_clock AS (SELECT clock_timestamp() AS now)
      SELECT now, (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS today
      FROM operation_clock
    `) as Array<{ now: Date; today: string }>;
    return { now: new Date(rows[0].now), today: rows[0].today };
  }

  private uuidCondition(value: unknown): string | undefined {
    return typeof value === 'string' && uuidPattern.test(value) ? value.toLowerCase() : undefined;
  }

  private systemActorSnapshot(): Record<string, unknown> {
    return {
      personId: '00000000-0000-4000-8000-000000000000',
      displayName: 'Resource Allocation decision worker',
      role: 'SYSTEM',
    };
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
      revalidationOriginState: request.revalidationOriginState,
      revalidationDecisionStage: request.revalidationDecisionStage,
      receivedAt: request.receivedAt.toISOString(),
      stageEnteredAt: request.stageEnteredAt.toISOString(),
      decisionResponseDueAt: request.decisionResponseDueAt?.toISOString() ?? null,
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
