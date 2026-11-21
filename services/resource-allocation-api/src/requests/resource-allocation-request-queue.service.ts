import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { isDatabaseUnavailable } from '../database/database-errors';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { markInitiativeUsedForRequest } from '../initiatives/mark-initiative-used';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { ResourceRequest } from './resource-request.entity';
import { ResourceRequestHistory } from './resource-request-history.entity';
import { removeResourceRequest } from './remove-resource-request';
import { runIdempotentOperation } from '../administration/idempotency/run-idempotent-operation';
import type {
  AdministrativeRequestRemovalDto,
  CorrectRequestReferencesDto,
  ReferRequestDto,
} from './request-queue.dto';

const defaultPageSize = 50;
const maximumPageSize = 100;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RequestQueueCode = 'presentation' | 'team-decision' | 'exceptions' | 'revalidation';

interface QueueFilters {
  limit?: string;
  cursor?: string;
  groupId?: string;
  initiativeId?: string;
  resourceProfileId?: string;
  decisionState?: string;
}

interface QueueCursor {
  version: 1;
  queue: RequestQueueCode;
  filterHash: string;
  dueAt: string | null;
  stageEnteredAt: string;
  id: string;
}

interface QueueRow {
  id: string;
  requester_id: string;
  requester_snapshot: Record<string, unknown>;
  requested_conditions: Record<string, unknown>;
  approved_conditions: Record<string, unknown> | null;
  resolution_strategy: string | null;
  resolution_reason: string | null;
  affected_initiative_ids: string[] | null;
  exception_impediments: string[] | null;
  decision_state: string;
  revalidation_origin_state: string | null;
  revalidation_decision_stage: string | null;
  received_at: Date;
  stage_entered_at: Date;
  due_at: Date | null;
  deadline_passed: boolean;
  next_responsible: Array<{ personId: string; displayName: string; role: string }>;
  version: number;
}

interface RequestSnapshot extends Record<string, unknown> {
  id: string;
  requesterId: string;
  requesterSnapshot: Record<string, unknown>;
  requestedConditions: Record<string, unknown>;
  approvedConditions: Record<string, unknown> | null;
  decisionState: string;
  receivedAt: Date;
  stageEnteredAt: Date;
  expirationDueAt: Date;
  removedAt: Date | null;
  version: number;
}

