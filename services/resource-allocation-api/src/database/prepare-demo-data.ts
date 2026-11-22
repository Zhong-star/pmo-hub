import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { ResourceAllocationHistory } from '../allocations/resource-allocation-history.entity';
import { ResourceAllocation } from '../allocations/resource-allocation.entity';
import { ResourceGroup } from '../groups/resource-group.entity';
import { markInitiativeUsedForRequest } from '../initiatives/mark-initiative-used';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceRequestHistory } from '../requests/resource-request-history.entity';
import { ResourceRequest } from '../requests/resource-request.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';
import { ResourceSubmissionEntry } from '../submissions/resource-submission-entry.entity';
import { ResourceSubmissionLine } from '../submissions/resource-submission-line.entity';
import { ResourceSubmission } from '../submissions/resource-submission.entity';
import {
  ResourceRequestCategory,
  ResourceRequestDecisionState,
  ResourceSubmissionLineStatus,
} from '../submissions/submission-category';
import { ensureMinimalOperationalBaseline } from './prepare-minimal-records';

export interface PrepareDemoDataOptions {
  primaryInitiativeCode?: string;
  primaryInitiativeName?: string;
  secondaryInitiativeCode?: string;
  secondaryInitiativeName?: string;
}

export interface PrepareDemoDataResult {
  initiativesCreated: number;
  submissionsCreated: number;
  requestsCreated: number;
  allocationsCreated: number;
  failedLinesCreated: number;
}

interface DemoContext {
  group: ResourceGroup;
  profile: ResourceProfile;
  primaryInitiative: ResourceInitiative;
  secondaryInitiative: ResourceInitiative;
  requester: ResourcePerson;
  peerAssignee: ResourcePerson;
  decider: ResourcePerson;
  adminSnapshot: { personId: string; displayName: string; role: string };
  adminIds: string[];
  leaderIds: string[];
  now: Date;
  today: string;
}

interface DemoRequestSeed {
  lineId: string;
  attemptKey: string;
  requestId: string;
  allocationId?: string;
  lineNumber: number;
  decisionState: ResourceRequestDecisionState;
  revalidationOriginState?: string | null;
  revalidationDecisionStage?: string | null;
  requestedStartOffset: number;
  requestedEndOffset: number;
  requestedHours: number;
  comment: string;
  approved?: {
    assignee: ResourcePerson;
    startOffset: number;
    endOffset: number;
    weeklyHours: number;
    explanation?: string;
    allocation?: {
      id: string;
      state: 'IN_PROGRESS' | 'NOT_STARTED' | 'SUSPENDED' | 'DONE';
      suspendReason?: string;
    };
  };
  denialReason?: string;
  contestReason?: string;
  escalationReason?: string;
  cancelReason?: string;
}

const demoSubmission1Id = '51000000-0000-4000-8000-000000000101';
const demoSubmission2Id = '51000000-0000-4000-8000-000000000102';
const demoCorrelation1 = '51000000-0000-4000-8000-000000000601';
const demoCorrelation2 = '51000000-0000-4000-8000-000000000602';
const demoFailedLineId = '51000000-0000-4000-8000-000000000299';
const demoFailedAttemptKey = '51000000-0000-4000-8000-000000000399';
const primaryDemoInitiativeId = '51000000-0000-4000-8000-000000000021';
const secondaryDemoInitiativeId = '51000000-0000-4000-8000-000000000022';
const fallbackAdminSnapshot = {
  personId: '00000000-0000-4000-8000-000000000001',
  displayName: 'Local Allocation Admin',
  role: ResourceAllocationRole.Admin,
};

const defaultDemoOptions: Required<PrepareDemoDataOptions> = {
  primaryInitiativeCode: 'ITDM-DEMO-001',
  primaryInitiativeName: 'Demo Cloud Modernization',
  secondaryInitiativeCode: 'ITDM-DEMO-002',
  secondaryInitiativeName: 'Demo Platform Reliability',
};

