import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RESOURCE_ALLOCATION_DATA_SOURCE, RESOURCE_ALLOCATION_DATABASE_CONFIGURED } from '../database/database.module';
import { ResourceAllocationException, translateResourceAllocationDatabaseError } from '../access/resource-allocation-problem';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/opaque-cursor';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourceRequestDecisionState } from '../submissions/submission-category';

const defaultPageSize = 50;
const maximumPageSize = 100;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RequestQueueCode = 'presentation' | 'team-decision' | 'requester-response' | 'exceptions' | 'revalidation';

export interface QueueFilters {
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
  cursor_stage_entered_at: string;
  due_at: Date | null;
  cursor_due_at: string | null;
  deadline_passed: boolean;
  next_responsible: Array<{ personId: string; displayName: string; role: string }>;
  version: number;
}

@Injectable()
export class ResourceAllocationRequestQueueReadService {
  constructor(
    @Inject(RESOURCE_ALLOCATION_DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(RESOURCE_ALLOCATION_DATABASE_CONFIGURED) private readonly databaseConfigured: boolean,
  ) {}

  async listQueue(localUserId: string | undefined, queueValue: string, filters: QueueFilters) {
    this.ensureDatabaseAvailable();

    try {
      const actor = await this.requireActivePerson(localUserId);
      const queue = this.parseQueueCode(queueValue);
      const pageSize = this.parsePageSize(filters.limit);
      const normalizedFilters = this.normalizeFilters(filters);
      const scope = await this.authorizeQueue(actor, queue, normalizedFilters.groupId);
      const filterHash = this.hashPayload({
        queue,
        filters: normalizedFilters,
        groupIds: scope.groupIds,
        requesterId: 'requesterId' in scope ? scope.requesterId : null,
      });
      const cursor = filters.cursor ? this.decodeCursor(filters.cursor, queue, filterHash) : undefined;
      const decisionStates = Array.isArray(scope.decisionState) ? scope.decisionState : [scope.decisionState];
      const conditions = ['r.removed_at IS NULL', 'r.decision_state = ANY($1::text[])'];
      const parameters: unknown[] = [decisionStates];
      const bind = (value: unknown) => {
        parameters.push(value);
        return `$${parameters.length}`;
      };

      if ('requesterId' in scope && scope.requesterId) {
        conditions.push(`r.requester_id = ${bind(scope.requesterId)}::uuid`);
      }
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
        if (queue === 'presentation' || queue === 'requester-response') {
          if (cursor.dueAt !== null) {
            conditions.push(
              `(queue_deadline.due_at IS NULL OR (queue_deadline.due_at, r.stage_entered_at, r.id) > (${bind(cursor.dueAt)}::timestamptz, ${bind(cursor.stageEnteredAt)}::timestamptz, ${bind(cursor.id)}::uuid))`,
            );
          } else {
            conditions.push(
              `(queue_deadline.due_at IS NULL AND (r.stage_entered_at, r.id) > (${bind(cursor.stageEnteredAt)}::timestamptz, ${bind(cursor.id)}::uuid))`,
            );
          }
        } else {
          conditions.push(`(r.stage_entered_at, r.id) > (${bind(cursor.stageEnteredAt)}::timestamptz, ${bind(cursor.id)}::uuid)`);
        }
      }

      const limitParameter = bind(pageSize + 1);
      const rows = await this.dataSource.query(
        `WITH operation_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now
         )
         SELECT r.id, r.requester_id, r.requester_snapshot, r.requested_conditions, r.approved_conditions, r.decision_state,
                r.revalidation_origin_state, r.revalidation_decision_stage,
                r.received_at, r.stage_entered_at,
                to_char(r.stage_entered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_stage_entered_at,
                queue_deadline.due_at,
                CASE
                  WHEN queue_deadline.due_at IS NOT NULL
                  THEN to_char(queue_deadline.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                  ELSE NULL
                END AS cursor_due_at,
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
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND r.revalidation_origin_state = 'APPROVED_WITH_CHANGES' AND (r.approved_conditions->>'startDate') < (operation_clock.now AT TIME ZONE 'America/Sao_Paulo')::date::text THEN 'PROPOSED_START_DATE_PASSED' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND r.revalidation_origin_state = 'APPROVED_WITH_CHANGES' AND (r.approved_conditions->>'endDate') < (r.approved_conditions->>'startDate') THEN 'PROPOSAL_PERIOD_INVALID' END,
                  CASE WHEN r.decision_state = 'REQUIRES_REVALIDATION' AND r.revalidation_origin_state = 'APPROVED_WITH_CHANGES' AND ((r.approved_conditions->>'weeklyHours')::numeric <= 0 OR (r.approved_conditions->>'weeklyHours')::numeric > 40) THEN 'PROPOSAL_HOURS_INVALID' END
                ], NULL::text) AS exception_impediments,
                CASE
                  WHEN r.decision_state = 'WAITING_FOR_PRESENTATION' THEN r.expiration_due_at < operation_clock.now
                  WHEN r.decision_state = 'APPROVED_WITH_CHANGES' THEN (r.decision_response_due_at IS NULL OR operation_clock.now >= r.decision_response_due_at)
                  WHEN r.decision_state = 'DENIED' THEN operation_clock.now > r.expiration_due_at
                  ELSE FALSE
                END AS deadline_passed,
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
         CROSS JOIN operation_clock
         CROSS JOIN LATERAL (
           SELECT CASE
             WHEN r.decision_state = 'WAITING_FOR_PRESENTATION' THEN r.expiration_due_at
             WHEN r.decision_state = 'APPROVED_WITH_CHANGES' THEN r.decision_response_due_at
             WHEN r.decision_state = 'DENIED' THEN r.expiration_due_at
             ELSE NULL
           END AS due_at
         ) AS queue_deadline
         LEFT JOIN resource_groups AS g ON g.id::text = r.requested_conditions->>'groupId'
         LEFT JOIN resource_initiatives AS i ON i.id::text = r.requested_conditions->>'initiativeId'
         LEFT JOIN resource_profiles AS p ON p.id::text = COALESCE(r.approved_conditions->>'resourceProfileId', r.requested_conditions->>'resourceProfileId')
         LEFT JOIN resource_people AS person ON person.id::text = r.approved_conditions->>'personId'
         WHERE ${conditions.join(' AND ')}
         ORDER BY CASE WHEN queue_deadline.due_at IS NOT NULL THEN 0 ELSE 1 END ASC,
                  queue_deadline.due_at ASC NULLS LAST,
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
        dueAt: last.cursor_due_at,
        stageEnteredAt: last.cursor_stage_entered_at,
        id: last.id,
      }) : null;

      return {
        items: selected.map((row) => this.toQueueItem(row, queue, actor)),
        page: { nextCursor, limit: pageSize },
      };
    } catch (error) {
      throw translateResourceAllocationDatabaseError(error);
    }
  }

  private ensureDatabaseAvailable(): void {
    if (!this.databaseConfigured || !this.dataSource.isInitialized) {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Dependency unavailable', 503, 'The Resource Allocation database is not configured or available.');
    }
  }

  private async requireActivePerson(localUserId: string | undefined): Promise<ResourcePerson> {
    if (process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED === 'false' || process.env.NODE_ENV === 'production' && process.env.RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED !== 'true') {
      throw new ResourceAllocationException('DEPENDENCY_UNAVAILABLE', 'Local access disabled', 503, 'Local simulated access is not enabled for this runtime.');
    }
    if (!localUserId?.trim() || localUserId.length > 200) {
      throw new ResourceAllocationException('AUTHENTICATION_REQUIRED', 'Local profile required', 401, 'Select an active local profile before accessing request queues.');
    }
    const actor = await this.dataSource.getRepository(ResourcePerson).findOne({ where: { localUserId, active: true } });
    if (!actor) throw new ResourceAllocationException('ACCESS_DENIED', 'Access denied', 403, 'An active Tech Resource Allocation profile is required.');
    return actor;
  }

  private validationError(detail: string): ResourceAllocationException {
    return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
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

    if (queue === 'requester-response') {
      return {
        decisionState: [ResourceRequestDecisionState.ApprovedWithChanges, ResourceRequestDecisionState.Denied],
        groupIds: null as string[] | null,
        requesterId: actor.id,
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
    const requesterResponseActions = row.deadline_passed
      ? []
      : row.decision_state === ResourceRequestDecisionState.ApprovedWithChanges
        ? ['ACCEPT', 'CONTEST']
        : row.decision_state === ResourceRequestDecisionState.Denied
          ? ['CONTEST', 'CANCEL']
          : [];
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
        : queue === 'requester-response'
          ? row.deadline_passed
            ? [row.decision_state === ResourceRequestDecisionState.ApprovedWithChanges ? 'PROPOSAL_RESPONSE_EXPIRED' : 'DENIAL_RESPONSE_EXPIRED']
            : []
          : row.deadline_passed ? ['PRESENTATION_DEADLINE_PASSED'] : [],
      nextResponsible: queue === 'requester-response'
        ? [{ personId: actor.id, displayName: actor.displayName, role: actor.role }]
        : queue === 'team-decision' || queue === 'revalidation' && row.revalidation_origin_state === 'APPROVED_WITH_CHANGES' && row.revalidation_decision_stage === 'PENDING_TEAM_DECISION'
          ? row.next_responsible
          : { role: 'ALLOCATION_ADMIN' },
      availableActions: queue === 'requester-response'
        ? requesterResponseActions
        : queue === 'revalidation'
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

  private parseQueueCode(value: string): RequestQueueCode {
    if (
      value === 'presentation' ||
      value === 'team-decision' ||
      value === 'requester-response' ||
      value === 'exceptions' ||
      value === 'revalidation'
    ) return value;
    throw this.validationError('queueCode must be presentation, team-decision, requester-response, exceptions, or revalidation.');
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
    const decisionState = this.normalizeOptionalString(filters.decisionState, 'decisionState', 40);
    if (decisionState !== undefined && !Object.values(ResourceRequestDecisionState).includes(decisionState as ResourceRequestDecisionState)) {
      throw this.validationError('decisionState must be a valid request decision state.');
    }
    return {
      groupId: this.normalizeOptionalUuid(filters.groupId, 'groupId'),
      initiativeId: this.normalizeOptionalUuid(filters.initiativeId, 'initiativeId'),
      resourceProfileId: this.normalizeOptionalUuid(filters.resourceProfileId, 'resourceProfileId'),
      decisionState,
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
      const cursor = decodeOpaqueCursor<QueueCursor>(value);
      const requiresDueAt = queue === 'presentation';
      const allowsDueAt = queue === 'presentation' || queue === 'requester-response';
      if (cursor.version !== 1 || cursor.queue !== queue || cursor.filterHash !== filterHash ||
        !uuidPattern.test(cursor.id) || !cursor.stageEnteredAt || Number.isNaN(Date.parse(cursor.stageEnteredAt)) ||
        (requiresDueAt && (!cursor.dueAt || Number.isNaN(Date.parse(cursor.dueAt)))) ||
        (allowsDueAt && cursor.dueAt !== null && Number.isNaN(Date.parse(cursor.dueAt)))) {
        throw new Error('Invalid cursor.');
      }
      return cursor;
    } catch {
      throw this.validationError('cursor is invalid for this queue and filter set.');
    }
  }

  private encodeCursor(cursor: QueueCursor): string {
    return encodeOpaqueCursor(cursor);
  }

  private hashPayload(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }


}