@Injectable()
export class ResourceAllocationRequestQueueService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED)
    private readonly databaseConfigured: boolean,
  ) {}

  async listQueue(localUserId: string | undefined, queueValue: string, filters: QueueFilters) {
    this.ensureDatabaseAvailable();
    const queue = this.parseQueueCode(queueValue);
    const pageSize = this.parsePageSize(filters.limit);
    const normalizedFilters = this.normalizeFilters(filters);

    try {
      const actor = await this.requireActivePerson(this.dataSource.manager, localUserId);
      const scope = await this.authorizeQueue(actor, queue, normalizedFilters.groupId);
      const filterHash = this.hashPayload({ queue, filters: normalizedFilters, groupIds: scope.groupIds });
      const cursor = filters.cursor ? this.decodeCursor(filters.cursor, queue, filterHash) : undefined;
      const decisionStates = Array.isArray(scope.decisionState) ? scope.decisionState : [scope.decisionState];
      const conditions = ['r.removed_at IS NULL', 'r.decision_state = ANY($1::text[])'];
      const parameters: unknown[] = [decisionStates];
      const bind = (value: unknown) => {
        parameters.push(value);
        return `$${parameters.length}`;
      };

      if (scope.groupIds !== null) {
        if (scope.groupIds.length === 0) conditions.push('FALSE');
        else conditions.push(`r.requested_conditions->>'groupId' = ANY(${bind(scope.groupIds)}::text[])`);
      }
      if ('revalidationOriginStates' in scope && scope.revalidationOriginStates) {
        conditions.push(`r.revalidation_origin_state = ANY(${bind(scope.revalidationOriginStates)}::text[])`);
      }
      if ('revalidationDecisionStages' in scope && scope.revalidationDecisionStages) {
        conditions.push(`r.revalidation_decision_stage = ANY(${bind(scope.revalidationDecisionStages)}::text[])`);
      }
      if (normalizedFilters.groupId) conditions.push(`r.requested_conditions->>'groupId' = ${bind(normalizedFilters.groupId)}`);
      if (normalizedFilters.initiativeId) conditions.push(`r.requested_conditions->>'initiativeId' = ${bind(normalizedFilters.initiativeId)}`);
      if (normalizedFilters.resourceProfileId) conditions.push(`r.requested_conditions->>'resourceProfileId' = ${bind(normalizedFilters.resourceProfileId)}`);
      if (normalizedFilters.decisionState) conditions.push(`r.decision_state = ${bind(normalizedFilters.decisionState)}`);
      if (queue === 'team-decision' || (queue === 'revalidation' && actor.role !== ResourceAllocationRole.Admin)) conditions.push('g.active = TRUE');

      if (cursor) {
        if (queue === 'presentation') {
          conditions.push(`(r.expiration_due_at, r.stage_entered_at, r.id) > (${bind(cursor.dueAt)}::timestamptz, ${bind(cursor.stageEnteredAt)}::timestamptz, ${bind(cursor.id)}::uuid)`);
        } else {
          conditions.push(`(r.stage_entered_at, r.id) > (${bind(cursor.stageEnteredAt)}::timestamptz, ${bind(cursor.id)}::uuid)`);
        }
      }

      const limitParameter = bind(pageSize + 1);
      const rows = await this.dataSource.query(
        `SELECT r.id, r.requester_id, r.requester_snapshot, r.requested_conditions, r.approved_conditions, r.decision_state,
                r.revalidation_origin_state, r.revalidation_decision_stage,
                r.received_at, r.stage_entered_at,
                CASE WHEN r.decision_state = 'WAITING_FOR_PRESENTATION' THEN r.expiration_due_at ELSE NULL END AS due_at,
                (
                  SELECT history.after_snapshot->>'resolutionStrategy'
                  FROM resource_request_history AS history
                  WHERE history.request_id = r.id AND history.action = 'STRATEGY_RECORDED'
                  ORDER BY history.occurred_at DESC, history.id DESC
                  LIMIT 1
                ) AS resolution_strategy,
                (
                  SELECT history.after_snapshot->>'reason'
                  FROM resource_request_history AS history
                  WHERE history.request_id = r.id AND history.action = 'STRATEGY_RECORDED'
                  ORDER BY history.occurred_at DESC, history.id DESC
                  LIMIT 1
                ) AS resolution_reason,
                (
                  SELECT history.after_snapshot->'affectedInitiativeIds'
                  FROM resource_request_history AS history
                  WHERE history.request_id = r.id AND history.action = 'STRATEGY_RECORDED'
                  ORDER BY history.occurred_at DESC, history.id DESC
                  LIMIT 1
                ) AS affected_initiative_ids,
                ARRAY_REMOVE(ARRAY[
                  CASE WHEN r.decision_state IN ('PRE_N3', 'ESCALATION') AND (g.id IS NULL OR g.active = FALSE) THEN 'GROUP_INACTIVE' END,
                  CASE WHEN r.decision_state IN ('PRE_N3', 'ESCALATION') AND i.active IS DISTINCT FROM TRUE THEN 'INITIATIVE_INACTIVE' END,
                  CASE WHEN r.decision_state IN ('PRE_N3', 'ESCALATION') AND p.active IS DISTINCT FROM TRUE THEN 'PROFILE_INACTIVE' END,
                  CASE WHEN r.decision_state IN ('PRE_N3', 'ESCALATION') AND p.active = TRUE AND p.group_id::text <> r.requested_conditions->>'groupId' THEN 'PROFILE_GROUP_MISMATCH' END,
                  CASE WHEN r.decision_state IN ('PRE_N3', 'ESCALATION') AND r.approved_conditions ? 'personId' AND person.active IS DISTINCT FROM TRUE THEN 'PERSON_INACTIVE' END,
                  CASE WHEN r.decision_state IN ('PRE_N3', 'ESCALATION') AND person.active = TRUE AND person.group_id::text <> r.requested_conditions->>'groupId' THEN 'PERSON_LEFT_GROUP' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND (g.id IS NULL OR g.active = FALSE) THEN 'GROUP_INACTIVE' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND i.active IS DISTINCT FROM TRUE THEN 'INITIATIVE_INACTIVE' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND p.active IS DISTINCT FROM TRUE THEN 'PROFILE_INACTIVE' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND p.active = TRUE AND p.group_id::text <> r.requested_conditions->>'groupId' THEN 'PROFILE_GROUP_MISMATCH' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND r.revalidation_origin_state = 'APPROVED_WITH_CHANGES' AND person.active IS DISTINCT FROM TRUE THEN 'PERSON_INACTIVE' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND r.revalidation_origin_state = 'APPROVED_WITH_CHANGES' AND person.active = TRUE AND person.group_id::text <> r.requested_conditions->>'groupId' THEN 'PERSON_LEFT_GROUP' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND r.revalidation_origin_state = 'APPROVED_WITH_CHANGES' AND (r.approved_conditions->>'startDate') < (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text THEN 'PROPOSED_START_DATE_PASSED' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND r.revalidation_origin_state = 'APPROVED_WITH_CHANGES' AND (r.approved_conditions->>'endDate') < (r.approved_conditions->>'startDate') THEN 'PROPOSAL_PERIOD_INVALID' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND r.revalidation_origin_state = 'APPROVED_WITH_CHANGES' AND ((r.approved_conditions->>'weeklyHours')::numeric <= 0 OR (r.approved_conditions->>'weeklyHours')::numeric > 40) THEN 'PROPOSAL_HOURS_INVALID' END
                ], NULL::text) AS exception_impediments,
                (r.decision_state = 'WAITING_FOR_PRESENTATION' AND r.expiration_due_at < clock_timestamp()) AS deadline_passed,
                r.version,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'personId', leader.id,
                    'displayName', leader.display_name,
                    'role', leader.role
                  ) ORDER BY leader.display_name, leader.id)
                  FROM resource_people AS leader
                  WHERE leader.active = TRUE AND (
                    leader.id <> r.requester_id AND ((leader.role = 'ALLOCATION_MODERATOR' AND leader.group_id = g.id)
                    OR (leader.role = 'ALLOCATION_ADMIN' AND leader.group_id = g.id)
                    OR leader.id = g.supervisor_id
                    OR leader.id = g.manager_id)
                  )
                ), '[]'::jsonb) AS next_responsible
         FROM resource_requests AS r
         LEFT JOIN resource_groups AS g ON g.id::text = r.requested_conditions->>'groupId'
         LEFT JOIN resource_initiatives AS i ON i.id::text = r.requested_conditions->>'initiativeId'
         LEFT JOIN resource_profiles AS p ON p.id::text = COALESCE(r.approved_conditions->>'resourceProfileId', r.requested_conditions->>'resourceProfileId')
         LEFT JOIN resource_people AS person ON person.id::text = r.approved_conditions->>'personId'
         WHERE ${conditions.join(' AND ')}
         ORDER BY CASE WHEN r.decision_state = 'WAITING_FOR_PRESENTATION' THEN 0 ELSE 1 END ASC,
                  CASE WHEN r.decision_state = 'WAITING_FOR_PRESENTATION' THEN r.expiration_due_at END ASC NULLS LAST,
                  r.stage_entered_at ASC,
                  r.id ASC
         LIMIT ${limitParameter}`,
        parameters,
      ) as QueueRow[];

      const hasNext = rows.length > pageSize;
      const selected = rows.slice(0, pageSize);
      const last = selected[selected.length - 1];
      const nextCursor = hasNext && last ? this.encodeCursor({
        version: 1,
        queue,
        filterHash,
        dueAt: last.due_at ? new Date(last.due_at).toISOString() : null,
        stageEnteredAt: new Date(last.stage_entered_at).toISOString(),
        id: last.id,
      }) : null;

      return {
        items: selected.map((row) => this.toQueueItem(row, queue, actor)),
        page: { nextCursor, limit: pageSize },
      };
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async refer(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    _input: ReferRequestDto,
  ) {
    // The request body is intentionally empty; the controller rejects unknown fields.
    void _input;
    const expectedVersion = this.parseIfMatch(ifMatch);
    const correlation = this.requireCorrelationId(correlationId);
    this.ensureDatabaseAvailable();
    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireAdmin(manager, localUserId);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.refer',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion },
        }, async () => {
          const request = await this.lockRequest(manager, requestId);
          this.requireVersion(request, expectedVersion);
          this.requireState(request, ['WAITING_FOR_PRESENTATION', 'REQUIRES_REVALIDATION'], 'Only a request waiting for presentation or revalidation can be referred.');
          if (request.decisionState === 'WAITING_FOR_PRESENTATION') await this.requireCurrentWaitingDeadline(manager, request);
          if (request.decisionState === 'REQUIRES_REVALIDATION' && !['WAITING_FOR_PRESENTATION', 'PENDING_TEAM_DECISION'].includes(request.revalidationOriginState ?? '')) {
            throw new ResourceAllocationException('INVALID_STATE_TRANSITION', 'Request cannot be referred', 422, 'Only a request originally waiting for presentation or team decision can be referred.');
          }
          const { group } = await this.requireActiveReferences(manager, request.requestedConditions);
          const occurredAt = await this.currentTimestamp(manager);
          const before = this.snapshot(request);
          request.decisionState = 'PENDING_TEAM_DECISION';
          request.revalidationOriginState = null;
          request.revalidationDecisionStage = null;
          request.stageEnteredAt = occurredAt;
          const saved = await manager.getRepository(ResourceRequest).save(request);
          await this.recordHistory(manager, saved, actor, 'REFERRED', before, this.snapshot(saved), correlation, occurredAt);
          await this.notifyGroupLeaders(manager, group, saved, actor, occurredAt);
          return this.toRequestResponse(saved);
        });
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async correctReferences(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: CorrectRequestReferencesDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const correction = this.normalizeReferenceCorrection(input);
    const correlation = this.requireCorrelationId(correlationId);
    this.ensureDatabaseAvailable();
    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireAdmin(manager, localUserId);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.correctReferences',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, correction },
        }, async () => {
          const request = await this.lockRequest(manager, requestId);
          this.requireVersion(request, expectedVersion);
          this.requireState(request, ['WAITING_FOR_PRESENTATION', 'REQUIRES_REVALIDATION', 'PRE_N3', 'ESCALATION'], 'References can only be corrected while a request waits for presentation, revalidation, or exception resolution.');
          if (request.decisionState === 'WAITING_FOR_PRESENTATION') await this.requireCurrentWaitingDeadline(manager, request);
          if (correction.personId && !['PRE_N3', 'ESCALATION'].includes(request.decisionState)) {
            throw new ResourceAllocationException('INVALID_STATE_TRANSITION', 'Person cannot be corrected', 422, 'A person may be corrected directly only during Pre N3 or Escalation resolution.');
          }
          const before = this.snapshot(request);
          const prior = request.requestedConditions;
          const { personId, ...referenceCorrection } = correction;
          const next = this.applyReferenceCorrection(prior, referenceCorrection);
          const references = await this.requireActiveReferences(manager, next);
          const correctedPerson = personId
            ? await manager.getRepository(ResourcePerson).findOne({ where: { id: personId, active: true, groupId: references.group.id } })
            : null;
          if (personId && !correctedPerson) {
            throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'Select an active person assigned to the corrected request group.');
          }
          if (correction.initiativeId) {
            next.initiativeId = references.initiative.id;
            next.initiativeCode = references.initiative.code;
            next.initiativeName = references.initiative.name;
          }
          if (correction.groupId) {
            next.groupId = references.group.id;
            next.groupName = references.group.name;
          }
          if (correction.resourceProfileId) {
            next.resourceProfileId = references.profile.id;
            next.resourceProfileName = references.profile.name;
          }
          if (correction.initiativeId && correction.initiativeId !== this.readUuid(prior.initiativeId)) {
            await markInitiativeUsedForRequest(manager, references.initiative.id);
          }
          request.requestedConditions = next;
          if (request.approvedConditions || correctedPerson) {
            const approved = this.applyReferenceCorrection(request.approvedConditions ?? next, referenceCorrection);
            if (correction.initiativeId) {
              approved.initiativeId = references.initiative.id;
              approved.initiativeCode = references.initiative.code;
              approved.initiativeName = references.initiative.name;
            }
            if (correction.groupId) {
              approved.groupId = references.group.id;
              approved.groupName = references.group.name;
            }
            if (correction.resourceProfileId) {
              approved.resourceProfileId = references.profile.id;
              approved.resourceProfileName = references.profile.name;
            }
            if (correctedPerson) {
              approved.personId = correctedPerson.id;
              approved.personName = correctedPerson.displayName;
            }
            request.approvedConditions = approved;
          }
          const occurredAt = await this.currentTimestamp(manager);
          const saved = await manager.getRepository(ResourceRequest).save(request);
          await this.recordHistory(manager, saved, actor, 'REFERENCE_CORRECTED', before, this.snapshot(saved), correlation, occurredAt, correction.reason);
          const recipients = saved.decisionState === 'WAITING_FOR_PRESENTATION'
            ? [saved.requesterId]
            : [saved.requesterId, ...(await this.getActiveGroupLeaderIds(manager, saved))];
          await this.notifyMany(manager, recipients.map((recipientId) => ({
            recipientId,
            requestId: saved.id,
            eventCode: `REQUEST_REFERENCE_CORRECTED_${saved.version}`,
            title: 'Resource request references updated',
            message: 'An Admin corrected the references on your request. Review its current status in Tech Resource Allocation.',
            createdAt: occurredAt,
          })).filter((notice) => notice.recipientId !== actor.id));
          return this.toRequestResponse(saved);
        });
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  async removeAdministratively(
    localUserId: string | undefined,
    requestId: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    input: AdministrativeRequestRemovalDto,
  ) {
    const expectedVersion = this.parseIfMatch(ifMatch);
    const reason = this.normalizeReason(input.reason);
    const correlation = this.requireCorrelationId(correlationId);
    this.ensureDatabaseAvailable();
    try {
      return await this.dataSource.transaction(async (manager) => {
        await lockResourceAllocationAdministrationWrites(manager);
        const actor = await this.requireAdmin(manager, localUserId);
        return runIdempotentOperation(manager, {
          actorId: actor.id,
          operation: 'request.administrativeRemoval',
          key: idempotencyKey,
          payload: { requestId, ifMatch: expectedVersion, reason },
        }, async () => {
          const resourceRequest = await this.lockRequest(manager, requestId);
          this.requireVersion(resourceRequest, expectedVersion);
          if (resourceRequest.requesterId === actor.id) {
            throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An Admin cannot remove their own request.');
          }
          this.requireState(resourceRequest, ['WAITING_FOR_PRESENTATION'], 'Only a request waiting for presentation can be removed administratively.');
          await this.requireCurrentWaitingDeadline(manager, resourceRequest);
          const audit = await removeResourceRequest(manager, {
            request: resourceRequest,
            action: 'ADMIN_REMOVED',
            actorSnapshot: this.actorSnapshot(actor),
            reason,
            correlationId: correlation,
          });
          await this.notify(manager, {
            recipientId: resourceRequest.requesterId,
            requestId: resourceRequest.id,
            eventCode: 'REQUEST_ADMIN_REMOVED',
            title: 'Resource request removed',
            message: 'An Admin removed your request from the active queue. Its audit record is retained.',
            createdAt: audit.occurredAt,
          });
          return {
            requestId: resourceRequest.id,
            action: 'ADMIN_REMOVED' as const,
            removedAt: audit.occurredAt.toISOString(),
          };
        });
      });
    } catch (error) {
      throw this.translateDatabaseError(error);
    }
  }

  private async authorizeQueue(actor: ResourcePerson, queue: RequestQueueCode, requestedGroupId?: string) {
    if (queue === 'revalidation') {
      if (actor.role === ResourceAllocationRole.Admin) {
        return {
          decisionState: 'REQUIRES_REVALIDATION',
          revalidationOriginStates: ['WAITING_FOR_PRESENTATION', 'PENDING_TEAM_DECISION', 'APPROVED_WITH_CHANGES'],
          groupIds: null as string[] | null,
        };
      }
      let groupIds: string[];
      switch (actor.role) {
        case ResourceAllocationRole.Moderator:
          groupIds = actor.groupId ? [actor.groupId] : [];
          break;
        case ResourceAllocationRole.Supervisor:
        case ResourceAllocationRole.Manager:
          groupIds = actor.coveredGroupIds;
          break;
        default:
          throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'This role cannot view the revalidation queue.');
      }
      if (requestedGroupId && !groupIds.includes(requestedGroupId)) {
        throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'The requested group is outside your active scope.');
      }
      return {
        decisionState: 'REQUIRES_REVALIDATION',
        revalidationOriginStates: ['APPROVED_WITH_CHANGES'],
        revalidationDecisionStages: ['PENDING_TEAM_DECISION'],
        groupIds: requestedGroupId ? [requestedGroupId] : [...new Set(groupIds)].sort(),
      };
    }

    if (queue === 'presentation') {
      if (actor.role !== ResourceAllocationRole.Admin) {
        throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only an active Admin can view this queue.');
      }
      return {
        decisionState: 'WAITING_FOR_PRESENTATION',
        groupIds: null as string[] | null,
      };
    }

    if (queue === 'exceptions') {
      if (actor.role !== ResourceAllocationRole.Admin) {
        throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only an active Admin can view exception requests.');
      }
      return {
        decisionState: ['PRE_N3', 'ESCALATION'],
        groupIds: null as string[] | null,
      };
    }

    let groupIds: string[];
    switch (actor.role) {
      case ResourceAllocationRole.Moderator:
        groupIds = actor.groupId ? [actor.groupId] : [];
        break;
      case ResourceAllocationRole.Supervisor:
      case ResourceAllocationRole.Manager:
        groupIds = actor.coveredGroupIds;
        break;
      case ResourceAllocationRole.Admin:
        groupIds = actor.groupId ? [actor.groupId] : [];
        break;
      default:
        throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'This role cannot view the group decision queue.');
    }

    if (requestedGroupId && !groupIds.includes(requestedGroupId)) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'The requested group is outside your active scope.');
    }
    const effectiveGroupIds = requestedGroupId ? [requestedGroupId] : [...new Set(groupIds)].sort();
    return { decisionState: 'PENDING_TEAM_DECISION', groupIds: effectiveGroupIds };
  }

  private toQueueItem(row: QueueRow, queue: RequestQueueCode, actor: ResourcePerson) {
    const canDecide = row.requester_id !== actor.id && !row.deadline_passed;
    const canResolveException = (row.exception_impediments?.length ?? 0) === 0;
    const groupId = typeof row.requested_conditions.groupId === 'string' ? row.requested_conditions.groupId : '';
    const inGroupScope = actor.role === ResourceAllocationRole.Admin
      ? actor.groupId === groupId
      : actor.role === ResourceAllocationRole.Moderator
        ? actor.groupId === groupId
        : (actor.role === ResourceAllocationRole.Supervisor || actor.role === ResourceAllocationRole.Manager) && actor.coveredGroupIds.includes(groupId);
    const isReferenceImpediment = row.exception_impediments?.some((impediment) => [
      'GROUP_INACTIVE', 'INITIATIVE_INACTIVE', 'PROFILE_INACTIVE', 'PROFILE_GROUP_MISMATCH',
    ].includes(impediment)) ?? false;
    const isRequester = row.requester_id === actor.id;
    const revalidationActions = (() => {
      const correction = actor.role === ResourceAllocationRole.Admin && isReferenceImpediment ? ['REFERENCE_CORRECTION'] : [];
      if (row.revalidation_origin_state === 'WAITING_FOR_PRESENTATION') {
        return actor.role === ResourceAllocationRole.Admin
          ? [...correction, ...(!isReferenceImpediment ? ['REFER'] : []), ...(!isRequester && !isReferenceImpediment ? ['APPROVE', 'DENY'] : [])]
          : [];
      }
      if (row.revalidation_origin_state === 'PENDING_TEAM_DECISION') {
        return actor.role === ResourceAllocationRole.Admin
          ? [...correction, ...(!isReferenceImpediment ? ['REFER'] : []), ...(!isRequester && !isReferenceImpediment ? ['APPROVE', 'DENY'] : [])]
          : [];
      }
      if (row.revalidation_origin_state === 'APPROVED_WITH_CHANGES') {
        const canProposalDecide = inGroupScope || actor.role === ResourceAllocationRole.Admin && row.revalidation_decision_stage === 'WAITING_FOR_PRESENTATION';
        return [
          ...correction,
          ...(!isRequester && canProposalDecide ? ['DENY', ...(!isReferenceImpediment ? ['APPROVE'] : [])] : []),
        ];
      }
      return [];
    })();
    return {
      id: row.id,
      requester: row.requester_snapshot,
      requestedConditions: row.requested_conditions,
      approvedConditions: row.approved_conditions,
      resolutionStrategy: row.resolution_strategy,
      resolutionReason: row.resolution_reason,
      affectedInitiativeIds: row.affected_initiative_ids ?? [],
      decisionState: row.decision_state,
      originState: row.revalidation_origin_state,
      receivedAt: new Date(row.received_at).toISOString(),
      stageEnteredAt: new Date(row.stage_entered_at).toISOString(),
      dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
      impediments: queue === 'exceptions' || queue === 'revalidation'
        ? row.exception_impediments ?? []
        : row.deadline_passed ? ['PRESENTATION_DEADLINE_PASSED'] : [],
      nextResponsible: queue === 'team-decision' || queue === 'revalidation' && row.revalidation_origin_state === 'APPROVED_WITH_CHANGES' && row.revalidation_decision_stage === 'PENDING_TEAM_DECISION'
        ? row.next_responsible
        : { role: 'ALLOCATION_ADMIN' },
      availableActions: queue === 'revalidation'
        ? revalidationActions
        : queue === 'exceptions'
        ? [...(row.exception_impediments?.length ? ['REFERENCE_CORRECTION'] : []), ...(!isRequester
          ? [...(row.decision_state === 'PRE_N3' ? ['ESCALATE'] : []), 'CANCEL', 'RECORD_STRATEGY', ...(canResolveException ? ['RESOLVE'] : [])]
          : [])]
        : queue === 'presentation'
        ? !row.deadline_passed
          ? ['REFER', 'REFERENCE_CORRECTION', ...(!isRequester ? ['ADMINISTRATIVE_REMOVE'] : []), ...(canDecide ? ['APPROVE', 'DENY'] : [])]
          : []
        : canDecide ? ['APPROVE', 'DENY'] : [],
      version: Number(row.version),
    };
  }

  private async lockRequest(manager: EntityManager, id: string): Promise<ResourceRequest> {
    const request = await manager.getRepository(ResourceRequest).createQueryBuilder('request')
      .setLock('pessimistic_write')
      .where('request.id = :id', { id })
      .getOne();
    if (!request || request.removedAt) throw this.notFound('Request');
    return request;
  }

  private async requireActiveReferences(manager: EntityManager, conditions: Record<string, unknown>) {
    const initiativeId = this.readUuid(conditions.initiativeId);
    const groupId = this.readUuid(conditions.groupId);
    const profileId = this.readUuid(conditions.resourceProfileId);
    if (!initiativeId || !groupId || !profileId) {
      throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'The request references are incomplete.');
    }
    const initiative = await manager.getRepository(ResourceInitiative).findOne({ where: { id: initiativeId, active: true } });
    const group = await manager.getRepository(ResourceGroup).findOne({ where: { id: groupId, active: true } });
    const profile = await manager.getRepository(ResourceProfile).findOne({ where: { id: profileId, active: true } });
    if (!initiative || !group || !profile || profile.groupId !== group.id) {
      throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'The request must use an active ITDM, group, and profile from the same group.');
    }
    return { group, initiative, profile };
  }

  private async notifyGroupLeaders(
    manager: EntityManager,
    group: ResourceGroup,
    resourceRequest: ResourceRequest,
    actor: ResourcePerson,
    createdAt: Date,
  ): Promise<void> {
    const leaders = await manager.getRepository(ResourcePerson).createQueryBuilder('person')
      .where('person.active = TRUE')
      .andWhere('((person.role = :moderator AND person.groupId = :groupId) OR (person.role = :admin AND person.groupId = :groupId) OR person.id = :supervisorId OR person.id = :managerId)', {
        moderator: ResourceAllocationRole.Moderator,
        admin: ResourceAllocationRole.Admin,
        groupId: group.id,
        supervisorId: group.supervisorId ?? '00000000-0000-4000-8000-000000000000',
        managerId: group.managerId ?? '00000000-0000-4000-8000-000000000000',
      })
      .getMany();
    const recipients = new Map(leaders
      .filter((person) => person.id !== actor.id && person.id !== resourceRequest.requesterId)
      .map((person) => [person.id, person]));
    await this.notifyMany(manager, [...recipients.keys()].map((recipientId) => ({
      recipientId,
      requestId: resourceRequest.id,
      eventCode: `REQUEST_REFERRED_${resourceRequest.version}`,
      title: 'Resource request referred to your group',
      message: 'A request is waiting for a decision from your group.',
      createdAt,
    })));
  }

  private async getActiveGroupLeaderIds(manager: EntityManager, request: ResourceRequest): Promise<string[]> {
    const groupId = this.readUuid(request.requestedConditions.groupId);
    if (!groupId) return [];
    const leaders = await manager.query(`
      SELECT DISTINCT person.id
      FROM resource_people AS person
      LEFT JOIN resource_groups AS request_group ON request_group.id = $1
      WHERE person.active = TRUE
        AND (
          (person.role IN ($2, $3) AND person.group_id = $1)
          OR person.id = request_group.supervisor_id
          OR person.id = request_group.manager_id
        )
    `, [groupId, ResourceAllocationRole.Moderator, ResourceAllocationRole.Admin]) as Array<{ id: string }>;
    return leaders.map((leader) => leader.id);
  }

  private async notifyMany(
    manager: EntityManager,
    notices: Array<{
      recipientId: string;
      requestId: string;
      eventCode: string;
      title: string;
      message: string;
      createdAt: Date;
    }>,
  ): Promise<void> {
    if (notices.length === 0) return;
    const repository = manager.getRepository(ResourceAllocationNotification);
    await repository.insert(notices.map((notice) => repository.create({
      recipientId: notice.recipientId,
      sourceRequestId: notice.requestId,
      eventCode: notice.eventCode,
      title: notice.title,
      message: notice.message,
      createdAt: notice.createdAt,
    })));
  }

  private async notify(
    manager: EntityManager,
    notice: { recipientId: string; requestId: string; eventCode: string; title: string; message: string; createdAt: Date },
  ): Promise<void> {
    await this.notifyMany(manager, [notice]);
  }

  private async recordHistory(
    manager: EntityManager,
    request: ResourceRequest,
    actor: ResourcePerson,
    action: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    correlationId: string,
    occurredAt: Date,
    reason?: string,
  ): Promise<void> {
    await manager.getRepository(ResourceRequestHistory).insert({
      requestId: request.id,
      actorSnapshot: this.actorSnapshot(actor),
      action,
      afterSnapshot: { requestId: request.id, before, after, ...(reason ? { reason } : {}) },
      correlationId,
      occurredAt,
    });
  }

  private snapshot(request: ResourceRequest): RequestSnapshot {
    return {
      id: request.id,
      requesterId: request.requesterId,
      requesterSnapshot: request.requesterSnapshot,
      requestedConditions: request.requestedConditions,
      approvedConditions: request.approvedConditions,
      decisionState: request.decisionState,
      revalidationOriginState: request.revalidationOriginState,
      revalidationDecisionStage: request.revalidationDecisionStage,
      receivedAt: request.receivedAt,
      stageEnteredAt: request.stageEnteredAt,
      expirationDueAt: request.expirationDueAt,
      removedAt: request.removedAt,
      version: request.version,
    };
  }

  private toRequestResponse(request: ResourceRequest) {
    return {
      id: request.id,
      requester: request.requesterSnapshot,
      requestedConditions: request.requestedConditions,
      decisionState: request.decisionState,
      originState: request.revalidationOriginState,
      receivedAt: request.receivedAt.toISOString(),
      stageEnteredAt: request.stageEnteredAt.toISOString(),
      dueAt: request.decisionState === 'WAITING_FOR_PRESENTATION' ? request.expirationDueAt.toISOString() : null,
      version: request.version,
    };
  }

  private async currentTimestamp(manager: EntityManager): Promise<Date> {
    const rows = await manager.query('SELECT clock_timestamp() AS occurred_at') as Array<{ occurred_at: Date }>;
    return rows[0].occurred_at;
  }

  private async requireActivePerson(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
    if (process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED === 'false' || process.env.NODE_ENV === 'production' && process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'true') {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Local access disabled', 503, 'Local simulated access is not enabled for this runtime.');
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before accessing request queues.');
    }
    const actor = await manager.getRepository(ResourcePerson).findOne({ where: { localUserId, active: true } });
    if (!actor) throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An active Tech Resource Allocation profile is required.');
    return actor;
  }

  private async requireAdmin(manager: EntityManager, localUserId: string | undefined): Promise<ResourcePerson> {
    const actor = await this.requireActivePerson(manager, localUserId);
    if (actor.role !== ResourceAllocationRole.Admin) {
      throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'Only an active Tech Resource Allocation Admin may perform this action.');
    }
    return actor;
  }

  private ensureDatabaseAvailable(): void {
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is not configured or available.');
    }
  }

  private parseQueueCode(value: string): RequestQueueCode {
    if (value === 'presentation' || value === 'team-decision' || value === 'exceptions' || value === 'revalidation') return value;
    throw this.validationError('queueCode must be presentation, team-decision, exceptions, or revalidation.');
  }

  private parsePageSize(value: string | undefined): number {
    if (value === undefined) return defaultPageSize;
    if (!/^(?:[1-9][0-9]*)$/.test(value)) throw this.validationError('limit must be an integer between 1 and 100.');
    const limit = Number(value);
    if (limit > maximumPageSize) throw this.validationError('limit must be an integer between 1 and 100.');
    return limit;
  }

  private normalizeFilters(filters: QueueFilters): {
    groupId: string | undefined;
    initiativeId: string | undefined;
    resourceProfileId: string | undefined;
    decisionState: string | undefined;
  } {
    return {
      groupId: this.normalizeOptionalUuid(filters.groupId, 'groupId'),
      initiativeId: this.normalizeOptionalUuid(filters.initiativeId, 'initiativeId'),
      resourceProfileId: this.normalizeOptionalUuid(filters.resourceProfileId, 'resourceProfileId'),
      decisionState: this.normalizeOptionalString(filters.decisionState, 'decisionState', 40),
    };
  }

  private normalizeOptionalUuid(value: string | undefined, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (!uuidPattern.test(value)) throw this.validationError(`${field} must be a UUID.`);
    return value.toLowerCase();
  }

  private normalizeOptionalString(value: string | undefined, field: string, maximumLength: number): string | undefined {
    if (value === undefined) return undefined;
    const normalized = value.trim();
    if (!normalized || normalized.length > maximumLength) throw this.validationError(`${field} must contain between 1 and ${maximumLength} characters.`);
    return normalized;
  }

  private decodeCursor(value: string, queue: RequestQueueCode, filterHash: string): QueueCursor {
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as QueueCursor;
      if (cursor.version !== 1 || cursor.queue !== queue || cursor.filterHash !== filterHash ||
        !uuidPattern.test(cursor.id) || !cursor.stageEnteredAt || Number.isNaN(Date.parse(cursor.stageEnteredAt)) ||
        (queue === 'presentation' && (!cursor.dueAt || Number.isNaN(Date.parse(cursor.dueAt))))) {
        throw new Error('Invalid cursor.');
      }
      return cursor;
    } catch {
      throw this.validationError('cursor is invalid for this queue and filter set.');
    }
  }

  private encodeCursor(cursor: QueueCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private hashPayload(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private parseIfMatch(ifMatch: string | undefined): number {
    const match = ifMatch?.match(/^"([1-9][0-9]*)"$/);
    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      throw this.validationError('A single strong If-Match version is required.');
    }
    return Number(match[1]);
  }

  private requireVersion(request: ResourceRequest, expected: number): void {
    if (request.version !== expected) {
      throw new ResourceAllocationException('PRECONDITION_FAILED', 'Precondition failed', 412, 'The request changed. Reload it before continuing.');
    }
  }

  private requireState(request: ResourceRequest, states: string[], detail: string): void {
    if (!states.includes(request.decisionState)) {
      throw new ResourceAllocationException('INVALID_STATE_TRANSITION', 'Request cannot be changed', 422, detail);
    }
  }

  private async requireCurrentWaitingDeadline(manager: EntityManager, request: ResourceRequest): Promise<void> {
    const rows = await manager.query(
      'SELECT clock_timestamp() > $1::timestamptz AS expired',
      [request.expirationDueAt],
    ) as Array<{ expired: boolean }>;
    if (rows[0].expired) {
      throw new ResourceAllocationException('INVALID_STATE_TRANSITION', 'Request deadline passed', 422, 'The 21-day presentation deadline has passed. The request can no longer be changed.');
    }
  }

  private normalizeReferenceCorrection(input: CorrectRequestReferencesDto) {
    const corrected: { personId?: string; initiativeId?: string; groupId?: string; resourceProfileId?: string; reason: string } = {
      reason: this.normalizeReason(input.reason),
    };
    const personId = this.normalizeOptionalUuid(input.personId, 'personId');
    const initiativeId = this.normalizeOptionalUuid(input.initiativeId, 'initiativeId');
    const groupId = this.normalizeOptionalUuid(input.groupId, 'groupId');
    const resourceProfileId = this.normalizeOptionalUuid(input.resourceProfileId, 'resourceProfileId');
    if (personId) corrected.personId = personId;
    if (initiativeId) corrected.initiativeId = initiativeId;
    if (groupId) corrected.groupId = groupId;
    if (resourceProfileId) corrected.resourceProfileId = resourceProfileId;
    if (!personId && !initiativeId && !groupId && !resourceProfileId) {
      throw this.validationError('Provide at least one reference to correct.');
    }
    return corrected;
  }

  private applyReferenceCorrection(
    prior: Record<string, unknown>,
    correction: { initiativeId?: string; groupId?: string; resourceProfileId?: string; reason: string },
  ): Record<string, unknown> {
    return { ...prior,
      ...(correction.initiativeId ? { initiativeId: correction.initiativeId } : {}),
      ...(correction.groupId ? { groupId: correction.groupId } : {}),
      ...(correction.resourceProfileId ? { resourceProfileId: correction.resourceProfileId } : {}),
    };
  }

  private normalizeReason(value: string): string {
    if (typeof value !== 'string') throw this.validationError('reason is required.');
    const reason = value.trim();
    if (!reason || reason.length > 2000) throw this.validationError('reason must contain between 1 and 2000 characters.');
    return reason;
  }

  private readUuid(value: unknown): string | undefined {
    return typeof value === 'string' && uuidPattern.test(value) ? value.toLowerCase() : undefined;
  }

  private actorSnapshot(actor: ResourcePerson) {
    return { personId: actor.id, displayName: actor.displayName, role: actor.role };
  }

  private requireCorrelationId(value: string | undefined): string {
    if (!value || !uuidPattern.test(value)) throw this.validationError('A valid X-Correlation-ID is required.');
    return value.toLowerCase();
  }

  private notFound(resource: string): ResourceAllocationException {
    return new ResourceAllocationException('RESOURCE_NOT_FOUND', 'Resource not found', 404, `${resource} was not found.`);
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
  }

  private translateDatabaseError(error: unknown): never {
    if (error instanceof ResourceAllocationException) throw error;
    if (isDatabaseUnavailable(error)) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is unavailable or not prepared.', undefined, error);
    }
    throw new ResourceAllocationException('INTERNAL_ERROR', 'Internal Server Error', 500, 'Internal Server Error', undefined, error);
  }
}
