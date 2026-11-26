import { randomUUID } from 'node:crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { localAdminUserId, localProfileHeader } from './local-identity';

/**
 * Prepares journey data through the real API as the local Admin. Every helper looks the record up
 * first and creates it only when it is missing, so a journey can run on the minimal baseline, after
 * another journey, or again on the same database. Nothing here touches the database directly.
 */

const apiRoot = '/api/resource-allocation/v1';

export type AllocationRole =
  | 'ALLOCATION_USER'
  | 'ALLOCATION_MODERATOR'
  | 'ALLOCATION_SUPERVISOR'
  | 'ALLOCATION_MANAGER'
  | 'ALLOCATION_ADMIN';
export type Classification = 'INTERNAL' | 'THIRD_PARTY';

export interface PreparedPerson {
  id: string;
  localUserId: string;
  displayName: string;
  email: string;
  role: AllocationRole;
  classification: Classification | null;
  groupId: string | null;
  version: number;
}

export interface PreparedGroup {
  id: string;
  name: string;
  supervisorId: string | null;
  managerId: string | null;
}

export interface PreparedProfile {
  id: string;
  name: string;
  groupId: string;
}

export interface PreparedCapacity {
  id: string;
  effectiveDate: string;
  fte: number;
  classification: Classification;
}

export interface PersonSpec {
  localUserId: string;
  /** Required only when the person does not exist yet. */
  displayName?: string;
  classification?: Classification | null;
}

export interface TeamSpec {
  groupName: string;
  profileName: string;
  /** Group Supervisor (leadership). An existing profile such as `local-supervisor` is reused as is. */
  supervisor: PersonSpec;
  /** Group Manager. An existing profile such as `local-pmo` is reused as is. */
  manager: PersonSpec;
  /** People who belong to the group, created or moved into it with the given classification. */
  members: Array<PersonSpec & { role?: 'ALLOCATION_USER' | 'ALLOCATION_MODERATOR' }>;
}

export interface PreparedTeam {
  group: PreparedGroup;
  profile: PreparedProfile;
  supervisor: PreparedPerson;
  manager: PreparedPerson;
  members: PreparedPerson[];
}

export interface CapacitySpec {
  groupId: string;
  resourceProfileId: string;
  classification: Classification;
  effectiveDate: string;
  fte: number;
  reason?: string;
}

interface CollectionPage<T> {
  items: T[];
  page: { nextCursor: string | null };
}

function writeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [localProfileHeader]: localAdminUserId,
    'Idempotency-Key': randomUUID(),
    'X-Correlation-ID': randomUUID(),
    ...extra,
  };
}

async function expectOk(response: APIResponse, action: string): Promise<void> {
  if (response.ok()) return;
  throw new Error(`${action} failed with HTTP ${response.status()}: ${await response.text()}`);
}

async function listAll<T>(request: APIRequestContext, path: string, params: Record<string, string> = {}): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const response = await request.get(`${apiRoot}${path}`, {
      headers: { [localProfileHeader]: localAdminUserId },
      params: { ...params, limit: '100', ...(cursor ? { cursor } : {}) },
    });
    await expectOk(response, `GET ${path}`);
    const body = (await response.json()) as CollectionPage<T>;
    items.push(...body.items);
    cursor = body.page.nextCursor;
  } while (cursor);
  return items;
}

function emailFor(localUserId: string): string {
  return `${localUserId.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}@example.test`;
}

/** Finds a module person by Hub local profile ID, or returns null. */
export async function findPerson(request: APIRequestContext, localUserId: string): Promise<PreparedPerson | null> {
  const people = await listAll<PreparedPerson>(request, '/admin/people');
  return people.find((person) => person.localUserId === localUserId) ?? null;
}

/**
 * Ensures a person exists with the role. When `groupId` or `classification` are given, an existing
 * person is moved or reclassified to match; other fields of an existing person are left unchanged.
 */
