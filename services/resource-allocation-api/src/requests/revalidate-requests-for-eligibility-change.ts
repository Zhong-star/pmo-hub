import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceRequest } from './resource-request.entity';
import { ResourceRequestHistory } from './resource-request-history.entity';

type ReferenceKind = 'GROUP' | 'INITIATIVE' | 'PROFILE';

type EligibilityChange =
  | { kind: 'PERSON'; id: string }
  | { kind: ReferenceKind; id: string };

interface EligibilityRow {
  group_active: boolean | null;
  initiative_active: boolean | null;
  profile_active: boolean | null;
  profile_group_id: string | null;
  person_active: boolean | null;
  person_group_id: string | null;
  proposal_start_passed?: boolean;
  proposal_period_invalid?: boolean;
  proposal_hours_invalid?: boolean;
}

export async function revalidateRequestsForEligibilityChange(
  manager: EntityManager,
  change: EligibilityChange,
  actor: ResourcePerson,
): Promise<number> {
  const fieldByKind: Record<ReferenceKind, string> = {
    GROUP: 'groupId',
    INITIATIVE: 'initiativeId',
    PROFILE: 'resourceProfileId',
  };
  const candidateQuery = change.kind === 'PERSON'
    ? `SELECT request.id
       FROM resource_requests AS request
       WHERE request.removed_at IS NULL
         AND request.decision_state = 'APPROVED_WITH_CHANGES'
         AND request.approved_conditions->>'personId' = $1
       ORDER BY request.id
       FOR UPDATE`
    : `SELECT request.id
       FROM resource_requests AS request
       WHERE request.removed_at IS NULL
         AND (
           (request.decision_state IN ('WAITING_FOR_PRESENTATION', 'PENDING_TEAM_DECISION')
             AND request.requested_conditions->>'${fieldByKind[change.kind]}' = $1)
           OR (request.decision_state = 'APPROVED_WITH_CHANGES'
             AND request.approved_conditions->>'${fieldByKind[change.kind]}' = $1)
         )
       ORDER BY request.id
       FOR UPDATE`;
  const candidates = await manager.query(candidateQuery, [change.id]) as Array<{ id: string }>;
  let revalidated = 0;

  for (const candidate of candidates) {
    const rows = await manager.query(`
      SELECT
        group_record.active AS group_active,
        initiative.active AS initiative_active,
        profile.active AS profile_active,
        profile.group_id::text AS profile_group_id,
        assignee.active AS person_active,
        assignee.group_id::text AS person_group_id,
        (current_conditions.conditions->>'startDate') < (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS proposal_start_passed,
        current_conditions.conditions->>'startDate' IS NULL OR current_conditions.conditions->>'endDate' IS NULL
          OR current_conditions.conditions->>'endDate' < current_conditions.conditions->>'startDate' AS proposal_period_invalid,
        current_conditions.conditions->>'weeklyHours' IS NULL
          OR (current_conditions.conditions->>'weeklyHours')::numeric <= 0
          OR (current_conditions.conditions->>'weeklyHours')::numeric > 40 AS proposal_hours_invalid
      FROM resource_requests AS request
      CROSS JOIN LATERAL (
        SELECT CASE WHEN request.decision_state = 'APPROVED_WITH_CHANGES' OR request.revalidation_origin_state = 'APPROVED_WITH_CHANGES'
          THEN request.approved_conditions ELSE request.requested_conditions END AS conditions
      ) AS current_conditions
      LEFT JOIN resource_groups AS group_record
        ON group_record.id::text = current_conditions.conditions->>'groupId'
      LEFT JOIN resource_initiatives AS initiative
        ON initiative.id::text = current_conditions.conditions->>'initiativeId'
      LEFT JOIN resource_profiles AS profile
        ON profile.id::text = current_conditions.conditions->>'resourceProfileId'
      LEFT JOIN resource_people AS assignee
        ON assignee.id::text = current_conditions.conditions->>'personId'
      WHERE request.id = $1
      FOR UPDATE OF request
    `, [candidate.id]) as EligibilityRow[];
    const eligibility = rows[0];
    if (!eligibility) continue;
    const request = await manager.getRepository(ResourceRequest).findOneByOrFail({ id: candidate.id });
    const impediments = getEligibilityImpediments(request, eligibility);
    if (impediments.length === 0) continue;

    const occurredAt = await operationTimestamp(manager);
    const originState = request.decisionState;
    const before = snapshot(request);
    request.decisionState = 'REQUIRES_REVALIDATION';
    request.revalidationOriginState = originState;
    request.stageEnteredAt = occurredAt;
    request.decisionResponseDueAt = null;
    const saved = await manager.getRepository(ResourceRequest).save(request);
    const reason = `Eligibility changed: ${impediments.join(', ')}.`;
    await manager.getRepository(ResourceRequestHistory).insert({
      requestId: saved.id,
      actorSnapshot: { personId: actor.id, displayName: actor.displayName, role: actor.role },
      action: 'ELIGIBILITY_REVALIDATION_REQUIRED',
      afterSnapshot: {
        requestId: saved.id,
        before,
        after: snapshot(saved),
        originState,
        impediments,
        reason,
      },
      correlationId: randomUUID(),
      occurredAt,
    });

    const recipients = await revalidationRecipientIds(manager, saved, actor.id);
    if (recipients.length > 0) {
      await manager.getRepository(ResourceAllocationNotification).insert(recipients.map((recipientId) => ({
        recipientId,
        sourceRequestId: saved.id,
        eventCode: `REQUEST_REVALIDATION_REQUIRED_${saved.version}`,
        title: 'Resource request needs revalidation',
        message: `A person or reference is no longer eligible (${impediments.join(', ')}). The request is paused for review; the requester may cancel it.`,
        createdAt: occurredAt,
      })));
    }
    revalidated += 1;
  }

  return revalidated;
}

