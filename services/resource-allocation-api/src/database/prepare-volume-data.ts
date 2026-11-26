import { createHash } from 'node:crypto';
import { DataSource, type EntityManager, type EntityTarget, type ObjectLiteral } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { ResourceAllocationHistory } from '../allocations/resource-allocation-history.entity';
import { ResourceAllocation } from '../allocations/resource-allocation.entity';
import { addDays, mondayOf } from '../capacities/capacity-comparison';
import { ResourceCapacityHistory } from '../capacities/resource-capacity-history.entity';
import { ResourceCapacity } from '../capacities/resource-capacity.entity';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourceAllocationNotification } from '../notifications/resource-allocation-notification.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePersonClassification } from '../people/resource-person-classification';
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

export interface PrepareVolumeDataOptions {
  people?: number;
  groups?: number;
  months?: number;
  seed?: string;
}

export interface NormalizedVolumeDataOptions {
  people: number;
  groups: number;
  months: number;
  seed: string;
}

/** Stable identities and names a measurement runner can use to sign in and find work items. */
export interface VolumeDataIdentities {
  adminLocalUserId: string;
  leadershipLocalUserId: string;
  leadershipRole: ResourceAllocationRole;
  leadershipGroupNames: string[];
  moderatorLocalUserId: string;
  userLocalUserId: string;
  userGroupName: string;
  groupNamePrefix: string;
  initiativeCodePrefix: string;
  localUserIdPrefix: string;
}

export interface VolumeDataCounts {
  people: number;
  groups: number;
  profiles: number;
  initiatives: number;
  capacities: number;
  submissions: number;
  requests: number;
  requestHistory: number;
  allocations: number;
  allocationHistory: number;
  notifications: number;
}

export interface PrepareVolumeDataResult {
  options: NormalizedVolumeDataOptions;
  businessDate: string;
  counts: VolumeDataCounts;
  peopleByRole: Record<string, number>;
  requestsByState: Record<string, number>;
  allocationsByState: Record<string, number>;
  allocationsByOrigin: Record<string, number>;
  /** Requests an Admin can approve from the presentation queue. */
  presentationApprovable: number;
  /** Requests the leadership identity can approve from the group decision queue. */
  leadershipTeamDecisionApprovable: number;
  identities: VolumeDataIdentities;
}

export class VolumeDataAlreadyPreparedError extends Error {
  constructor() {
    super(
      'A Tech Resource Allocation volume dataset already exists (volume-* people, "Volume Group" groups or ITDM-VOL-* initiatives). No records were changed. Use a newly migrated database to generate it again.',
    );
    this.name = 'VolumeDataAlreadyPreparedError';
  }
}

export const volumeLocalUserIdPrefix = 'volume-';
export const volumeGroupNamePrefix = 'Volume Group ';
export const volumeInitiativeCodePrefix = 'ITDM-VOL-';

export const defaultVolumeDataOptions: NormalizedVolumeDataOptions = {
  people: 336,
  groups: 30,
  months: 12,
  seed: 'pmo-hub-volume',
};

const groupsPerManager = 10;
const groupsPerSupervisor = 5;
const profilesPerGroup = 3;
const futureHorizonDays = 75;
const waitingPerGroup = 3;
const pendingTeamDecisionPerGroup = 3;
const insertChunkSize = 400;

const profileNamePool = [
  'Software Engineer',
  'Solutions Architect',
  'QA Analyst',
  'Data Engineer',
  'DevOps Engineer',
  'Business Analyst',
  'UX Designer',
  'Security Engineer',
];

const initiativeThemes = [
  'Cloud Modernization',
  'Platform Reliability',
  'Data Platform',
  'Customer Portal',
  'ERP Upgrade',
  'Identity Services',
  'Analytics Insights',
  'Network Refresh',
  'Mobile Experience',
  'Integration Hub',
];

const operationalActivities = [
  { category: 'ROUTINE_SUPPORT', weight: 2, comments: ['Production support rotation.', 'Incident triage and service desk escalations.', 'Monthly patching and environment upkeep.'] },
  { category: 'TRAINING', weight: 1, comments: ['Cloud certification preparation.', 'Internal security awareness training.', 'Onboarding on the new delivery toolchain.'] },
  { category: 'INTERNAL_ACTIVITIES', weight: 1, comments: ['Team rituals and internal planning.', 'Architecture community of practice.', 'Recruiting interviews for the group.'] },
] as const;

const requestCategories = Object.values(ResourceRequestCategory);

const suspensionReasons = [
  'Paused while the dependent environment is provisioned.',
  'Waiting for business validation before continuing.',
  'Vendor dependency blocked the planned work.',
];

const reservationReasons = [
  'Capacity reserved while the initiative confirms its start.',
  'Held for the next release window.',
];

const cancellationReasons = [
  'Initiative scope was reduced.',
  'Work absorbed by another group.',
];

type Row<T extends ObjectLiteral> = Partial<T>;
type ActorSnapshot = Record<string, unknown>;

interface PersonSeed {
  id: string;
  localUserId: string;
  displayName: string;
  email: string;
  role: ResourceAllocationRole;
  classification: ResourcePersonClassification | null;
  groupId: string | null;
  coveredGroupIds: string[];
}

interface ProfileSeed {
  id: string;
  name: string;
  groupId: string;
}

interface InitiativeSeed {
  id: string;
  code: string;
  name: string;
}

interface GroupSeed {
  index: number;
  id: string;
  name: string;
  supervisor: PersonSeed;
  manager: PersonSeed;
  moderator: PersonSeed;
  users: PersonSeed[];
  members: PersonSeed[];
  profiles: ProfileSeed[];
}

interface RequestSeedInput {
  group: GroupSeed;
  requester: PersonSeed;
  profile: ProfileSeed;
  initiative: InitiativeSeed;
  category: ResourceRequestCategory;
  startDate: string;
  endDate: string;
  weeklyHours: number;
  comment: string;
  receivedAt: Date;
}

interface RequestState {
  decisionState: ResourceRequestDecisionState;
  version: number;
  stageEnteredAt: Date;
  expirationDueAt: Date;
  decisionResponseDueAt: Date | null;
  approvedConditions: Record<string, unknown> | null;
  revalidationOriginState: string | null;
  revalidationDecisionStage: string | null;
  events: Array<{ actor: ActorSnapshot; action: string; occurredAt: Date; details: Record<string, unknown> }>;
  notices: Array<{ recipientIds: string[]; eventCode: string; title: string; message: string; createdAt: Date }>;
}

interface AllocationSeedInput {
  origin: 'REQUEST' | 'SELF' | 'DIRECT';
  sourceRequestId: string | null;
  category: string;
  comment: string | null;
  person: PersonSeed;
  group: GroupSeed;
  profile: ProfileSeed | null;
  initiative: InitiativeSeed | null;
  startDate: string;
  endDate: string;
  weeklyHours: number;
  approvedDay: string;
  approvedAt: Date;
  createdBy: PersonSeed | null;
}

/** Small deterministic PRNG (mulberry32) seeded from the configured volume seed. */
class SeededRandom {
  private state: number;