export async function ensurePerson(
  request: APIRequestContext,
  spec: PersonSpec & { role: AllocationRole; groupId?: string | null },
): Promise<PreparedPerson> {
  const existing = await findPerson(request, spec.localUserId);
  if (!existing) {
    if (!spec.displayName) throw new Error(`Person ${spec.localUserId} does not exist and has no display name to create it.`);
    const response = await request.post(`${apiRoot}/admin/people`, {
      headers: writeHeaders(),
      data: {
        localUserId: spec.localUserId,
        displayName: spec.displayName,
        email: emailFor(spec.localUserId),
        role: spec.role,
        classification: spec.classification ?? null,
        groupId: spec.groupId ?? null,
      },
    });
    await expectOk(response, `Creating person ${spec.localUserId}`);
    return (await response.json()) as PreparedPerson;
  }
  if (existing.role !== spec.role) {
    throw new Error(`Person ${spec.localUserId} already exists as ${existing.role}, not ${spec.role}.`);
  }
  const changes: Record<string, unknown> = {};
  if (spec.groupId !== undefined && existing.groupId !== spec.groupId) changes.groupId = spec.groupId;
  if (spec.classification !== undefined && existing.classification !== spec.classification) changes.classification = spec.classification;
  if (Object.keys(changes).length === 0) return existing;
  const response = await request.patch(`${apiRoot}/admin/people/${existing.id}`, {
    headers: writeHeaders({ 'If-Match': `"${existing.version}"` }),
    data: changes,
  });
  await expectOk(response, `Updating person ${spec.localUserId}`);
  return (await response.json()) as PreparedPerson;
}

/** Ensures an active group with this name exists, created with the given Supervisor and Manager. */
export async function ensureGroup(
  request: APIRequestContext,
  name: string,
  supervisorId: string,
  managerId: string,
): Promise<PreparedGroup> {
  const groups = await listAll<PreparedGroup & { active: boolean }>(request, '/admin/groups');
  const existing = groups.find((group) => group.active && group.name === name);
  if (existing) return existing;
  const response = await request.post(`${apiRoot}/admin/groups`, {
    headers: writeHeaders(),
    data: { name, active: true, supervisorId, managerId },
  });
  await expectOk(response, `Creating group ${name}`);
  return (await response.json()) as PreparedGroup;
}

/** Ensures an active resource profile with this name exists in the group. */
export async function ensureProfile(request: APIRequestContext, groupId: string, name: string): Promise<PreparedProfile> {
  const profiles = await listAll<PreparedProfile & { active: boolean }>(request, '/admin/resource-profiles');
  const existing = profiles.find((profile) => profile.active && profile.groupId === groupId && profile.name === name);
  if (existing) return existing;
  const response = await request.post(`${apiRoot}/admin/resource-profiles`, {
    headers: writeHeaders(),
    data: { name, groupId, active: true },
  });
  await expectOk(response, `Creating resource profile ${name}`);
  return (await response.json()) as PreparedProfile;
}

/**
 * Ensures a group with leadership, one resource profile, and members. Leadership is created
 * without a group (it covers the group through the group record); members belong to the group.
 */
export async function prepareTeam(request: APIRequestContext, spec: TeamSpec): Promise<PreparedTeam> {
  const supervisor = await ensurePerson(request, { ...spec.supervisor, role: 'ALLOCATION_SUPERVISOR' });
  const manager = await ensurePerson(request, { ...spec.manager, role: 'ALLOCATION_MANAGER' });
  const group = await ensureGroup(request, spec.groupName, supervisor.id, manager.id);
  const profile = await ensureProfile(request, group.id, spec.profileName);
  const members: PreparedPerson[] = [];
  for (const member of spec.members) {
    members.push(await ensurePerson(request, { ...member, role: member.role ?? 'ALLOCATION_USER', groupId: group.id }));
  }
  return { group, profile, supervisor, manager, members };
}

/** Ensures an FTE capacity entry for the group, profile, and classification from the effective date. */
export async function ensureCapacity(request: APIRequestContext, spec: CapacitySpec): Promise<PreparedCapacity> {
  const entries = await listAll<PreparedCapacity>(request, '/capacities', {
    groupId: spec.groupId,
    resourceProfileId: spec.resourceProfileId,
    classification: spec.classification,
  });
  const existing = entries.find((entry) => entry.effectiveDate === spec.effectiveDate);
  if (existing) {
    if (existing.fte !== spec.fte) {
      throw new Error(`Capacity from ${spec.effectiveDate} already exists with ${existing.fte} FTE, not ${spec.fte}.`);
    }
    return existing;
  }
  const response = await request.post(`${apiRoot}/capacities`, {
    headers: writeHeaders(),
    data: {
      groupId: spec.groupId,
      resourceProfileId: spec.resourceProfileId,
      classification: spec.classification,
      effectiveDate: spec.effectiveDate,
      fte: spec.fte,
      reason: spec.reason ?? 'Prepared for a real browser journey.',
    },
  });
  await expectOk(response, `Creating capacity from ${spec.effectiveDate}`);
  return (await response.json()) as PreparedCapacity;
}