export async function getRequestRevalidationSummary(
  manager: EntityManager,
  request: ResourceRequest,
): Promise<{ originState: string; impediments: string[]; nextResponsible: Record<string, unknown> | Array<Record<string, unknown>> } | null> {
  const originState = request.revalidationOriginState;
  if (request.decisionState !== 'REQUIRES_REVALIDATION' || !originState) return null;
  const rows = await manager.query(`
    SELECT
      group_record.active AS group_active,
      initiative.active AS initiative_active,
      profile.active AS profile_active,
      profile.group_id::text AS profile_group_id,
      assignee.active AS person_active,
      assignee.group_id::text AS person_group_id,
      (current_conditions.conditions->>'startDate') < (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS proposal_start_passed,
      current_conditions.conditions->>'startDate' IS NULL OR current_conditions.conditions->>'endDate' IS NULL
        OR current_conditions.conditions->>'endDate' < current_conditions.conditions->>'startDate' AS proposal_period_invalid,
      current_conditions.conditions->>'weeklyHours' IS NULL
        OR (current_conditions.conditions->>'weeklyHours')::numeric <= 0
        OR (current_conditions.conditions->>'weeklyHours')::numeric > 40 AS proposal_hours_invalid
    FROM resource_requests AS request
    CROSS JOIN LATERAL (
      SELECT CASE WHEN request.revalidation_origin_state = 'APPROVED_WITH_CHANGES'
        THEN request.approved_conditions ELSE request.requested_conditions END AS conditions
    ) AS current_conditions
    LEFT JOIN resource_groups AS group_record
      ON group_record.id::text = current_conditions.conditions->>'groupId'
    LEFT JOIN resource_initiatives AS initiative
      ON initiative.id::text = current_conditions.conditions->>'initiativeId'
    LEFT JOIN resource_profiles AS profile
      ON profile.id::text = current_conditions.conditions->>'resourceProfileId'
    LEFT JOIN resource_people AS assignee
      ON assignee.id::text = current_conditions.conditions->>'personId'
    WHERE request.id = $1
  `, [request.id]) as EligibilityRow[];
  const impediments = rows[0] ? getEligibilityImpediments(request, rows[0]) : ['REQUEST_REFERENCES_INVALID'];
  if (originState === 'WAITING_FOR_PRESENTATION' || originState === 'PENDING_TEAM_DECISION') {
    return { originState, impediments, nextResponsible: { role: ResourceAllocationRole.Admin } };
  }
  if (request.revalidationDecisionStage === 'WAITING_FOR_PRESENTATION') {
    return { originState, impediments, nextResponsible: { role: ResourceAllocationRole.Admin } };
  }

  const requestedGroupId = String((request.requestedConditions as Record<string, unknown>).groupId ?? '');
  const group = await manager.getRepository(ResourceGroup).findOne({ where: { id: requestedGroupId } });
  if (!group?.active) {
    return { originState, impediments, nextResponsible: { role: ResourceAllocationRole.Admin } };
  }
  const leaders = await manager.query(`
    SELECT DISTINCT leader.id AS "personId", leader.display_name AS "displayName", leader.role
    FROM resource_people AS leader
    WHERE leader.active = TRUE
      AND leader.id <> $2
      AND (
        (leader.role IN ($3, $4) AND leader.group_id = $1)
        OR leader.id = $5
        OR leader.id = $6
      )
    ORDER BY "displayName", "personId"
  `, [group.id, request.requesterId, ResourceAllocationRole.Moderator, ResourceAllocationRole.Admin, group.supervisorId, group.managerId]) as Array<Record<string, unknown>>;
  return { originState, impediments, nextResponsible: leaders };
}