  constructor(seed: string) {
    this.state = createHash('sha256').update(`pmo-hub-volume-random:${seed}`).digest().readUInt32LE(0);
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  /** Weekly hours with one decimal place, given as tenths of an hour. */
  hours(minTenths: number, maxTenths: number): number {
    return this.int(minTenths, maxTenths) / 10;
  }
}

function leadershipCount(groups: number, groupsPerLeader: number): number {
  return Math.ceil(groups / groupsPerLeader);
}

export function minimumVolumePeople(groups: number): number {
  return 1 + leadershipCount(groups, groupsPerManager) + leadershipCount(groups, groupsPerSupervisor) + groups * 2;
}

function requireInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function normalizeVolumeDataOptions(options: PrepareVolumeDataOptions = {}): NormalizedVolumeDataOptions {
  const groups = requireInteger(options.groups ?? defaultVolumeDataOptions.groups, 'Volume group count', 1, 200);
  const months = requireInteger(options.months ?? defaultVolumeDataOptions.months, 'Volume month count', 1, 36);
  const people = requireInteger(
    options.people ?? defaultVolumeDataOptions.people,
    `Volume people count for ${groups} group(s)`,
    minimumVolumePeople(groups),
    20_000,
  );
  const seed = String(options.seed ?? defaultVolumeDataOptions.seed).trim();
  if (!seed || seed.length > 100) {
    throw new Error('Volume seed must contain 1 to 100 characters.');
  }
  return { people, groups, months, seed };
}

export function readVolumeDataOptionsFromEnv(
  environment: Record<string, string | undefined> = process.env,
): PrepareVolumeDataOptions {
  const readWholeNumber = (name: string): number | undefined => {
    const raw = environment[name]?.trim();
    if (raw === undefined || raw === '') return undefined;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number.`);
    return Number(raw);
  };
  const people = readWholeNumber('RESOURCE_ALLOCATION_VOLUME_PEOPLE');
  const groups = readWholeNumber('RESOURCE_ALLOCATION_VOLUME_GROUPS');
  const months = readWholeNumber('RESOURCE_ALLOCATION_VOLUME_MONTHS');
  const seed = environment.RESOURCE_ALLOCATION_VOLUME_SEED;
  return {
    ...(people !== undefined ? { people } : {}),
    ...(groups !== undefined ? { groups } : {}),
    ...(months !== undefined ? { months } : {}),
    ...(seed !== undefined && seed.trim() !== '' ? { seed } : {}),
  };
}

function padNumber(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function addMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function daysBetween(startDate: string, endDate: string): number {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
}

/** América/São Paulo has kept a fixed UTC-03:00 offset since 2019. */
function saoPauloTime(isoDate: string, hour: number, minute = 0): Date {
  return new Date(`${isoDate}T${padNumber(hour, 2)}:${padNumber(minute, 2)}:00.000-03:00`);
}

function shiftHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

function laterOf(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function minIsoDate(left: string, right: string): string {
  return left <= right ? left : right;
}

function maxIsoDate(left: string, right: string): string {
  return left >= right ? left : right;
}

function snapshotOf(person: PersonSeed): ActorSnapshot {
  return { personId: person.id, displayName: person.displayName, role: person.role };
}

const systemDecisionWorker: ActorSnapshot = {
  personId: '00000000-0000-4000-8000-000000000000',
  displayName: 'Resource Allocation decision worker',
  role: 'SYSTEM',
};
const lifecycleWorker: ActorSnapshot = { displayName: 'Resource Allocation lifecycle worker', role: 'SYSTEM' };

class VolumeDatasetBuilder {
  readonly random: SeededRandom;
  readonly people: PersonSeed[] = [];
  readonly groups: GroupSeed[] = [];
  readonly initiatives: InitiativeSeed[] = [];
  readonly admin: PersonSeed;
  readonly managers: PersonSeed[] = [];
  readonly supervisors: PersonSeed[] = [];

  readonly capacityRows: Array<Row<ResourceCapacity>> = [];
  readonly capacityHistoryRows: Array<Row<ResourceCapacityHistory>> = [];
  readonly submissionRows: Array<Row<ResourceSubmission>> = [];
  readonly lineRows: Array<Row<ResourceSubmissionLine>> = [];
  readonly entryRows: Array<Row<ResourceSubmissionEntry>> = [];
  readonly requestRows: Array<Row<ResourceRequest>> = [];
  readonly requestHistoryRows: Array<Row<ResourceRequestHistory>> = [];
  readonly allocationRows: Array<Row<ResourceAllocation>> = [];
  readonly allocationHistoryRows: Array<Row<ResourceAllocationHistory>> = [];
  readonly notificationRows: Array<Row<ResourceAllocationNotification>> = [];
  readonly usedInitiativeIds = new Set<string>();

  private readonly counters = new Map<string, number>();
  private readonly anchor: Date;
  private readonly windowStart: string;
  private readonly horizon: string;
  private readonly allAdminIds: string[];

  constructor(
    readonly options: NormalizedVolumeDataOptions,
    readonly today: string,
    existingAdminIds: string[],
  ) {
    this.random = new SeededRandom(options.seed);
    this.anchor = saoPauloTime(today, 0);
    this.windowStart = addMonths(today, -options.months);
    this.horizon = addDays(today, futureHorizonDays);
    this.admin = this.createPerson('admin', 'volume-admin', 'Volume Admin', ResourceAllocationRole.Admin, null, null);
    this.allAdminIds = [...new Set([...existingAdminIds, this.admin.id])];
  }

  /** Deterministic UUID derived from the seed, a record kind, and its ordinal. */
  uuid(kind: string): string {
    const index = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, index);
    const hex = createHash('sha256').update(`${this.options.seed}\u0000${kind}\u0000${index}`).digest('hex');
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  build(): void {
    this.buildPeopleAndGroups();
    this.buildInitiatives();
    this.buildCapacities();
    for (const group of this.groups) {
      for (const member of group.members) {
        this.buildProjectTrack(group, member);
        this.buildOperationalTrack(group, member);
        this.buildVacations(group, member);
      }
      this.buildCancelledHistory(group);
      this.buildOpenRequests(group);
    }
  }

  private createPerson(
    kind: string,
    localUserId: string,
    displayName: string,
    role: ResourceAllocationRole,
    groupId: string | null,
    classification: ResourcePersonClassification | null,
  ): PersonSeed {
    const person: PersonSeed = {
      id: this.uuid(`person:${kind}`),
      localUserId,
      displayName,
      email: `${localUserId}@example.test`,
      role,
      classification,
      groupId,
      coveredGroupIds: [],
    };
    this.people.push(person);
    return person;
  }

  private memberClassification(): ResourcePersonClassification | null {
    const roll = this.random.next();
    if (roll < 0.03) return null;
    return roll < 0.75 ? ResourcePersonClassification.Internal : ResourcePersonClassification.ThirdParty;
  }

  private buildPeopleAndGroups(): void {
    const { groups: groupCount, people } = this.options;
    const groupWidth = Math.max(2, String(groupCount).length);
    const managerCount = leadershipCount(groupCount, groupsPerManager);
    const supervisorCount = leadershipCount(groupCount, groupsPerSupervisor);
    for (let index = 1; index <= managerCount; index += 1) {
      const suffix = padNumber(index, 2);
      this.managers.push(this.createPerson('manager', `volume-manager-${suffix}`, `Volume Manager ${suffix}`, ResourceAllocationRole.Manager, null, null));
    }
    for (let index = 1; index <= supervisorCount; index += 1) {
      const suffix = padNumber(index, 2);
      this.supervisors.push(this.createPerson('supervisor', `volume-supervisor-${suffix}`, `Volume Supervisor ${suffix}`, ResourceAllocationRole.Supervisor, null, null));
    }

    const profileOffset = this.random.int(0, profileNamePool.length - 1);
    for (let index = 0; index < groupCount; index += 1) {
      const suffix = padNumber(index + 1, groupWidth);
      const id = this.uuid('group');
      const supervisor = this.supervisors[Math.floor(index / groupsPerSupervisor)];
      const manager = this.managers[Math.floor(index / groupsPerManager)];
      supervisor.coveredGroupIds.push(id);
      manager.coveredGroupIds.push(id);
      const moderator = this.createPerson(
        'moderator',
        `volume-moderator-${suffix}`,
        `Volume Moderator ${suffix}`,
        ResourceAllocationRole.Moderator,
        id,
        this.memberClassification(),
      );
      const profiles = Array.from({ length: profilesPerGroup }, (_, profileIndex) => ({
        id: this.uuid('profile'),
        name: profileNamePool[(profileOffset + index + profileIndex * 3) % profileNamePool.length],
        groupId: id,
      }));
      this.groups.push({
        index,
        id,
        name: `${volumeGroupNamePrefix}${suffix}`,
        supervisor,
        manager,
        moderator,
        users: [],
        members: [moderator],
        profiles,
      });
    }

    const userCount = people - 1 - managerCount - supervisorCount - groupCount;
    const userWidth = Math.max(4, String(userCount).length);
    for (let index = 0; index < userCount; index += 1) {
      const group = this.groups[index % groupCount];
      const suffix = padNumber(index + 1, userWidth);
      const user = this.createPerson(
        'user',
        `volume-user-${suffix}`,
        `Volume User ${suffix}`,
        ResourceAllocationRole.User,
        group.id,
        this.memberClassification(),
      );
      group.users.push(user);
      group.members.push(user);
    }
  }

  private buildInitiatives(): void {
    const count = Math.max(4, this.options.groups * 2);
    const width = Math.max(3, String(count).length);
    for (let index = 1; index <= count; index += 1) {
      const suffix = padNumber(index, width);
      this.initiatives.push({
        id: this.uuid('initiative'),
        code: `${volumeInitiativeCodePrefix}${suffix}`,
        name: `${initiativeThemes[(index - 1) % initiativeThemes.length]} ${suffix}`,
      });
    }
  }

  private buildCapacities(): void {
    const midWindow = addMonths(this.today, -Math.max(1, Math.floor(this.options.months / 2)));
    const futureChange = addDays(mondayOf(this.today), 28);
    for (const group of this.groups) {
      for (const classification of [ResourcePersonClassification.Internal, ResourcePersonClassification.ThirdParty]) {
        const headcount = group.members.filter((member) => member.classification === classification).length;
        if (headcount === 0 && classification === ResourcePersonClassification.ThirdParty) continue;
        for (const profile of group.profiles) {
          const baseFte = Math.max(0.5, Math.round((headcount / profilesPerGroup) * (0.8 + this.random.next() * 0.4) * 10) / 10);
          const effectiveDates: Array<{ date: string; fte: number }> = [{ date: this.windowStart, fte: baseFte }];
          if (midWindow > this.windowStart && this.random.chance(0.5)) {
            effectiveDates.push({ date: midWindow, fte: Math.max(0, Math.round((baseFte + this.random.int(-5, 5) / 10) * 10) / 10) });
          }
          if (this.random.chance(0.2)) {
            effectiveDates.push({ date: futureChange, fte: Math.round((baseFte + this.random.int(1, 10) / 10) * 10) / 10 });
          }
          for (const { date, fte } of effectiveDates) {
            const id = this.uuid('capacity');
            const createdAt = saoPauloTime(minIsoDate(date, addDays(this.today, -1)), 9);
            this.capacityRows.push({
              id,
              groupId: group.id,
              resourceProfileId: profile.id,
              classification,
              effectiveDate: date,
              fte: fte.toFixed(1),
              deletedAt: null,
              createdAt,
              version: 1,
            });
            this.capacityHistoryRows.push({
              id: this.uuid('capacity-history'),
              capacityId: id,
              action: 'CREATED',
              actorId: this.admin.id,
              actorSnapshot: { id: this.admin.id, displayName: this.admin.displayName },
              reason: 'Volume dataset capacity plan.',
              beforeSnapshot: null,
              afterSnapshot: {
                id,
                group: { id: group.id, name: group.name },
                resourceProfile: { id: profile.id, name: profile.name, active: true },
                classification,
                effectiveDate: date,
                fte,
                version: 1,
              },
              occurredAt: createdAt,
            });
          }
        }
      }
    }
  }

  private leadersOf(group: GroupSeed): PersonSeed[] {
    return [group.moderator, group.supervisor, group.manager];
  }

  private deciderFor(group: GroupSeed): PersonSeed {
    const roll = this.random.next();
    if (roll < 0.6) return group.moderator;
    return roll < 0.8 ? group.supervisor : group.manager;
  }

  private requesterFor(group: GroupSeed): PersonSeed {
    const otherGroups = this.groups.filter((candidate) => candidate.id !== group.id && candidate.users.length > 0);
    const source = otherGroups.length > 0 ? this.random.pick(otherGroups) : group;
    return this.random.pick(source.users);
  }

  private notify(
    recipientIds: string[],
    source: { requestId?: string; allocationId?: string },
    eventCode: string,
    title: string,
    message: string,
    createdAt: Date,
    excludeId?: string,
  ): void {
    const readCutoff = shiftHours(this.anchor, -7 * 24);
    for (const recipientId of [...new Set(recipientIds)]) {
      if (recipientId === excludeId) continue;
      this.notificationRows.push({
        id: this.uuid('notification'),
        recipientId,
        sourceRequestId: source.requestId ?? null,
        sourceAllocationId: source.allocationId ?? null,
        eventCode,
        title,
        message,
        createdAt,
        readAt: createdAt.getTime() < readCutoff.getTime() ? shiftHours(createdAt, 20) : null,
      });
    }
  }

  private requestedConditions(input: RequestSeedInput): Record<string, unknown> {
    return {
      initiativeId: input.initiative.id,
      initiativeCode: input.initiative.code,
      initiativeName: input.initiative.name,
      category: input.category,
      groupId: input.group.id,
      groupName: input.group.name,
      resourceProfileId: input.profile.id,
      resourceProfileName: input.profile.name,
      startDate: input.startDate,
      endDate: input.endDate,
      weeklyHours: input.weeklyHours,
      comment: input.comment,
    };
  }

  private approvedConditions(
    input: RequestSeedInput,
    assignee: PersonSeed,
    terms: { startDate: string; endDate: string; weeklyHours: number },
    proposal?: { decider: PersonSeed; explanation: string },
  ): Record<string, unknown> {
    return {
      personId: assignee.id,
      personName: assignee.displayName,
      resourceProfileId: input.profile.id,
      resourceProfileName: input.profile.name,
      groupId: input.group.id,
      groupName: input.group.name,
      initiativeId: input.initiative.id,
      initiativeCode: input.initiative.code,
      initiativeName: input.initiative.name,
      startDate: terms.startDate,
      endDate: terms.endDate,
      weeklyHours: terms.weeklyHours,
      ...(proposal ? { decidedByPersonId: proposal.decider.id, explanation: proposal.explanation } : {}),
    };
  }

  /** Persists submission, line, request, history, and notices for one request line. */
  private addRequest(input: RequestSeedInput, state: RequestState): string {
    const submissionId = this.uuid('submission');
    const lineId = this.uuid('line');
    const requestId = this.uuid('request');
    const attemptKey = this.uuid('attempt');
    const correlationId = this.uuid('correlation');
    const requestedConditions = this.requestedConditions(input);
    const submittedConditions = {
      initiativeId: input.initiative.id,
      category: input.category,
      attemptKey,
      groupId: input.group.id,
      resourceProfileId: input.profile.id,
      startDate: input.startDate,
      endDate: input.endDate,
      weeklyHours: input.weeklyHours,
      comment: input.comment,
    };
    this.usedInitiativeIds.add(input.initiative.id);
    this.submissionRows.push({
      id: submissionId,
      requesterId: input.requester.id,
      category: input.category,
      lineCount: 1,
      correlationId,
      receivedAt: input.receivedAt,
    });
    this.lineRows.push({
      id: lineId,
      submissionId,
      requesterId: input.requester.id,
      attemptKey,
      attemptPayloadHash: createHash('sha256').update(JSON.stringify(submittedConditions)).digest('hex'),
      lineNumber: 0,
      submittedConditions,
      status: ResourceSubmissionLineStatus.Received,
      requestId: null,
      problem: null,
      requestOutcome: null,
      claimToken: null,
      claimedAt: null,
      processingAttempts: 1,
      receivedAt: input.receivedAt,
      completedAt: null,
    });
    this.entryRows.push({ id: this.uuid('entry'), submissionId, lineId, lineNumber: 0 });
    this.requestRows.push({
      id: requestId,
      submissionLineId: lineId,
      requesterId: input.requester.id,
      requesterSnapshot: snapshotOf(input.requester),
      requestedConditions,
      approvedConditions: state.approvedConditions,
      decisionState: state.decisionState,
      revalidationOriginState: state.revalidationOriginState,
      revalidationDecisionStage: state.revalidationDecisionStage,
      receivedAt: input.receivedAt,
      stageEnteredAt: state.stageEnteredAt,
      expirationDueAt: state.expirationDueAt,
      decisionResponseDueAt: state.decisionResponseDueAt,
      removedAt: null,
      version: state.version,
    });
    this.requestHistoryRows.push({
      id: this.uuid('request-history'),
      requestId,
      actorSnapshot: snapshotOf(input.requester),
      action: 'SUBMITTED',
      afterSnapshot: { requestId, decisionState: ResourceRequestDecisionState.WaitingForPresentation, requestedConditions },
      correlationId,
      occurredAt: input.receivedAt,
    });
    for (const event of state.events) {
      this.requestHistoryRows.push({
        id: this.uuid('request-history'),
        requestId,
        actorSnapshot: event.actor,
        action: event.action,
        afterSnapshot: { requestId, ...event.details },
        correlationId: this.uuid('correlation'),
        occurredAt: event.occurredAt,
      });
    }
    this.notify(this.allAdminIds, { requestId }, 'REQUEST_SUBMITTED', 'New resource request', 'A resource request is waiting for presentation.', input.receivedAt, input.requester.id);
    for (const notice of state.notices) {
      this.notify(notice.recipientIds, { requestId }, notice.eventCode, notice.title, notice.message, notice.createdAt);
    }
    return requestId;
  }

  private transition(
    from: { decisionState: string; version: number },
    to: { decisionState: string; version: number },
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { before: from, after: to, ...extra };
  }

  private pickProjectTerms(group: GroupSeed) {
    return {
      profile: this.random.pick(group.profiles),
      initiative: this.random.pick(this.initiatives),
      category: this.random.pick(requestCategories),
    };
  }

  /** Initiative work: mostly approved requests, with some direct allocations by group leadership. */
  private buildProjectTrack(group: GroupSeed, member: PersonSeed): void {
    let cursor = addDays(this.windowStart, this.random.int(0, 21));
    while (cursor <= this.horizon) {
      const startDate = cursor;
      const endDate = addDays(startDate, this.random.int(14, 90) - 1);
      const weeklyHours = this.random.hours(40, 240);
      const { profile, initiative, category } = this.pickProjectTerms(group);
      if (this.random.chance(0.15)) {
        const author = member.id === group.moderator.id ? group.supervisor : group.moderator;
        const createdDay = minIsoDate(addDays(startDate, -this.random.int(1, 14)), addDays(this.today, -1));
        this.addAllocation({
          origin: 'DIRECT',
          sourceRequestId: null,
          category,
          comment: `Direct allocation to ${initiative.code}.`,
          person: member,
          group,
          profile,
          initiative,
          startDate,
          endDate,
          weeklyHours,
          approvedDay: createdDay,
          approvedAt: saoPauloTime(createdDay, this.random.int(8, 18), this.random.int(0, 59)),
          createdBy: author,
        });
      } else {
        this.addApprovedRequest(group, member, { profile, initiative, category, startDate, endDate, weeklyHours });
      }
      cursor = addDays(endDate, 1 + this.random.int(0, 10));
    }
  }

  private addApprovedRequest(
    group: GroupSeed,
    assignee: PersonSeed,
    terms: { profile: ProfileSeed; initiative: InitiativeSeed; category: ResourceRequestCategory; startDate: string; endDate: string; weeklyHours: number },
  ): void {
    const requester = this.requesterFor(group);
    const receivedDay = minIsoDate(addDays(terms.startDate, -this.random.int(3, 21)), addDays(this.today, -3));
    const receivedAt = saoPauloTime(receivedDay, this.random.int(9, 17), this.random.int(0, 59));
    const input: RequestSeedInput = {
      group,
      requester,
      profile: terms.profile,
      initiative: terms.initiative,
      category: terms.category,
      startDate: terms.startDate,
      endDate: terms.endDate,
      weeklyHours: terms.weeklyHours,
      comment: `${terms.profile.name} needed for ${terms.initiative.name}.`,
      receivedAt,
    };
    const approvedConditions = this.approvedConditions(input, assignee, terms);
    const events: RequestState['events'] = [];
    const notices: RequestState['notices'] = [];
    let approvedAt: Date;
    let version: number;
    if (this.random.chance(0.4)) {
      approvedAt = shiftHours(receivedAt, this.random.int(2, 30));
      version = 2;
      events.push({
        actor: snapshotOf(this.admin),
        action: 'APPROVED',
        occurredAt: approvedAt,
        details: this.transition(
          { decisionState: ResourceRequestDecisionState.WaitingForPresentation, version: 1 },
          { decisionState: ResourceRequestDecisionState.Approved, version },
          { requestedConditions: this.requestedConditions(input), approvedConditions },
        ),
      });
    } else {
      const referredAt = shiftHours(receivedAt, this.random.int(1, 16));
      approvedAt = shiftHours(referredAt, this.random.int(1, 20));
      version = 3;
      events.push({
        actor: snapshotOf(this.admin),
        action: 'REFERRED',
        occurredAt: referredAt,
        details: this.transition(
          { decisionState: ResourceRequestDecisionState.WaitingForPresentation, version: 1 },
          { decisionState: ResourceRequestDecisionState.PendingTeamDecision, version: 2 },
        ),
      });
      events.push({
        actor: snapshotOf(this.deciderFor(group)),
        action: 'APPROVED',
        occurredAt: approvedAt,
        details: this.transition(
          { decisionState: ResourceRequestDecisionState.PendingTeamDecision, version: 2 },
          { decisionState: ResourceRequestDecisionState.Approved, version },
          { requestedConditions: this.requestedConditions(input), approvedConditions },
        ),
      });
      notices.push({
        recipientIds: this.leadersOf(group).map((leader) => leader.id),
        eventCode: 'REQUEST_REFERRED_2',
        title: 'Resource request referred to your group',
        message: 'A request is waiting for a decision from your group.',
        createdAt: referredAt,
      });
    }
    notices.push({
      recipientIds: [requester.id],
      eventCode: `REQUEST_APPROVED_${version}`,
      title: 'Resource request approved',
      message: `Your request was approved from ${terms.startDate} to ${terms.endDate} at ${terms.weeklyHours.toFixed(1)} weekly hours.`,
      createdAt: approvedAt,
    });
    // The allocation id is drawn first so that the approval event can reference it.
    const allocationId = this.uuid('allocation');
    const approvalEvent = events[events.length - 1];
    approvalEvent.details = { ...approvalEvent.details, allocationId };
    const requestId = this.addRequest(input, {
      decisionState: ResourceRequestDecisionState.Approved,
      version,
      stageEnteredAt: approvedAt,
      expirationDueAt: shiftHours(receivedAt, 21 * 24),
      decisionResponseDueAt: null,
      approvedConditions,
      revalidationOriginState: null,
      revalidationDecisionStage: null,
      events,
      notices,
    });
    const approvedDay = new Date(approvedAt.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
    this.addAllocation({
      origin: 'REQUEST',
      sourceRequestId: requestId,
      category: terms.category,
      comment: null,
      person: assignee,
      group,
      profile: terms.profile,
      initiative: terms.initiative,
      startDate: terms.startDate,
      endDate: terms.endDate,
      weeklyHours: terms.weeklyHours,
      approvedDay,
      approvedAt,
      createdBy: null,
    }, allocationId);
  }

  /** Operational work recorded by the person or by group leadership. */
  private buildOperationalTrack(group: GroupSeed, member: PersonSeed): void {
    let cursor = addDays(this.windowStart, this.random.int(0, 30));
    const weighted = operationalActivities.flatMap((activity) => Array.from({ length: activity.weight }, () => activity));
    while (cursor <= this.horizon) {
      const startDate = cursor;
      const endDate = addDays(startDate, this.random.int(30, 120) - 1);
      const activity = this.random.pick(weighted);
      const self = this.random.chance(0.7);
      const createdDay = minIsoDate(addDays(startDate, -this.random.int(0, 14)), addDays(this.today, -1));
      this.addAllocation({
        origin: self ? 'SELF' : 'DIRECT',
        sourceRequestId: null,
        category: activity.category,
        comment: this.random.pick(activity.comments),
        person: member,
        group,
        profile: this.random.pick(group.profiles),
        initiative: null,
        startDate,
        endDate,
        weeklyHours: this.random.hours(20, 120),
        approvedDay: createdDay,
        approvedAt: saoPauloTime(createdDay, this.random.int(8, 18), this.random.int(0, 59)),
        createdBy: self ? member : member.id === group.moderator.id ? group.supervisor : group.moderator,
      });
      cursor = addDays(endDate, 1 + this.random.int(0, 30));
    }
  }

  private buildVacations(group: GroupSeed, member: PersonSeed): void {
    const periods: Array<{ startDate: string; endDate: string }> = [];
    const memberIndex = group.members.indexOf(member) * this.groups.length + group.index;
    if (memberIndex % 12 === 0) {
      // A share of people is on vacation in the current week so its separate total is visible.
      const monday = mondayOf(this.today);
      periods.push({ startDate: monday, endDate: addDays(monday, 4) });
    }
    const count = Math.max(1, Math.round(this.options.months / 6)) + (this.random.chance(0.3) ? 1 : 0);
    const span = Math.max(0, daysBetween(this.windowStart, addDays(this.horizon, -21)));
    for (let index = 0; index < count; index += 1) {
      const startDate = mondayOf(addDays(this.windowStart, this.random.int(0, span) + 7));
      const endDate = addDays(startDate, this.random.pick([4, 11, 18]));
      if (periods.some((period) => startDate <= period.endDate && endDate >= period.startDate)) continue;
      periods.push({ startDate, endDate });
    }
    for (const period of periods) {
      const createdDay = minIsoDate(addDays(period.startDate, -this.random.int(7, 30)), addDays(this.today, -1));
      this.addAllocation({
        origin: 'SELF',
        sourceRequestId: null,
        category: 'VACATION',
        comment: null,
        person: member,
        group,
        profile: null,
        initiative: null,
        startDate: period.startDate,
        endDate: period.endDate,
        weeklyHours: 40,
        approvedDay: createdDay,
        approvedAt: saoPauloTime(createdDay, this.random.int(8, 18), this.random.int(0, 59)),
        createdBy: member,
      });
    }
  }

  private addAllocation(input: AllocationSeedInput, presetId?: string): void {
    const id = presetId ?? this.uuid('allocation');
    const vacation = input.category === 'VACATION';
    const leader = input.person.id === input.group.moderator.id ? input.group.supervisor : input.group.moderator;
    const minimumEventTime = shiftHours(input.approvedAt, 1);
    let state: string;
    if (input.origin === 'REQUEST') {
      state = input.startDate === input.approvedDay ? 'IN_PROGRESS' : 'NOT_STARTED';
    } else {
      state = input.startDate > input.approvedDay ? 'NOT_STARTED' : input.endDate < input.approvedDay ? 'DONE' : 'IN_PROGRESS';
    }
    let effectiveEndDate = input.endDate;
    let stateEnteredAt = input.approvedAt;
    const events: Array<{ actor: ActorSnapshot; action: string; reason: string; from: string; to: string; at: Date }> = [];
    const move = (to: string, actor: ActorSnapshot, action: string, reason: string, at: Date) => {
      events.push({ actor, action, reason, from: state, to, at });
      state = to;
      stateEnteredAt = at;
    };

    const past = input.endDate < this.today;
    const future = input.startDate > this.today;
    const cancelled = past && !vacation && input.endDate > input.startDate && this.random.chance(0.04);
    if (cancelled) {
      const cancelDay = addDays(input.startDate, this.random.int(0, daysBetween(input.startDate, input.endDate) - 1));
      if (state === 'NOT_STARTED' && cancelDay >= input.startDate) {
        move('IN_PROGRESS', lifecycleWorker, 'ALLOCATION_STARTED', 'Automatically started on its São Paulo start date.', laterOf(saoPauloTime(input.startDate, 0), minimumEventTime));
      }
      effectiveEndDate = cancelDay;
      move('CANCELED', snapshotOf(leader), 'ALLOCATION_CANCELED_CANCELED', this.random.pick(cancellationReasons), laterOf(saoPauloTime(cancelDay, 17), shiftHours(stateEnteredAt, 1)));
    } else {
      if (state === 'NOT_STARTED' && input.startDate <= this.today) {
        move('IN_PROGRESS', lifecycleWorker, 'ALLOCATION_STARTED', 'Automatically started on its São Paulo start date.', laterOf(saoPauloTime(input.startDate, 0), minimumEventTime));
      }
      if (past && state !== 'DONE') {
        move('DONE', lifecycleWorker, 'ALLOCATION_ENDED', 'Automatically completed after its inclusive end date.', laterOf(saoPauloTime(addDays(input.endDate, 1), 0), shiftHours(stateEnteredAt, 1)));
      }
      if (!past && !vacation) {
        const earliestDay = maxIsoDate(future ? input.approvedDay : maxIsoDate(input.startDate, input.approvedDay), input.approvedDay);
        const latestDay = addDays(this.today, -1);
        const roll = this.random.next();
        const suspendShare = future ? 0.04 : 0.06;
        const reserveShare = future ? 0.03 : 0.04;
        if (earliestDay <= latestDay && roll < suspendShare + reserveShare) {
          const day = addDays(earliestDay, this.random.int(0, daysBetween(earliestDay, latestDay)));
          const at = laterOf(saoPauloTime(day, this.random.int(9, 17)), shiftHours(stateEnteredAt, 1));
          if (roll < suspendShare) {
            move('SUSPENDED', snapshotOf(leader), 'ALLOCATION_SUSPENDED_SUSPENDED', this.random.pick(suspensionReasons), at);
          } else {
            move('ALLOCATED_WITHOUT_ACTION', snapshotOf(leader), 'ALLOCATION_RESERVED_WITHOUT_ACTION_ALLOCATED_WITHOUT_ACTION', this.random.pick(reservationReasons), at);
          }
        }
      }
    }

    const groupSnapshot = { id: input.group.id, name: input.group.name };
    const initiativeSnapshot = input.initiative ? { id: input.initiative.id, code: input.initiative.code, name: input.initiative.name } : null;
    const profileSnapshot = input.profile ? { id: input.profile.id, name: input.profile.name } : null;
    this.allocationRows.push({
      id,
      sourceRequestId: input.sourceRequestId,
      origin: input.origin,
      category: input.category,
      comment: input.comment,
      classification: input.person.classification,
      createdByPersonId: input.origin === 'REQUEST' ? null : input.createdBy?.id ?? null,
      personId: input.person.id,
      personSnapshot: snapshotOf(input.person),
      groupId: input.group.id,
      groupSnapshot,
      initiativeId: input.initiative?.id ?? null,
      initiativeSnapshot,
      resourceProfileId: input.profile?.id ?? null,
      resourceProfileSnapshot: profileSnapshot,
      approvedStartDate: input.startDate,
      approvedEndDate: input.endDate,
      effectiveStartDate: input.startDate,
      effectiveEndDate,
      weeklyHours: input.weeklyHours.toFixed(1),
      state,
      stateEnteredAt,
      approvedAt: input.approvedAt,
      createdAt: input.approvedAt,
      version: 1 + events.length,
    });

    const summary = (currentState: string, version: number) => ({
      id,
      requestId: input.sourceRequestId,
      origin: input.origin,
      category: input.category,
      person: { personId: input.person.id, displayName: input.person.displayName },
      group: groupSnapshot,
      initiative: initiativeSnapshot,
      resourceProfile: profileSnapshot,
      startDate: input.startDate,
      endDate: effectiveEndDate,
      approvedPeriod: { startDate: input.startDate, endDate: input.endDate },
      weeklyHours: input.weeklyHours,
      state: currentState,
      version,
    });
    if (input.origin !== 'REQUEST' && input.createdBy) {
      const initialState = events[0]?.from ?? state;
      this.allocationHistoryRows.push({
        id: this.uuid('allocation-history'),
        allocationId: id,
        actorSnapshot: snapshotOf(input.createdBy),
        action: input.origin === 'SELF' ? 'SELF_ALLOCATION_CREATED' : 'DIRECT_ALLOCATION_CREATED',
        reason: input.comment,
        beforeSnapshot: {},
        afterSnapshot: summary(initialState, 1),
        correlationId: this.uuid('correlation'),
        occurredAt: input.approvedAt,
      });
      const period = `from ${input.startDate} to ${input.endDate} at ${input.weeklyHours.toFixed(1)} weekly hours`;
      if (input.origin === 'SELF') {
        this.notify(this.leadersOf(input.group).map((person) => person.id), { allocationId: id }, 'ALLOCATION_CREATED', 'New self allocation', `An allocation was self-allocated by ${input.person.displayName} ${period}.`, input.approvedAt, input.createdBy.id);
      } else {
        this.notify([input.person.id], { allocationId: id }, 'ALLOCATION_CREATED', 'New direct allocation', `An allocation was allocated to you ${period}.`, input.approvedAt, input.createdBy.id);
      }
    }
    events.forEach((event, index) => {
      this.allocationHistoryRows.push({
        id: this.uuid('allocation-history'),
        allocationId: id,
        actorSnapshot: event.actor,
        action: event.action,
        reason: event.reason,
        beforeSnapshot: summary(event.from, index + 1),
        afterSnapshot: summary(event.to, index + 2),
        correlationId: this.uuid('correlation'),
        occurredAt: event.at,
      });
    });
  }

  /** Historical requests that were denied and then withdrawn by the requester; they never became allocations. */
  private buildCancelledHistory(group: GroupSeed): void {
    for (let index = 0; index < this.options.months; index += 1) {
      const startDate = addDays(this.windowStart, this.random.int(10, Math.max(10, daysBetween(this.windowStart, this.today) - 20)));
      const receivedDay = addDays(startDate, -this.random.int(5, 10));
      const receivedAt = saoPauloTime(receivedDay, this.random.int(9, 17), this.random.int(0, 59));
      const { profile, initiative, category } = this.pickProjectTerms(group);
      const requester = this.requesterFor(group);
      const input: RequestSeedInput = {
        group,
        requester,
        profile,
        initiative,
        category,
        startDate,
        endDate: addDays(startDate, this.random.int(20, 60)),
        weeklyHours: this.random.hours(40, 240),
        comment: `${profile.name} needed for ${initiative.name}.`,
        receivedAt,
      };
      const referredAt = shiftHours(receivedAt, this.random.int(1, 16));
      const deniedAt = shiftHours(referredAt, this.random.int(2, 24));
      const cancelledAt = shiftHours(deniedAt, this.random.int(4, 72));
      this.addRequest(input, {
        decisionState: ResourceRequestDecisionState.Cancelled,
        version: 4,
        stageEnteredAt: cancelledAt,
        expirationDueAt: shiftHours(deniedAt, 14 * 24),
        decisionResponseDueAt: null,
        approvedConditions: null,
        revalidationOriginState: null,
        revalidationDecisionStage: null,
        events: [
          { actor: snapshotOf(this.admin), action: 'REFERRED', occurredAt: referredAt, details: this.transition({ decisionState: 'WAITING_FOR_PRESENTATION', version: 1 }, { decisionState: 'PENDING_TEAM_DECISION', version: 2 }) },
          { actor: snapshotOf(this.deciderFor(group)), action: 'DENIED', occurredAt: deniedAt, details: this.transition({ decisionState: 'PENDING_TEAM_DECISION', version: 2 }, { decisionState: 'DENIED', version: 3 }, { reason: 'Requested capacity is fully committed for the proposed period.' }) },
          { actor: snapshotOf(requester), action: 'DENIAL_CANCELLED', occurredAt: cancelledAt, details: this.transition({ decisionState: 'DENIED', version: 3 }, { decisionState: 'CANCELLED', version: 4 }, { reason: 'Scope absorbed by existing team capacity.' }) },
        ],
        notices: [
          { recipientIds: this.leadersOf(group).map((leader) => leader.id), eventCode: 'REQUEST_REFERRED_2', title: 'Resource request referred to your group', message: 'A request is waiting for a decision from your group.', createdAt: referredAt },
          { recipientIds: [requester.id], eventCode: 'REQUEST_DENIED_3', title: 'Resource request denied', message: 'A decision maker denied your resource request. Review the explanation in the request history.', createdAt: deniedAt },
        ],
      });
    }
  }

  /** Recent requests still in decision queues, inside every deadline the workers enforce. */
  private buildOpenRequests(group: GroupSeed): void {
    const plan: ResourceRequestDecisionState[] = [
      ...Array.from({ length: waitingPerGroup }, () => ResourceRequestDecisionState.WaitingForPresentation),
      ...Array.from({ length: pendingTeamDecisionPerGroup }, () => ResourceRequestDecisionState.PendingTeamDecision),
      ...(group.index % 2 === 0 ? [ResourceRequestDecisionState.ApprovedWithChanges] : [ResourceRequestDecisionState.Denied]),
      ...(group.index % 3 === 0 ? [ResourceRequestDecisionState.PreN3] : []),
      ...(group.index % 5 === 0 ? [ResourceRequestDecisionState.Escalation] : []),
      ...(group.index % 10 === 0 ? [ResourceRequestDecisionState.RequiresRevalidation] : []),
    ];
    for (const decisionState of plan) {
      const { profile, initiative, category } = this.pickProjectTerms(group);
      const requester = this.requesterFor(group);
      const startDate = addDays(this.today, this.random.int(14, 60));
      // Waiting requests stay younger than the 7-day reminder; later stages leave room for their decision events.
      const receivedDay = addDays(this.today, decisionState === ResourceRequestDecisionState.WaitingForPresentation
        ? -this.random.int(1, 4)
        : decisionState === ResourceRequestDecisionState.RequiresRevalidation ? -8 : -this.random.int(2, 5));
      const input: RequestSeedInput = {
        group,
        requester,
        profile,
        initiative,
        category,
        startDate,
        endDate: addDays(startDate, this.random.int(30, 120)),
        weeklyHours: this.random.hours(40, 240),
        comment: `${profile.name} needed for ${initiative.name}.`,
        receivedAt: saoPauloTime(receivedDay, this.random.int(8, 18), this.random.int(0, 59)),
      };
      this.addRequest(input, this.openRequestState(input, decisionState));
    }
  }

  private openRequestState(input: RequestSeedInput, decisionState: ResourceRequestDecisionState): RequestState {
    const { group, requester, receivedAt } = input;
    const leaders = this.leadersOf(group).map((leader) => leader.id);
    const decider = this.deciderFor(group);
    const base: RequestState = {
      decisionState,
      version: 1,
      stageEnteredAt: receivedAt,
      expirationDueAt: shiftHours(receivedAt, 21 * 24),
      decisionResponseDueAt: null,
      approvedConditions: null,
      revalidationOriginState: null,
      revalidationDecisionStage: null,
      events: [],
      notices: [],
    };
    if (decisionState === ResourceRequestDecisionState.WaitingForPresentation) return base;

    const referredAt = shiftHours(receivedAt, this.random.int(1, 6));
    base.events.push({ actor: snapshotOf(this.admin), action: 'REFERRED', occurredAt: referredAt, details: this.transition({ decisionState: 'WAITING_FOR_PRESENTATION', version: 1 }, { decisionState: 'PENDING_TEAM_DECISION', version: 2 }) });
    base.notices.push({ recipientIds: leaders, eventCode: 'REQUEST_REFERRED_2', title: 'Resource request referred to your group', message: 'A request is waiting for a decision from your group.', createdAt: referredAt });
    base.version = 2;
    base.stageEnteredAt = referredAt;
    if (decisionState === ResourceRequestDecisionState.PendingTeamDecision) return base;

    if (decisionState === ResourceRequestDecisionState.ApprovedWithChanges) {
      const proposedAt = shiftHours(this.anchor, -this.random.int(2, 20));
      const dueAt = shiftHours(proposedAt, 72);
      const dueDay = new Date(dueAt.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
      const proposedStart = maxIsoDate(addDays(input.startDate, this.random.int(3, 14)), dueDay);
      const explanation = 'Adjusted start date and weekly hours to match team availability.';
      base.approvedConditions = this.approvedConditions(input, this.random.pick(group.members), {
        startDate: proposedStart,
        endDate: addDays(proposedStart, daysBetween(input.startDate, input.endDate)),
        weeklyHours: Math.max(1, Math.round((input.weeklyHours - 2) * 10) / 10),
      }, { decider, explanation });
      base.version = 3;
      base.stageEnteredAt = proposedAt;
      base.decisionResponseDueAt = dueAt;
      base.revalidationDecisionStage = 'PENDING_TEAM_DECISION';
      base.events.push({ actor: snapshotOf(decider), action: 'APPROVAL_CHANGES_PROPOSED', occurredAt: proposedAt, details: this.transition({ decisionState: 'PENDING_TEAM_DECISION', version: 2 }, { decisionState: 'APPROVED_WITH_CHANGES', version: 3 }, { approvedConditions: base.approvedConditions, dueAt: dueAt.toISOString(), explanation }) });
      base.notices.push({ recipientIds: [requester.id], eventCode: 'REQUEST_CHANGES_PROPOSED_3', title: 'Resource request proposal needs your response', message: 'A decision maker proposed updated dates and weekly hours for your request.', createdAt: proposedAt });
      return base;
    }

    if (decisionState === ResourceRequestDecisionState.RequiresRevalidation) {
      const proposedAt = shiftHours(referredAt, this.random.int(2, 10));
      const proposedStart = addDays(this.today, -3);
      const explanation = 'Original proposal start date elapsed before confirmation.';
      base.approvedConditions = this.approvedConditions(input, this.random.pick(group.members), {
        startDate: proposedStart,
        endDate: addDays(proposedStart, 30),
        weeklyHours: input.weeklyHours,
      }, { decider, explanation });
      const revalidatedAt = saoPauloTime(proposedStart, 0, 5);
      base.version = 4;
      base.stageEnteredAt = revalidatedAt;
      base.revalidationOriginState = ResourceRequestDecisionState.ApprovedWithChanges;
      base.revalidationDecisionStage = 'PENDING_TEAM_DECISION';
      base.events.push({ actor: snapshotOf(decider), action: 'APPROVAL_CHANGES_PROPOSED', occurredAt: proposedAt, details: this.transition({ decisionState: 'PENDING_TEAM_DECISION', version: 2 }, { decisionState: 'APPROVED_WITH_CHANGES', version: 3 }, { approvedConditions: base.approvedConditions, explanation }) });
      base.events.push({ actor: systemDecisionWorker, action: 'PROPOSAL_REQUIRES_REVALIDATION', occurredAt: revalidatedAt, details: this.transition({ decisionState: 'APPROVED_WITH_CHANGES', version: 3 }, { decisionState: 'REQUIRES_REVALIDATION', version: 4 }, { impediments: ['PROPOSED_START_DATE_PASSED'], previousProposal: base.approvedConditions }) });
      base.notices.push({ recipientIds: [requester.id, ...this.allAdminIds, ...leaders], eventCode: 'REQUEST_REVALIDATION_REQUIRED_4', title: 'Resource request needs revalidation', message: 'The proposed request dates or references require revalidation before confirmation.', createdAt: revalidatedAt });
      return base;
    }

    const deniedAt = shiftHours(referredAt, this.random.int(2, 12));
    base.events.push({ actor: snapshotOf(decider), action: 'DENIED', occurredAt: deniedAt, details: this.transition({ decisionState: 'PENDING_TEAM_DECISION', version: 2 }, { decisionState: 'DENIED', version: 3 }, { reason: 'Requested capacity is fully committed for the proposed period.' }) });
    base.notices.push({ recipientIds: [requester.id], eventCode: 'REQUEST_DENIED_3', title: 'Resource request denied', message: 'A decision maker denied your resource request. Review the explanation in the request history.', createdAt: deniedAt });
    base.version = 3;
    base.stageEnteredAt = deniedAt;
    if (decisionState === ResourceRequestDecisionState.Denied) {
      base.expirationDueAt = shiftHours(deniedAt, 14 * 24);
      return base;
    }

    const contestedAt = shiftHours(deniedAt, this.random.int(1, 12));
    base.events.push({ actor: snapshotOf(requester), action: 'CONTESTED', occurredAt: contestedAt, details: this.transition({ decisionState: 'DENIED', version: 3 }, { decisionState: 'PRE_N3', version: 4 }, { reason: 'Initiative milestone cannot slip without partial coverage.' }) });
    base.notices.push({ recipientIds: this.allAdminIds, eventCode: 'REQUEST_CONTESTED_4', title: 'Resource request contested', message: 'A requester contested a denied request. Review it in the Pre N3 queue.', createdAt: contestedAt });
    base.version = 4;
    base.stageEnteredAt = contestedAt;
    if (decisionState === ResourceRequestDecisionState.PreN3) return base;

    const escalatedAt = shiftHours(contestedAt, this.random.int(1, 12));
    base.events.push({ actor: snapshotOf(this.admin), action: 'ESCALATED', occurredAt: escalatedAt, details: this.transition({ decisionState: 'PRE_N3', version: 4 }, { decisionState: 'ESCALATION', version: 5 }, { reason: 'Requires cross-group prioritization review.' }) });
    base.notices.push({ recipientIds: this.allAdminIds, eventCode: 'REQUEST_EXCEPTION_ESCALATED_5', title: 'Resource request escalated', message: 'A contested resource request was explicitly escalated for resolution.', createdAt: escalatedAt });
    base.version = 5;
    base.stageEnteredAt = escalatedAt;
    return base;
  }
}

async function insertInChunks<T extends ObjectLiteral>(
  manager: EntityManager,
  target: EntityTarget<T>,
  rows: Array<Row<T>>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += insertChunkSize) {
    await manager
      .createQueryBuilder()
      .insert()
      .into(target)
      .values(rows.slice(offset, offset + insertChunkSize) as Array<QueryDeepPartialEntity<T>>)
      .updateEntity(false)
      .execute();
  }
}

async function volumeDataExists(manager: EntityManager): Promise<boolean> {
  const rows = await manager.query(
    `SELECT
       EXISTS (SELECT 1 FROM resource_people WHERE local_user_id LIKE $1)
       OR EXISTS (SELECT 1 FROM resource_groups WHERE name LIKE $2)
       OR EXISTS (SELECT 1 FROM resource_initiatives WHERE UPPER(code) LIKE $3) AS present`,
    [`${volumeLocalUserIdPrefix}%`, `${volumeGroupNamePrefix}%`, `${volumeInitiativeCodePrefix}%`],
  ) as Array<{ present: boolean }>;
  return rows[0]?.present === true;
}

async function countByIds(manager: EntityManager, table: string, ids: string[]): Promise<number> {
  const rows = await manager.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]) as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

async function groupCountsByIds(manager: EntityManager, table: string, column: string, ids: string[]): Promise<Record<string, number>> {
  const rows = await manager.query(
    `SELECT ${column} AS key, COUNT(*)::int AS count FROM ${table} WHERE id = ANY($1::uuid[]) GROUP BY ${column} ORDER BY ${column}`,
    [ids],
  ) as Array<{ key: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));
}

function idsOf(rows: Array<{ id?: unknown }>): string[] {
  return rows.map((row) => String(row.id));
}

async function persistVolumeDataset(manager: EntityManager, builder: VolumeDatasetBuilder): Promise<void> {
  const personRow = (person: PersonSeed): Row<ResourcePerson> => ({
    id: person.id,
    localUserId: person.localUserId,
    displayName: person.displayName,
    email: person.email,
    role: person.role,
    classification: person.classification,
    active: true,
    groupId: person.groupId,
    coveredGroupIds: person.coveredGroupIds,
    version: 1,
  });
  const ungrouped = builder.people.filter((person) => person.groupId === null);
  const grouped = builder.people.filter((person) => person.groupId !== null);
  await insertInChunks(manager, ResourcePerson, ungrouped.map(personRow));
  await insertInChunks(manager, ResourceGroup, builder.groups.map((group) => ({
    id: group.id,
    name: group.name,
    active: true,
    supervisorId: group.supervisor.id,
    managerId: group.manager.id,
    version: 1,
  })));
  await insertInChunks(manager, ResourcePerson, grouped.map(personRow));
  await insertInChunks(manager, ResourceProfile, builder.groups.flatMap((group) => group.profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    groupId: profile.groupId,
    active: true,
    version: 1,
  }))));
  await insertInChunks(manager, ResourceInitiative, builder.initiatives.map((initiative) => ({
    id: initiative.id,
    code: initiative.code,
    name: initiative.name,
    active: true,
    codeUsed: builder.usedInitiativeIds.has(initiative.id),
    version: 1,
  })));
  await insertInChunks(manager, ResourceCapacity, builder.capacityRows);
  await insertInChunks(manager, ResourceCapacityHistory, builder.capacityHistoryRows);
  await insertInChunks(manager, ResourceSubmission, builder.submissionRows);
  await insertInChunks(manager, ResourceSubmissionLine, builder.lineRows);
  await insertInChunks(manager, ResourceSubmissionEntry, builder.entryRows);
  await insertInChunks(manager, ResourceRequest, builder.requestRows);
  await manager.query(
    `UPDATE resource_submission_lines AS line
     SET status = $2,
         request_id = request.id,
         request_outcome = jsonb_build_object('decisionState', $3::text, 'requestedConditions', request.requested_conditions),
         completed_at = request.received_at
     FROM resource_requests AS request
     WHERE request.submission_line_id = line.id AND line.id = ANY($1::uuid[])`,
    [idsOf(builder.lineRows), ResourceSubmissionLineStatus.Succeeded, ResourceRequestDecisionState.WaitingForPresentation],
  );
  await insertInChunks(manager, ResourceRequestHistory, builder.requestHistoryRows);
  await insertInChunks(manager, ResourceAllocation, builder.allocationRows);
  await insertInChunks(manager, ResourceAllocationHistory, builder.allocationHistoryRows);
  await insertInChunks(manager, ResourceAllocationNotification, builder.notificationRows);
}

/**
 * Generates a deterministic, domain-valid volume dataset on top of the minimal baseline for performance measurement.
 * Runs in one transaction and refuses to run when a previous volume dataset is present.
 */
export async function prepareVolumeData(
  dataSource: DataSource,
  options: PrepareVolumeDataOptions = {},
): Promise<PrepareVolumeDataResult> {
  const normalized = normalizeVolumeDataOptions(options);
  return dataSource.transaction(async (manager) => {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext('pmo.resource-allocation.volume-data'))");
    await lockResourceAllocationAdministrationWrites(manager);
    if (await volumeDataExists(manager)) throw new VolumeDataAlreadyPreparedError();

    const baseline = await ensureMinimalOperationalBaseline(manager);
    if (!baseline.operational) {
      throw new Error(`Cannot prepare volume data because the minimal baseline is not operational: ${baseline.diagnostics.join(' ')}`);
    }
    const clock = await manager.query(
      "SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today",
    ) as Array<{ today: string }>;
    const today = clock[0].today;
    const admins = await manager.getRepository(ResourcePerson).find({
      where: { role: ResourceAllocationRole.Admin, active: true },
      order: { id: 'ASC' },
    });

    const builder = new VolumeDatasetBuilder(normalized, today, admins.map((admin) => admin.id));
    builder.build();
    await persistVolumeDataset(manager, builder);

    const counts: VolumeDataCounts = {
      people: await countByIds(manager, 'resource_people', idsOf(builder.people)),
      groups: await countByIds(manager, 'resource_groups', idsOf(builder.groups)),
      profiles: await countByIds(manager, 'resource_profiles', builder.groups.flatMap((group) => idsOf(group.profiles))),
      initiatives: await countByIds(manager, 'resource_initiatives', idsOf(builder.initiatives)),
      capacities: await countByIds(manager, 'resource_capacities', idsOf(builder.capacityRows)),
      submissions: await countByIds(manager, 'resource_submissions', idsOf(builder.submissionRows)),
      requests: await countByIds(manager, 'resource_requests', idsOf(builder.requestRows)),
      requestHistory: await countByIds(manager, 'resource_request_history', idsOf(builder.requestHistoryRows)),
      allocations: await countByIds(manager, 'resource_allocations', idsOf(builder.allocationRows)),
      allocationHistory: await countByIds(manager, 'resource_allocation_history', idsOf(builder.allocationHistoryRows)),
      notifications: await countByIds(manager, 'resource_allocation_notifications', idsOf(builder.notificationRows)),
    };
    const requestsByState = await groupCountsByIds(manager, 'resource_requests', 'decision_state', idsOf(builder.requestRows));
    const leadership = builder.managers[0];
    const leadershipRows = await manager.query(
      `SELECT COUNT(*)::int AS count FROM resource_requests
       WHERE decision_state = $1 AND removed_at IS NULL AND requested_conditions->>'groupId' = ANY($2::text[])`,
      [ResourceRequestDecisionState.PendingTeamDecision, leadership.coveredGroupIds],
    ) as Array<{ count: number }>;
    const firstGroup = builder.groups[0];
    const firstUser = firstGroup.users[0];

    return {
      options: normalized,
      businessDate: today,
      counts,
      peopleByRole: await groupCountsByIds(manager, 'resource_people', 'role', idsOf(builder.people)),
      requestsByState,
      allocationsByState: await groupCountsByIds(manager, 'resource_allocations', 'state', idsOf(builder.allocationRows)),
      allocationsByOrigin: await groupCountsByIds(manager, 'resource_allocations', 'origin', idsOf(builder.allocationRows)),
      presentationApprovable: requestsByState[ResourceRequestDecisionState.WaitingForPresentation] ?? 0,
      leadershipTeamDecisionApprovable: Number(leadershipRows[0]?.count ?? 0),
      identities: {
        adminLocalUserId: builder.admin.localUserId,
        leadershipLocalUserId: leadership.localUserId,
        leadershipRole: leadership.role,
        leadershipGroupNames: builder.groups.filter((group) => group.manager.id === leadership.id).map((group) => group.name),
        moderatorLocalUserId: firstGroup.moderator.localUserId,
        userLocalUserId: firstUser.localUserId,
        userGroupName: firstGroup.name,
        groupNamePrefix: volumeGroupNamePrefix,
        initiativeCodePrefix: volumeInitiativeCodePrefix,
        localUserIdPrefix: volumeLocalUserIdPrefix,
      },
    };
  });
}

function formatCounts(values: Record<string, number>): string {
  return Object.entries(values).map(([key, value]) => `${key} ${value}`).join(', ');
}

async function run(): Promise<void> {
  const { ResourceAllocationDataSource } = await import('./data-source');
  const options = normalizeVolumeDataOptions(readVolumeDataOptionsFromEnv());

  await ResourceAllocationDataSource.initialize();
  try {
    const started = Date.now();
    const result = await prepareVolumeData(ResourceAllocationDataSource, options);
    const { identities } = result;
    console.log(
      `Prepared Tech Resource Allocation volume dataset (seed: ${result.options.seed}, people: ${result.options.people}, groups: ${result.options.groups}, months: ${result.options.months}, business date: ${result.businessDate}) in ${Date.now() - started} ms.`,
    );
    console.log(`Records: ${formatCounts({ ...result.counts })}.`);
    console.log(`People by role: ${formatCounts(result.peopleByRole)}.`);
    console.log(`Requests by decision state: ${formatCounts(result.requestsByState)}.`);
    console.log(`Allocations by state: ${formatCounts(result.allocationsByState)}.`);
    console.log(`Allocations by origin: ${formatCounts(result.allocationsByOrigin)}.`);
    console.log(
      `Measurement identities: Admin ${identities.adminLocalUserId} (${result.presentationApprovable} requests in the presentation queue); leadership ${identities.leadershipLocalUserId} covering ${identities.leadershipGroupNames[0]} to ${identities.leadershipGroupNames[identities.leadershipGroupNames.length - 1]} (${result.leadershipTeamDecisionApprovable} requests in the group decision queue); moderator ${identities.moderatorLocalUserId} and user ${identities.userLocalUserId} in ${identities.userGroupName}.`,
    );
    console.log(`VOLUME_DATASET_SUMMARY ${JSON.stringify(result)}`);
  } finally {
    await ResourceAllocationDataSource.destroy();
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Volume data preparation failed.');
    process.exitCode = 1;
  });
}