function demoUuid(prefix: string, index: number): string {
  return `51000000-0000-4000-8000-${prefix}${String(index).padStart(8, '0')}`;
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function shiftHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function hashConditions(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function personSnapshot(person: ResourcePerson): { personId: string; displayName: string; role: string } {
  return { personId: person.id, displayName: person.displayName, role: person.role };
}

function normalizeDemoOptions(options: PrepareDemoDataOptions = {}): Required<PrepareDemoDataOptions> {
  const primaryCode = (options.primaryInitiativeCode ?? defaultDemoOptions.primaryInitiativeCode).trim();
  const primaryName = (options.primaryInitiativeName ?? defaultDemoOptions.primaryInitiativeName).trim();
  const secondaryCode = (options.secondaryInitiativeCode ?? defaultDemoOptions.secondaryInitiativeCode).trim();
  const secondaryName = (options.secondaryInitiativeName ?? defaultDemoOptions.secondaryInitiativeName).trim();

  if (!primaryCode || primaryCode.length > 100) {
    throw new Error('Primary demo ITDM code must contain 1 to 100 characters.');
  }
  if (!primaryName || primaryName.length > 200) {
    throw new Error('Primary demo ITDM name must contain 1 to 200 characters.');
  }
  if (!secondaryCode || secondaryCode.length > 100) {
    throw new Error('Secondary demo ITDM code must contain 1 to 100 characters.');
  }
  if (!secondaryName || secondaryName.length > 200) {
    throw new Error('Secondary demo ITDM name must contain 1 to 200 characters.');
  }
  if (primaryCode.toLowerCase() === secondaryCode.toLowerCase()) {
    throw new Error('Primary and secondary demo ITDM codes must be distinct.');
  }

  return {
    primaryInitiativeCode: primaryCode,
    primaryInitiativeName: primaryName,
    secondaryInitiativeCode: secondaryCode,
    secondaryInitiativeName: secondaryName,
  };
}

export function readDemoDataOptionsFromEnv(
  environment: Record<string, string | undefined> = process.env,
): PrepareDemoDataOptions {
  return {
    ...(environment.RESOURCE_ALLOCATION_DEMO_INITIATIVE_PRIMARY_CODE !== undefined
      ? { primaryInitiativeCode: environment.RESOURCE_ALLOCATION_DEMO_INITIATIVE_PRIMARY_CODE }
      : {}),
    ...(environment.RESOURCE_ALLOCATION_DEMO_INITIATIVE_PRIMARY_NAME !== undefined
      ? { primaryInitiativeName: environment.RESOURCE_ALLOCATION_DEMO_INITIATIVE_PRIMARY_NAME }
      : {}),
    ...(environment.RESOURCE_ALLOCATION_DEMO_INITIATIVE_SECONDARY_CODE !== undefined
      ? { secondaryInitiativeCode: environment.RESOURCE_ALLOCATION_DEMO_INITIATIVE_SECONDARY_CODE }
      : {}),
    ...(environment.RESOURCE_ALLOCATION_DEMO_INITIATIVE_SECONDARY_NAME !== undefined
      ? { secondaryInitiativeName: environment.RESOURCE_ALLOCATION_DEMO_INITIATIVE_SECONDARY_NAME }
      : {}),
  };
}

async function ensureDemoInitiative(
  manager: EntityManager,
  id: string,
  code: string,
  name: string,
): Promise<{ created: boolean; initiative: ResourceInitiative }> {
  const repository = manager.getRepository(ResourceInitiative);
  const existing = await repository
    .createQueryBuilder('initiative')
    .where('initiative.id = :id OR LOWER(BTRIM(initiative.code)) = LOWER(BTRIM(:code))', { id, code })
    .getOne();
  if (existing) {
    return { created: false, initiative: existing };
  }
  const saved = await repository.save(
    repository.create({
      id,
      code,
      name,
      active: true,
      codeUsed: false,
    }),
  );
  return { created: true, initiative: saved };
}

async function ensureDemoPerson(
  manager: EntityManager,
  preferredLocalUserId: string,
  fallbackLocalUserId: string,
  fallbackDisplayName: string,
  fallbackEmail: string,
  role: ResourceAllocationRole.User | ResourceAllocationRole.Moderator,
  groupId: string,
): Promise<ResourcePerson> {
  const people = manager.getRepository(ResourcePerson);
  const preferred = await people.findOne({ where: { localUserId: preferredLocalUserId } });
  if (preferred) {
    if (preferred.active && (role === ResourceAllocationRole.User || preferred.groupId === groupId)) {
      return preferred;
    }
    const existingFallback = await people.findOne({ where: { localUserId: fallbackLocalUserId } });
    if (existingFallback) {
      if (!existingFallback.active) {
        throw new Error(`Demo fallback profile (${fallbackLocalUserId}) is inactive and was left unchanged.`);
      }
      return existingFallback;
    }
    return people.save(
      people.create({
        localUserId: fallbackLocalUserId,
        displayName: fallbackDisplayName,
        email: fallbackEmail,
        role: ResourceAllocationRole.User,
        active: true,
        groupId,
        coveredGroupIds: [],
      }),
    );
  }

  return people.save(
    people.create({
      localUserId: preferredLocalUserId,
      displayName: fallbackDisplayName,
      email: fallbackEmail,
      role,
      active: true,
      groupId,
      coveredGroupIds: [],
    }),
  );
}

async function resolveDemoContext(
  manager: EntityManager,
  options: Required<PrepareDemoDataOptions>,
): Promise<{ context: DemoContext; initiativesCreated: number }> {
  const groupCount = await manager.getRepository(ResourceGroup).count();
  if (groupCount === 0) {
    await ensureMinimalOperationalBaseline(manager);
  }

  const group = await manager.getRepository(ResourceGroup).findOne({
    where: { active: true },
    order: { id: 'ASC' },
  });
  if (!group) {
    throw new Error('Cannot prepare demo data because all existing groups are inactive. Activate a group or provide a clean baseline.');
  }

  let profile = await manager.getRepository(ResourceProfile).findOne({
    where: { groupId: group.id, active: true },
    order: { name: 'ASC', id: 'ASC' },
  });
  if (!profile) {
    const anyProfileCount = await manager.getRepository(ResourceProfile).count({ where: { groupId: group.id } });
    if (anyProfileCount > 0) {
      throw new Error(`Cannot prepare demo data because all profiles in group "${group.name}" are inactive.`);
    }
    profile = await manager.getRepository(ResourceProfile).save(
      manager.getRepository(ResourceProfile).create({
        name: 'Software Engineer',
        groupId: group.id,
        active: true,
      }),
    );
  }

  let initiativesCreated = 0;
  const primaryResult = await ensureDemoInitiative(
    manager,
    primaryDemoInitiativeId,
    options.primaryInitiativeCode,
    options.primaryInitiativeName,
  );
  if (primaryResult.created) initiativesCreated += 1;

  const secondaryResult = await ensureDemoInitiative(
    manager,
    secondaryDemoInitiativeId,
    options.secondaryInitiativeCode,
    options.secondaryInitiativeName,
  );
  if (secondaryResult.created) initiativesCreated += 1;

  const requester = await ensureDemoPerson(
    manager,
    'local-contributor',
    'demo-requester',
    'Demo Requester',
    'demo-requester@example.test',
    ResourceAllocationRole.User,
    group.id,
  );
  const peerAssignee = await ensureDemoPerson(
    manager,
    'local-moderator',
    'demo-specialist',
    'Demo Specialist',
    'demo-specialist@example.test',
    ResourceAllocationRole.Moderator,
    group.id,
  );

  const peopleRepo = manager.getRepository(ResourcePerson);
  const decider =
    (group.managerId ? await peopleRepo.findOne({ where: { id: group.managerId, active: true } }) : null) ??
    (group.supervisorId ? await peopleRepo.findOne({ where: { id: group.supervisorId, active: true } }) : null);
  if (!decider) {
    throw new Error(`Cannot prepare demo data because group "${group.name}" has no active Supervisor or Manager.`);
  }

  const admins = await peopleRepo.find({
    where: { role: ResourceAllocationRole.Admin, active: true },
    order: { id: 'ASC' },
  });
  const adminSnapshot = admins.length > 0 ? personSnapshot(admins[0]) : fallbackAdminSnapshot;

  const leaderRows = await manager.query(
    `SELECT DISTINCT person.id
     FROM resource_people AS person
     LEFT JOIN resource_groups AS team ON team.id = $1::uuid
     WHERE person.active = TRUE
       AND (
         (person.role = $2 AND person.group_id = $1::uuid)
         OR person.id = team.supervisor_id
         OR person.id = team.manager_id
       )
     ORDER BY person.id ASC`,
    [group.id, ResourceAllocationRole.Moderator],
  ) as Array<{ id: string }>;

  const clockRows = await manager.query(`
    WITH operation_clock AS (SELECT clock_timestamp() AS now)
    SELECT now, (now AT TIME ZONE 'America/Sao_Paulo')::date::text AS today
    FROM operation_clock
  `) as Array<{ now: Date | string; today: string }>;

  return {
    initiativesCreated,
    context: {
      group,
      profile,
      primaryInitiative: primaryResult.initiative,
      secondaryInitiative: secondaryResult.initiative,
      requester,
      peerAssignee,
      decider,
      adminSnapshot,
      adminIds: admins.map((admin) => admin.id),
      leaderIds: leaderRows.map((row) => row.id),
      now: new Date(clockRows[0].now),
      today: clockRows[0].today,
    },
  };
}

function buildDemoRequestSeeds(context: DemoContext): DemoRequestSeed[] {
  const primaryAssignee = context.requester.groupId === context.group.id ? context.requester : context.peerAssignee;
  return [
    {
      lineId: demoUuid('0200', 0),
      attemptKey: demoUuid('0300', 0),
      requestId: demoUuid('0400', 0),
      lineNumber: 0,
      decisionState: ResourceRequestDecisionState.WaitingForPresentation,
      requestedStartOffset: 14,
      requestedEndOffset: 44,
      requestedHours: 20,
      comment: 'Demo request awaiting initial presentation review by an Admin.',
    },
    {
      lineId: demoUuid('0200', 1),
      attemptKey: demoUuid('0300', 1),
      requestId: demoUuid('0400', 1),
      lineNumber: 1,
      decisionState: ResourceRequestDecisionState.PendingTeamDecision,
      requestedStartOffset: 10,
      requestedEndOffset: 40,
      requestedHours: 16,
      comment: 'Demo request referred to group leadership for team decision.',
    },
    {
      lineId: demoUuid('0200', 2),
      attemptKey: demoUuid('0300', 2),
      requestId: demoUuid('0400', 2),
      lineNumber: 2,
      decisionState: ResourceRequestDecisionState.ApprovedWithChanges,
      revalidationDecisionStage: 'PENDING_TEAM_DECISION',
      requestedStartOffset: 7,
      requestedEndOffset: 35,
      requestedHours: 20,
      comment: 'Demo request with proposed date/hours adjustment awaiting requester response.',
      approved: {
        assignee: context.peerAssignee,
        startOffset: 12,
        endOffset: 45,
        weeklyHours: 12,
        explanation: 'Adjusted start date and weekly hours to match team availability.',
      },
    },
    {
      lineId: demoUuid('0200', 3),
      attemptKey: demoUuid('0300', 3),
      requestId: demoUuid('0400', 3),
      lineNumber: 3,
      decisionState: ResourceRequestDecisionState.Approved,
      requestedStartOffset: -5,
      requestedEndOffset: 25,
      requestedHours: 20,
      comment: 'Demo request with active In Progress allocation.',
      approved: {
        assignee: primaryAssignee,
        startOffset: -5,
        endOffset: 25,
        weeklyHours: 20,
        allocation: { id: demoUuid('0500', 3), state: 'IN_PROGRESS' },
      },
    },
    {
      lineId: demoUuid('0200', 4),
      attemptKey: demoUuid('0300', 4),
      requestId: demoUuid('0400', 4),
      lineNumber: 4,
      decisionState: ResourceRequestDecisionState.Approved,
      requestedStartOffset: 10,
      requestedEndOffset: 45,
      requestedHours: 16,
      comment: 'Demo request with upcoming Not Started allocation.',
      approved: {
        assignee: primaryAssignee,
        startOffset: 10,
        endOffset: 45,
        weeklyHours: 16,
        allocation: { id: demoUuid('0500', 4), state: 'NOT_STARTED' },
      },
    },
    {
      lineId: demoUuid('0200', 5),
      attemptKey: demoUuid('0300', 5),
      requestId: demoUuid('0400', 5),
      lineNumber: 5,
      decisionState: ResourceRequestDecisionState.Approved,
      requestedStartOffset: -3,
      requestedEndOffset: 30,
      requestedHours: 8,
      comment: 'Demo request with temporarily Suspended allocation.',
      approved: {
        assignee: context.peerAssignee,
        startOffset: -3,
        endOffset: 30,
        weeklyHours: 8,
        allocation: {
          id: demoUuid('0500', 5),
          state: 'SUSPENDED',
          suspendReason: 'Paused while dependent upstream environment is provisioned.',
        },
      },
    },
    {
      lineId: demoUuid('0200', 6),
      attemptKey: demoUuid('0300', 6),
      requestId: demoUuid('0400', 6),
      lineNumber: 6,
      decisionState: ResourceRequestDecisionState.Approved,
      requestedStartOffset: -30,
      requestedEndOffset: -5,
      requestedHours: 12,
      comment: 'Demo request with completed Done allocation.',
      approved: {
        assignee: primaryAssignee,
        startOffset: -30,
        endOffset: -5,
        weeklyHours: 12,
        allocation: { id: demoUuid('0500', 6), state: 'DONE' },
      },
    },
    {
      lineId: demoUuid('0200', 7),
      attemptKey: demoUuid('0300', 7),
      requestId: demoUuid('0400', 7),
      lineNumber: 7,
      decisionState: ResourceRequestDecisionState.Denied,
      requestedStartOffset: 15,
      requestedEndOffset: 45,
      requestedHours: 24,
      comment: 'Demo request denied by team leadership awaiting requester decision.',
      denialReason: 'Requested specialist capacity is fully committed for the proposed sprint.',
    },
    {
      lineId: demoUuid('0200', 8),
      attemptKey: demoUuid('0300', 8),
      requestId: demoUuid('0400', 8),
      lineNumber: 8,
      decisionState: ResourceRequestDecisionState.PreN3,
      requestedStartOffset: 18,
      requestedEndOffset: 48,
      requestedHours: 20,
      comment: 'Demo request contested by requester and waiting in Pre N3 exception queue.',
      denialReason: 'Initial capacity check showed full allocation in current cycle.',
      contestReason: 'Initiative milestone cannot slip without partial specialist coverage.',
    },
    {
      lineId: demoUuid('0200', 9),
      attemptKey: demoUuid('0300', 9),
      requestId: demoUuid('0400', 9),
      lineNumber: 9,
      decisionState: ResourceRequestDecisionState.Escalation,
      requestedStartOffset: 20,
      requestedEndOffset: 50,
      requestedHours: 16,
      comment: 'Demo request escalated to Escalation stage for final resolution.',
      denialReason: 'Group leadership could not accommodate requested hours.',
      contestReason: 'Critical release dependency requires cross-team exception review.',
      escalationReason: 'Requires cross-group prioritization review.',
    },
    {
      lineId: demoUuid('0200', 10),
      attemptKey: demoUuid('0300', 10),
      requestId: demoUuid('0400', 10),
      lineNumber: 10,
      decisionState: ResourceRequestDecisionState.RequiresRevalidation,
      revalidationOriginState: ResourceRequestDecisionState.ApprovedWithChanges,
      revalidationDecisionStage: 'PENDING_TEAM_DECISION',
      requestedStartOffset: 5,
      requestedEndOffset: 30,
      requestedHours: 10,
      comment: 'Demo proposal requiring revalidation after proposed start date elapsed.',
      approved: {
        assignee: context.peerAssignee,
        startOffset: -2,
        endOffset: 20,
        weeklyHours: 10,
        explanation: 'Original proposal start date elapsed before confirmation.',
      },
    },
    {
      lineId: demoUuid('0200', 11),
      attemptKey: demoUuid('0300', 11),
      requestId: demoUuid('0400', 11),
      lineNumber: 11,
      decisionState: ResourceRequestDecisionState.Cancelled,
      requestedStartOffset: 25,
      requestedEndOffset: 55,
      requestedHours: 8,
      comment: 'Demo request cancelled by requester after denial.',
      denialReason: 'No specialist bandwidth available during target window.',
      cancelReason: 'Scope absorbed by existing team capacity.',
    },
  ];
}

function buildRequestHistoryEvents(
  seed: DemoRequestSeed,
  request: ResourceRequest,
  context: DemoContext,
): Array<Partial<ResourceRequestHistory>> {
  const requesterSnap = personSnapshot(context.requester);
  const deciderSnap = personSnapshot(context.decider);
  const baseSnapshot = {
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

  const events: Array<Partial<ResourceRequestHistory>> = [
    {
      requestId: request.id,
      actorSnapshot: requesterSnap,
      action: 'SUBMITTED',
      afterSnapshot: {
        requestId: request.id,
        decisionState: ResourceRequestDecisionState.WaitingForPresentation,
        requestedConditions: request.requestedConditions,
      },
      correlationId: demoCorrelation1,
      occurredAt: request.receivedAt,
    },
  ];

  if (seed.decisionState === ResourceRequestDecisionState.WaitingForPresentation) {
    return events;
  }

  events.push({
    requestId: request.id,
    actorSnapshot: context.adminSnapshot,
    action: 'REFERRED',
    afterSnapshot: {
      requestId: request.id,
      before: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.WaitingForPresentation, version: 1 },
      after: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.PendingTeamDecision, version: 2 },
    },
    correlationId: demoCorrelation1,
    occurredAt: shiftHours(request.receivedAt, 4),
  });

  if (seed.decisionState === ResourceRequestDecisionState.PendingTeamDecision) {
    return events;
  }

  if (seed.decisionState === ResourceRequestDecisionState.ApprovedWithChanges) {
    events.push({
      requestId: request.id,
      actorSnapshot: deciderSnap,
      action: 'APPROVAL_CHANGES_PROPOSED',
      afterSnapshot: {
        requestId: request.id,
        before: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.PendingTeamDecision, approvedConditions: null, version: 2 },
        after: baseSnapshot,
        requestedConditions: request.requestedConditions,
        approvedConditions: request.approvedConditions,
        dueAt: request.decisionResponseDueAt?.toISOString() ?? null,
        explanation: seed.approved?.explanation,
      },
      correlationId: demoCorrelation1,
      occurredAt: request.stageEnteredAt,
    });
    return events;
  }

  if (seed.decisionState === ResourceRequestDecisionState.RequiresRevalidation) {
    events.push({
      requestId: request.id,
      actorSnapshot: deciderSnap,
      action: 'APPROVAL_CHANGES_PROPOSED',
      afterSnapshot: {
        requestId: request.id,
        before: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.PendingTeamDecision, approvedConditions: null, version: 2 },
        after: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.ApprovedWithChanges, version: 3 },
        requestedConditions: request.requestedConditions,
        approvedConditions: request.approvedConditions,
        explanation: seed.approved?.explanation,
      },
      correlationId: demoCorrelation1,
      occurredAt: shiftHours(request.receivedAt, 12),
    });
    events.push({
      requestId: request.id,
      actorSnapshot: { personId: '00000000-0000-4000-8000-000000000000', displayName: 'Resource Allocation decision worker', role: 'SYSTEM' },
      action: 'PROPOSAL_REQUIRES_REVALIDATION',
      afterSnapshot: {
        requestId: request.id,
        before: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.ApprovedWithChanges, version: 3 },
        after: baseSnapshot,
        impediments: ['PROPOSED_START_DATE_PASSED'],
        previousProposal: request.approvedConditions,
      },
      correlationId: demoCorrelation1,
      occurredAt: request.stageEnteredAt,
    });
    return events;
  }

  if (seed.decisionState === ResourceRequestDecisionState.Approved && seed.approved?.allocation) {
    events.push({
      requestId: request.id,
      actorSnapshot: deciderSnap,
      action: 'APPROVED',
      afterSnapshot: {
        requestId: request.id,
        before: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.PendingTeamDecision, approvedConditions: null, version: 2 },
        after: baseSnapshot,
        requestedConditions: request.requestedConditions,
        approvedConditions: request.approvedConditions,
        allocationId: seed.approved.allocation.id,
      },
      correlationId: demoCorrelation1,
      occurredAt: shiftHours(request.receivedAt, 8),
    });
    return events;
  }

  events.push({
    requestId: request.id,
    actorSnapshot: deciderSnap,
    action: 'DENIED',
    afterSnapshot: {
      before: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.PendingTeamDecision, version: 2 },
      after: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.Denied, version: 3 },
      reason: seed.denialReason ?? 'Denied in demo dataset.',
    },
    correlationId: demoCorrelation1,
    occurredAt: shiftHours(request.receivedAt, 8),
  });

  if (seed.decisionState === ResourceRequestDecisionState.Denied) {
    return events;
  }

  if (seed.decisionState === ResourceRequestDecisionState.Cancelled) {
    events.push({
      requestId: request.id,
      actorSnapshot: requesterSnap,
      action: 'DENIAL_CANCELLED',
      afterSnapshot: {
        before: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.Denied, version: 3 },
        after: baseSnapshot,
        reason: seed.cancelReason ?? 'Cancelled in demo dataset.',
      },
      correlationId: demoCorrelation1,
      occurredAt: request.stageEnteredAt,
    });
    return events;
  }

  events.push({
    requestId: request.id,
    actorSnapshot: requesterSnap,
    action: 'CONTESTED',
    afterSnapshot: {
      before: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.Denied, version: 3 },
      after: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.PreN3, version: 4 },
      reason: seed.contestReason ?? 'Contested in demo dataset.',
    },
    correlationId: demoCorrelation1,
    occurredAt: shiftHours(request.receivedAt, 16),
  });

  if (seed.decisionState === ResourceRequestDecisionState.Escalation) {
    events.push({
      requestId: request.id,
      actorSnapshot: context.adminSnapshot,
      action: 'ESCALATED',
      afterSnapshot: {
        before: { ...baseSnapshot, decisionState: ResourceRequestDecisionState.PreN3, version: 4 },
        after: baseSnapshot,
        reason: seed.escalationReason ?? 'Escalated in demo dataset.',
      },
      correlationId: demoCorrelation1,
      occurredAt: request.stageEnteredAt,
    });
  }

  return events;
}