function getEligibilityImpediments(request: ResourceRequest, row: EligibilityRow): string[] {
  const isProposal = request.decisionState === 'APPROVED_WITH_CHANGES' || request.revalidationOriginState === 'APPROVED_WITH_CHANGES';
  const conditions = (isProposal ? request.approvedConditions : request.requestedConditions) as Record<string, unknown> | null;
  if (!conditions) return isProposal ? ['PROPOSAL_MISSING'] : ['REQUEST_REFERENCES_INVALID'];

  const impediments: string[] = [];
  if (row.group_active !== true) impediments.push('GROUP_INACTIVE');
  if (row.initiative_active !== true) impediments.push('INITIATIVE_INACTIVE');
  if (row.profile_active !== true) impediments.push('PROFILE_INACTIVE');
  if (row.profile_active === true && row.profile_group_id !== conditions.groupId) impediments.push('PROFILE_GROUP_MISMATCH');
  if (isProposal) {
    if (row.person_active !== true) impediments.push('PERSON_INACTIVE');
    if (row.person_active === true && row.person_group_id !== conditions.groupId) impediments.push('PERSON_LEFT_GROUP');
    if (row.proposal_period_invalid) impediments.push('PROPOSAL_PERIOD_INVALID');
    if (row.proposal_start_passed) impediments.push('PROPOSED_START_DATE_PASSED');
    if (row.proposal_hours_invalid) impediments.push('PROPOSAL_HOURS_INVALID');
  }
  return impediments;
}

async function revalidationRecipientIds(manager: EntityManager, request: ResourceRequest, actorId: string): Promise<string[]> {
  const administrators = await manager.getRepository(ResourcePerson).find({
    where: { role: ResourceAllocationRole.Admin, active: true },
    select: { id: true },
  });
  const groupId = (request.requestedConditions as Record<string, unknown>).groupId;
  const leaders = typeof groupId === 'string'
    ? await manager.query(`
        SELECT DISTINCT person.id
        FROM resource_people AS person
        LEFT JOIN resource_groups AS request_group ON request_group.id::text = $1
        WHERE person.active = TRUE
          AND (
            (person.role IN ($2, $3) AND person.group_id::text = $1)
            OR person.id = request_group.supervisor_id
            OR person.id = request_group.manager_id
          )
      `, [groupId, ResourceAllocationRole.Moderator, ResourceAllocationRole.Admin]) as Array<{ id: string }>
    : [];
  return [...new Set([
    request.requesterId,
    ...administrators.map((person) => person.id),
    ...leaders.map((leader) => leader.id),
  ])].filter((recipientId) => recipientId !== actorId);
}

function snapshot(request: ResourceRequest): Record<string, unknown> {
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
    expirationDueAt: request.expirationDueAt.toISOString(),
    decisionResponseDueAt: request.decisionResponseDueAt?.toISOString() ?? null,
    version: request.version,
  };
}

async function operationTimestamp(manager: EntityManager): Promise<Date> {
  const rows = await manager.query('SELECT clock_timestamp() AS occurred_at') as Array<{ occurred_at: Date }>;
  return new Date(rows[0].occurred_at);
}
