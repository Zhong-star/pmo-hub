import { requestCategory } from '../allocations/allocation-category';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { allocationResponse } from '../allocations/allocation-response';
import { createResourceAllocationForRequest } from '../allocations/create-resource-allocation-for-request';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { parseStrongVersionIfMatch, parseUuidHeader } from '../access/request-headers';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceRequest } from '../requests/resource-request.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import { ResourceRequestDecisionState } from '../submissions/submission-category';
import { ResourceAllocationApprovalSupport } from './resource-allocation-approval-support';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ResourceAllocationProposalResponseService extends ResourceAllocationApprovalSupport {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE) dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED) databaseConfigured: boolean,
  ) {
    super(dataSource, databaseConfigured);
  }
  async acceptChanges(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
  ) {
    const expectedVersion = parseStrongVersionIfMatch(ifMatch);
    const correlation = parseUuidHeader(correlationId, 'X-Correlation-ID');
    const key = parseUuidHeader(idempotencyKey, 'Idempotency-Key');
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
      throw translateResourceAllocationDatabaseError(error);
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
      category: requestCategory(request.requestedConditions),
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
    const deciderId = this.uuidCondition(approved.decidedByPersonId)
      ?? await this.findProposalDeciderId(manager, request.id);
    const candidateRecipients = input.automatic
      ? [request.requesterId, person!.id, ...(deciderId ? [deciderId] : [])]
      : [person!.id, ...(deciderId ? [deciderId] : [])].filter((recipientId) => recipientId !== request.requesterId);
    const recipientIds = [...new Set(candidateRecipients)];
    if (recipientIds.length > 0) {
      const eventCode = `REQUEST_CHANGES_${input.automatic ? 'AUTO_ACCEPTED' : 'ACCEPTED'}_${saved.version}`;
      const title = input.automatic ? 'Resource request proposal automatically confirmed' : 'Resource request proposal accepted';
      const message = `The confirmed allocation is ${startDate} to ${endDate} at ${weeklyHours.toFixed(1)} weekly hours.`;
      await manager.getRepository(ResourceAllocationNotification)
        .createQueryBuilder()
        .insert()
        .into(ResourceAllocationNotification)
        .values(recipientIds.map((recipientId) => ({
          recipientId,
          sourceRequestId: request.id,
          eventCode,
          title,
          message,
          createdAt: input.occurredAt,
        })))
        .orIgnore()
        .execute();
    }
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
    const recipients = new Set([request.requesterId, ...admins.map((admin) => admin.id), ...leaders.map((leader) => leader.id)]);
    await manager.getRepository(ResourceAllocationNotification).insert([...recipients].map((recipientId) => ({
      recipientId,
      sourceRequestId: request.id,
      eventCode: `REQUEST_REVALIDATION_REQUIRED_${saved.version}`,
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

  private async findProposalDeciderId(manager: EntityManager, requestId: string): Promise<string | undefined> {
    const latestProposal = await manager.getRepository(ResourceRequestHistory).findOne({
      where: { requestId, action: 'APPROVAL_CHANGES_PROPOSED' },
      order: { occurredAt: 'DESC', id: 'DESC' },
    });
    return this.uuidCondition(latestProposal?.actorSnapshot?.personId);
  }

  private systemActorSnapshot(): Record<string, unknown> {
    return {
      personId: '00000000-0000-4000-8000-000000000000',
      displayName: 'Resource Allocation decision worker',
      role: 'SYSTEM',
    };
  }

}