async function seedDemoNotifications(
  manager: EntityManager,
  seed: DemoRequestSeed,
  request: ResourceRequest,
  context: DemoContext,
): Promise<void> {
  const notices: Array<{
    recipientId: string;
    sourceRequestId: string;
    eventCode: string;
    title: string;
    message: string;
    createdAt: Date;
  }> = [];

  if (seed.decisionState === ResourceRequestDecisionState.WaitingForPresentation) {
    for (const adminId of context.adminIds) {
      if (adminId !== request.requesterId) {
        notices.push({
          recipientId: adminId,
          sourceRequestId: request.id,
          eventCode: 'REQUEST_SUBMITTED',
          title: 'New resource request',
          message: 'A resource request is waiting for presentation.',
          createdAt: request.receivedAt,
        });
      }
    }
  } else if (seed.decisionState === ResourceRequestDecisionState.PendingTeamDecision) {
    for (const leaderId of context.leaderIds) {
      if (leaderId !== request.requesterId) {
        notices.push({
          recipientId: leaderId,
          sourceRequestId: request.id,
          eventCode: `REQUEST_REFERRED_${request.version}`,
          title: 'Resource request referred to your group',
          message: 'A request is waiting for a decision from your group.',
          createdAt: request.stageEnteredAt,
        });
      }
    }
  } else if (seed.decisionState === ResourceRequestDecisionState.ApprovedWithChanges) {
    notices.push({
      recipientId: request.requesterId,
      sourceRequestId: request.id,
      eventCode: `REQUEST_CHANGES_PROPOSED_${request.version}`,
      title: 'Resource request proposal needs your response',
      message: 'A decision maker proposed updated dates and weekly hours for your request.',
      createdAt: request.stageEnteredAt,
    });
  } else if (seed.decisionState === ResourceRequestDecisionState.Denied) {
    notices.push({
      recipientId: request.requesterId,
      sourceRequestId: request.id,
      eventCode: `REQUEST_DENIED_${request.version}`,
      title: 'Resource request denied',
      message: 'A decision maker denied your resource request. Review the explanation in the request history.',
      createdAt: request.stageEnteredAt,
    });
  } else if (seed.decisionState === ResourceRequestDecisionState.PreN3) {
    for (const adminId of context.adminIds) {
      if (adminId !== request.requesterId) {
        notices.push({
          recipientId: adminId,
          sourceRequestId: request.id,
          eventCode: `REQUEST_CONTESTED_${request.version}`,
          title: 'Resource request contested',
          message: 'A requester contested a denied request. Review it in the Pre N3 queue.',
          createdAt: request.stageEnteredAt,
        });
      }
    }
  } else if (seed.decisionState === ResourceRequestDecisionState.Escalation) {
    for (const adminId of context.adminIds) {
      if (adminId !== request.requesterId) {
        notices.push({
          recipientId: adminId,
          sourceRequestId: request.id,
          eventCode: `REQUEST_EXCEPTION_ESCALATED_${request.version}`,
          title: 'Resource request escalated',
          message: 'A contested resource request was explicitly escalated for resolution.',
          createdAt: request.stageEnteredAt,
        });
      }
    }
  } else if (seed.decisionState === ResourceRequestDecisionState.RequiresRevalidation) {
    const recipients = new Set([request.requesterId, ...context.adminIds, ...context.leaderIds]);
    for (const recipientId of recipients) {
      notices.push({
        recipientId,
        sourceRequestId: request.id,
        eventCode: `REQUEST_REVALIDATION_REQUIRED_${request.version}`,
        title: 'Resource request needs revalidation',
        message: 'The proposed request dates or references require revalidation before confirmation.',
        createdAt: request.stageEnteredAt,
      });
    }
  }

  if (notices.length === 0) return;
  await manager
    .getRepository(ResourceAllocationNotification)
    .createQueryBuilder()
    .insert()
    .into(ResourceAllocationNotification)
    .values(notices)
    .orIgnore()
    .execute();
}

async function seedAllocationForDemoRequest(
  manager: EntityManager,
  seed: DemoRequestSeed,
  request: ResourceRequest,
  context: DemoContext,
): Promise<boolean> {
  const allocationConfig = seed.approved?.allocation;
  if (!seed.approved || !allocationConfig) return false;

  const allocationRepo = manager.getRepository(ResourceAllocation);
  const existing = await allocationRepo
    .createQueryBuilder('allocation')
    .where('allocation.id = :id OR allocation.source_request_id = :sourceRequestId', {
      id: allocationConfig.id,
      sourceRequestId: request.id,
    })
    .getOne();
  if (existing) return false;

  const startDate = addDaysToIsoDate(context.today, seed.approved.startOffset);
  const endDate = addDaysToIsoDate(context.today, seed.approved.endOffset);
  const approvedAt = shiftHours(request.receivedAt, 8);
  const version = allocationConfig.state === 'IN_PROGRESS' || allocationConfig.state === 'NOT_STARTED' ? 1 : 2;

  const allocation = await allocationRepo.save(
    allocationRepo.create({
      id: allocationConfig.id,
      sourceRequestId: request.id,
      personId: seed.approved.assignee.id,
      personSnapshot: personSnapshot(seed.approved.assignee),
      groupId: context.group.id,
      groupSnapshot: { id: context.group.id, name: context.group.name },
      initiativeId: context.primaryInitiative.id,
      initiativeSnapshot: {
        id: context.primaryInitiative.id,
        code: context.primaryInitiative.code,
        name: context.primaryInitiative.name,
      },
      resourceProfileId: context.profile.id,
      resourceProfileSnapshot: { id: context.profile.id, name: context.profile.name },
      approvedStartDate: startDate,
      approvedEndDate: endDate,
      effectiveStartDate: startDate,
      effectiveEndDate: endDate,
      weeklyHours: seed.approved.weeklyHours.toFixed(1),
      state: allocationConfig.state,
      stateEnteredAt: request.stageEnteredAt,
      approvedAt,
      version,
    }),
  );

  if (allocationConfig.state === 'SUSPENDED' || allocationConfig.state === 'DONE') {
    const historyRepo = manager.getRepository(ResourceAllocationHistory);
    const baseSnapshot = {
      id: allocation.id,
      requestId: request.id,
      person: { personId: seed.approved.assignee.id, displayName: seed.approved.assignee.displayName },
      group: { id: context.group.id, name: context.group.name },
      initiative: {
        id: context.primaryInitiative.id,
        code: context.primaryInitiative.code,
        name: context.primaryInitiative.name,
      },
      resourceProfile: { id: context.profile.id, name: context.profile.name },
      startDate,
      endDate,
      approvedPeriod: { startDate, endDate },
      weeklyHours: seed.approved.weeklyHours,
      approvedAt: approvedAt.toISOString(),
    };
    await historyRepo.insert({
      allocationId: allocation.id,
      actorSnapshot:
        allocationConfig.state === 'SUSPENDED'
          ? personSnapshot(context.decider)
          : { displayName: 'Resource Allocation lifecycle worker', role: 'SYSTEM' },
      action: allocationConfig.state === 'SUSPENDED' ? 'ALLOCATION_SUSPENDED_SUSPENDED' : 'ALLOCATION_ENDED',
      reason:
        allocationConfig.suspendReason ?? 'Automatically completed after its inclusive end date.',
      beforeSnapshot: { ...baseSnapshot, state: 'IN_PROGRESS', version: 1 },
      afterSnapshot: { ...baseSnapshot, state: allocationConfig.state, version: 2 },
      correlationId: demoCorrelation1,
      occurredAt: request.stageEnteredAt,
    });
  } else {
    const historyRepo = manager.getRepository(ResourceAllocationHistory);
    await historyRepo.insert({
      allocationId: allocation.id,
      actorSnapshot: personSnapshot(context.decider),
      action: allocationConfig.state === 'IN_PROGRESS' ? 'ALLOCATION_STARTED' : 'ALLOCATION_CREATED',
      reason: null,
      beforeSnapshot: { state: allocationConfig.state, version: 1 },
      afterSnapshot: { state: allocationConfig.state, version: 1 },
      correlationId: demoCorrelation1,
      occurredAt: approvedAt,
    });
  }

  return true;
}

export async function prepareDemoData(
  dataSource: DataSource,
  options: PrepareDemoDataOptions = {},
): Promise<PrepareDemoDataResult> {
  const normalizedOptions = normalizeDemoOptions(options);
  return dataSource.transaction(async (manager) => {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext('pmo.resource-allocation.demo-data'))");
    await lockResourceAllocationAdministrationWrites(manager);

    const { context, initiativesCreated } = await resolveDemoContext(manager, normalizedOptions);
    const seeds = buildDemoRequestSeeds(context);

    let submissionsCreated = 0;
    let requestsCreated = 0;
    let allocationsCreated = 0;
    let failedLinesCreated = 0;

    const submissionRepo = manager.getRepository(ResourceSubmission);
    let submission1 = await submissionRepo.findOne({ where: { id: demoSubmission1Id } });
    if (!submission1) {
      submission1 = await submissionRepo.save(
        submissionRepo.create({
          id: demoSubmission1Id,
          requesterId: context.requester.id,
          category: ResourceRequestCategory.ExecutionProject,
          lineCount: seeds.length,
          correlationId: demoCorrelation1,
          receivedAt: shiftHours(context.now, -72),
        }),
      );
      submissionsCreated += 1;
    }

    const lineRepo = manager.getRepository(ResourceSubmissionLine);
    const entryRepo = manager.getRepository(ResourceSubmissionEntry);
    const requestRepo = manager.getRepository(ResourceRequest);
    const requestHistoryRepo = manager.getRepository(ResourceRequestHistory);

    for (const seed of seeds) {
      const existingLine = await lineRepo
        .createQueryBuilder('line')
        .where('line.id = :id OR (line.requester_id = :requesterId AND line.attempt_key = :attemptKey)', {
          id: seed.lineId,
          requesterId: context.requester.id,
          attemptKey: seed.attemptKey,
        })
        .getOne();
      if (existingLine) continue;

      const startDate = addDaysToIsoDate(context.today, seed.requestedStartOffset);
      const endDate = addDaysToIsoDate(context.today, seed.requestedEndOffset);
      const submittedConditions = {
        initiativeId: context.primaryInitiative.id,
        category: ResourceRequestCategory.ExecutionProject,
        attemptKey: seed.attemptKey,
        groupId: context.group.id,
        resourceProfileId: context.profile.id,
        startDate,
        endDate,
        weeklyHours: seed.requestedHours,
        comment: seed.comment,
      };
      const receivedAt = shiftHours(context.now, -48 + seed.lineNumber);
      const line = await lineRepo.save(
        lineRepo.create({
          id: seed.lineId,
          submissionId: submission1.id,
          requesterId: context.requester.id,
          attemptKey: seed.attemptKey,
          attemptPayloadHash: hashConditions(submittedConditions),
          lineNumber: seed.lineNumber,
          submittedConditions,
          status: ResourceSubmissionLineStatus.Received,
          requestId: null,
          problem: null,
          requestOutcome: null,
          claimToken: null,
          claimedAt: null,
          processingAttempts: 1,
          receivedAt,
          completedAt: null,
        }),
      );
      await entryRepo.insert({
        submissionId: submission1.id,
        lineId: line.id,
        lineNumber: seed.lineNumber,
      });

      const existingRequest = await requestRepo
        .createQueryBuilder('request')
        .where('request.id = :id OR request.submission_line_id = :lineId', {
          id: seed.requestId,
          lineId: line.id,
        })
        .getOne();

      let request: ResourceRequest;
      if (existingRequest) {
        request = existingRequest;
      } else {
        const requestedConditions = {
          initiativeId: context.primaryInitiative.id,
          initiativeCode: context.primaryInitiative.code,
          initiativeName: context.primaryInitiative.name,
          category: ResourceRequestCategory.ExecutionProject,
          groupId: context.group.id,
          groupName: context.group.name,
          resourceProfileId: context.profile.id,
          resourceProfileName: context.profile.name,
          startDate,
          endDate,
          weeklyHours: seed.requestedHours,
          comment: seed.comment,
        };
        const approvedConditions = seed.approved
          ? {
              personId: seed.approved.assignee.id,
              personName: seed.approved.assignee.displayName,
              resourceProfileId: context.profile.id,
              resourceProfileName: context.profile.name,
              groupId: context.group.id,
              groupName: context.group.name,
              initiativeId: context.primaryInitiative.id,
              initiativeCode: context.primaryInitiative.code,
              initiativeName: context.primaryInitiative.name,
              startDate: addDaysToIsoDate(context.today, seed.approved.startOffset),
              endDate: addDaysToIsoDate(context.today, seed.approved.endOffset),
              weeklyHours: seed.approved.weeklyHours,
              ...(seed.decisionState === ResourceRequestDecisionState.ApprovedWithChanges ||
              seed.decisionState === ResourceRequestDecisionState.RequiresRevalidation
                ? { decidedByPersonId: context.decider.id }
                : {}),
              ...(seed.approved.explanation ? { explanation: seed.approved.explanation } : {}),
            }
          : null;

        const stageEnteredAt =
          seed.decisionState === ResourceRequestDecisionState.WaitingForPresentation
            ? receivedAt
            : shiftHours(receivedAt, 20);
        const expirationDueAt =
          seed.decisionState === ResourceRequestDecisionState.Denied
            ? shiftHours(stageEnteredAt, 14 * 24)
            : shiftHours(receivedAt, 21 * 24);
        const decisionResponseDueAt =
          seed.decisionState === ResourceRequestDecisionState.ApprovedWithChanges
            ? shiftHours(context.now, 48)
            : null;
        const version =
          seed.decisionState === ResourceRequestDecisionState.WaitingForPresentation
            ? 1
            : seed.decisionState === ResourceRequestDecisionState.PendingTeamDecision
              ? 2
              : seed.decisionState === ResourceRequestDecisionState.PreN3 ||
                  seed.decisionState === ResourceRequestDecisionState.RequiresRevalidation ||
                  seed.decisionState === ResourceRequestDecisionState.Cancelled
                ? 4
                : seed.decisionState === ResourceRequestDecisionState.Escalation
                  ? 5
                  : 3;

        request = await requestRepo.save(
          requestRepo.create({
            id: seed.requestId,
            submissionLineId: line.id,
            requesterId: context.requester.id,
            requesterSnapshot: personSnapshot(context.requester),
            requestedConditions,
            approvedConditions,
            decisionState: seed.decisionState,
            revalidationOriginState: seed.revalidationOriginState ?? null,
            revalidationDecisionStage: seed.revalidationDecisionStage ?? null,
            receivedAt,
            stageEnteredAt,
            expirationDueAt,
            decisionResponseDueAt,
            version,
          }),
        );
        requestsCreated += 1;
        await markInitiativeUsedForRequest(manager, context.primaryInitiative.id);
        const historyEvents = buildRequestHistoryEvents(seed, request, context);
        await requestHistoryRepo.save(historyEvents.map((event) => requestHistoryRepo.create(event)));
        await seedDemoNotifications(manager, seed, request, context);
      }

      await lineRepo.update(
        { id: line.id },
        {
          status: ResourceSubmissionLineStatus.Succeeded,
          requestId: request.id,
          requestOutcome: {
            decisionState: request.decisionState,
            requestedConditions: request.requestedConditions,
          },
          completedAt: request.receivedAt,
        },
      );

      if (await seedAllocationForDemoRequest(manager, seed, request, context)) {
        allocationsCreated += 1;
      }
    }

    // Separate POC_BBP submission containing an illustrative definitive line failure for recovery UI demo.
    let submission2 = await submissionRepo.findOne({ where: { id: demoSubmission2Id } });
    if (!submission2) {
      submission2 = await submissionRepo.save(
        submissionRepo.create({
          id: demoSubmission2Id,
          requesterId: context.requester.id,
          category: ResourceRequestCategory.PocBbp,
          lineCount: 1,
          correlationId: demoCorrelation2,
          receivedAt: shiftHours(context.now, -24),
        }),
      );
      submissionsCreated += 1;
    }

    const existingFailedLine = await lineRepo
      .createQueryBuilder('line')
      .where('line.id = :id OR (line.requester_id = :requesterId AND line.attempt_key = :attemptKey)', {
        id: demoFailedLineId,
        requesterId: context.requester.id,
        attemptKey: demoFailedAttemptKey,
      })
      .getOne();
    if (!existingFailedLine) {
      const failedStart = addDaysToIsoDate(context.today, -3);
      const failedEnd = addDaysToIsoDate(context.today, 10);
      const failedConditions = {
        initiativeId: context.primaryInitiative.id,
        category: ResourceRequestCategory.PocBbp,
        attemptKey: demoFailedAttemptKey,
        groupId: context.group.id,
        resourceProfileId: context.profile.id,
        startDate: failedStart,
        endDate: failedEnd,
        weeklyHours: 10,
        comment: 'Demo submission line rejected for past start date so recovery can be tested.',
      };
      const failedAt = shiftHours(context.now, -23);
      const failedLine = await lineRepo.save(
        lineRepo.create({
          id: demoFailedLineId,
          submissionId: submission2.id,
          requesterId: context.requester.id,
          attemptKey: demoFailedAttemptKey,
          attemptPayloadHash: hashConditions(failedConditions),
          lineNumber: 0,
          submittedConditions: failedConditions,
          status: ResourceSubmissionLineStatus.Failed,
          requestId: null,
          problem: {
            code: 'INVALID_BUSINESS_DATE',
            message:
              'The request dates must be valid, start today or later, and end on or after the start date. Review the dates and submit a corrected attempt.',
          },
          requestOutcome: null,
          claimToken: null,
          claimedAt: null,
          processingAttempts: 1,
          receivedAt: submission2.receivedAt,
          completedAt: failedAt,
        }),
      );
      await entryRepo.insert({
        submissionId: submission2.id,
        lineId: failedLine.id,
        lineNumber: 0,
      });
      failedLinesCreated += 1;
    }

    return {
      initiativesCreated,
      submissionsCreated,
      requestsCreated,
      allocationsCreated,
      failedLinesCreated,
    };
  });
}

async function run(): Promise<void> {
  const { ResourceAllocationDataSource } = await import('./data-source');
  const options = readDemoDataOptionsFromEnv();
  normalizeDemoOptions(options);

  await ResourceAllocationDataSource.initialize();
  try {
    const result = await prepareDemoData(ResourceAllocationDataSource, options);
    const totalCreated =
      result.initiativesCreated +
      result.submissionsCreated +
      result.requestsCreated +
      result.allocationsCreated +
      result.failedLinesCreated;
    if (totalCreated === 0) {
      console.log('Tech Resource Allocation demo dataset already exists; no records were changed.');
    } else {
      console.log(
        `Prepared optional Tech Resource Allocation demo dataset (initiatives: ${result.initiativesCreated}, submissions: ${result.submissionsCreated}, requests: ${result.requestsCreated}, allocations: ${result.allocationsCreated}, failed lines: ${result.failedLinesCreated}).`,
      );
    }
  } finally {
    await ResourceAllocationDataSource.destroy();
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Demo data preparation failed.');
    process.exitCode = 1;
  });
}
