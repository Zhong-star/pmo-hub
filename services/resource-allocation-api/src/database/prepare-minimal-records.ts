import { DataSource, type EntityManager } from 'typeorm';
import { lockResourceAllocationAdministrationWrites } from '../administration/resource-allocation-write-lock';
import { ResourceGroup } from '../groups/resource-group.entity';
import { ResourceInitiative } from '../initiatives/resource-initiative.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceProfile } from '../resource-profiles/resource-profile.entity';

export interface MinimalPersonInput {
  localUserId: string;
  displayName: string;
  email: string;
}

export interface PrepareMinimalRecordsOptions {
  groupName?: string;
  profileNames?: string[];
  initiativeCode?: string;
  initiativeName?: string;
  supervisor?: Partial<MinimalPersonInput>;
  manager?: Partial<MinimalPersonInput>;
  moderator?: Partial<MinimalPersonInput>;
  user?: Partial<MinimalPersonInput>;
}

export interface NormalizedMinimalRecordsConfig {
  groupName: string;
  profileNames: string[];
  initiativeCode: string;
  initiativeName: string;
  supervisor: MinimalPersonInput;
  manager: MinimalPersonInput;
  moderator: MinimalPersonInput;
  user: MinimalPersonInput;
}

export interface PrepareMinimalRecordsResult {
  groupCreated: boolean;
  group: ResourceGroup;
  profilesCreated: number;
  profiles: ResourceProfile[];
  initiativeCreated: boolean;
  initiative: ResourceInitiative;
  peopleCreated: number;
  people: ResourcePerson[];
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const defaultMinimalConfig: NormalizedMinimalRecordsConfig = {
  groupName: 'Platform Engineering',
  profileNames: ['Software Engineer', 'Solutions Architect'],
  initiativeCode: 'ITDM-LOCAL-001',
  initiativeName: 'Local Operational Baseline',
  supervisor: {
    localUserId: 'local-supervisor',
    displayName: 'Local Group Supervisor',
    email: 'local-supervisor@example.test',
  },
  manager: {
    localUserId: 'local-pmo',
    displayName: 'Local PMO',
    email: 'local-pmo@example.test',
  },
  moderator: {
    localUserId: 'local-moderator',
    displayName: 'Local Group Moderator',
    email: 'local-moderator@example.test',
  },
  user: {
    localUserId: 'local-contributor',
    displayName: 'Local Contributor',
    email: 'local-contributor@example.test',
  },
};

function normalizeRequiredText(value: string, label: string, maxLength?: number): string {
  const normalized = value.trim();
  if (!normalized || (maxLength !== undefined && normalized.length > maxLength)) {
    throw new Error(
      maxLength === undefined
        ? `${label} must not be empty.`
        : `${label} must contain 1 to ${maxLength} characters.`,
    );
  }
  return normalized;
}

function normalizePersonInput(
  roleLabel: string,
  defaults: MinimalPersonInput,
  overrides?: Partial<MinimalPersonInput>,
): MinimalPersonInput {
  const localUserId = normalizeRequiredText(
    overrides?.localUserId ?? defaults.localUserId,
    `${roleLabel} Hub local profile ID`,
    200,
  );
  const displayName = normalizeRequiredText(
    overrides?.displayName ?? defaults.displayName,
    `${roleLabel} display name`,
    200,
  );
  const email = (overrides?.email ?? defaults.email).trim();
  if (!email || email.length > 320 || !emailPattern.test(email)) {
    throw new Error(`${roleLabel} email address is invalid.`);
  }
  return { localUserId, displayName, email };
}

function normalizeProfileNames(names: string[] | undefined): string[] {
  const rawNames = names ?? defaultMinimalConfig.profileNames;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawName of rawNames) {
    const trimmed = normalizeRequiredText(rawName, 'Initial resource profile name');
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  if (normalized.length === 0) {
    throw new Error('At least one initial resource profile name must be provided.');
  }
  return normalized;
}

export function normalizeMinimalRecordsOptions(
  options: PrepareMinimalRecordsOptions = {},
): NormalizedMinimalRecordsConfig {
  const supervisor = normalizePersonInput('Supervisor', defaultMinimalConfig.supervisor, options.supervisor);
  const manager = normalizePersonInput('Manager', defaultMinimalConfig.manager, options.manager);
  const moderator = normalizePersonInput('Moderator', defaultMinimalConfig.moderator, options.moderator);
  const user = normalizePersonInput('User', defaultMinimalConfig.user, options.user);

  const configuredIds = [supervisor.localUserId, manager.localUserId, moderator.localUserId, user.localUserId];
  if (new Set(configuredIds).size !== configuredIds.length) {
    throw new Error('Minimal local people must each have a distinct Hub local profile ID.');
  }

  return {
    groupName: normalizeRequiredText(options.groupName ?? defaultMinimalConfig.groupName, 'Minimal group name'),
    profileNames: normalizeProfileNames(options.profileNames),
    initiativeCode: normalizeRequiredText(
      options.initiativeCode ?? defaultMinimalConfig.initiativeCode,
      'Minimal ITDM code',
      100,
    ),
    initiativeName: normalizeRequiredText(
      options.initiativeName ?? defaultMinimalConfig.initiativeName,
      'Minimal ITDM name',
      200,
    ),
    supervisor,
    manager,
    moderator,
    user,
  };
}

export function readMinimalRecordsOptionsFromEnv(
  environment: Record<string, string | undefined> = process.env,
): PrepareMinimalRecordsOptions {
  const rawProfiles = environment.RESOURCE_ALLOCATION_MINIMAL_PROFILE_NAMES;
  return {
    ...(environment.RESOURCE_ALLOCATION_MINIMAL_GROUP_NAME !== undefined
      ? { groupName: environment.RESOURCE_ALLOCATION_MINIMAL_GROUP_NAME }
      : {}),
    ...(rawProfiles !== undefined ? { profileNames: rawProfiles.split(',') } : {}),
    ...(environment.RESOURCE_ALLOCATION_MINIMAL_INITIATIVE_CODE !== undefined
      ? { initiativeCode: environment.RESOURCE_ALLOCATION_MINIMAL_INITIATIVE_CODE }
      : {}),
    ...(environment.RESOURCE_ALLOCATION_MINIMAL_INITIATIVE_NAME !== undefined
      ? { initiativeName: environment.RESOURCE_ALLOCATION_MINIMAL_INITIATIVE_NAME }
      : {}),
    supervisor: {
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_SUPERVISOR_LOCAL_USER_ID !== undefined
        ? { localUserId: environment.RESOURCE_ALLOCATION_MINIMAL_SUPERVISOR_LOCAL_USER_ID }
        : {}),
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_SUPERVISOR_DISPLAY_NAME !== undefined
        ? { displayName: environment.RESOURCE_ALLOCATION_MINIMAL_SUPERVISOR_DISPLAY_NAME }
        : {}),
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_SUPERVISOR_EMAIL !== undefined
        ? { email: environment.RESOURCE_ALLOCATION_MINIMAL_SUPERVISOR_EMAIL }
        : {}),
    },
    manager: {
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_MANAGER_LOCAL_USER_ID !== undefined
        ? { localUserId: environment.RESOURCE_ALLOCATION_MINIMAL_MANAGER_LOCAL_USER_ID }
        : {}),
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_MANAGER_DISPLAY_NAME !== undefined
        ? { displayName: environment.RESOURCE_ALLOCATION_MINIMAL_MANAGER_DISPLAY_NAME }
        : {}),
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_MANAGER_EMAIL !== undefined
        ? { email: environment.RESOURCE_ALLOCATION_MINIMAL_MANAGER_EMAIL }
        : {}),
    },
    moderator: {
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_MODERATOR_LOCAL_USER_ID !== undefined
        ? { localUserId: environment.RESOURCE_ALLOCATION_MINIMAL_MODERATOR_LOCAL_USER_ID }
        : {}),
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_MODERATOR_DISPLAY_NAME !== undefined
        ? { displayName: environment.RESOURCE_ALLOCATION_MINIMAL_MODERATOR_DISPLAY_NAME }
        : {}),
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_MODERATOR_EMAIL !== undefined
        ? { email: environment.RESOURCE_ALLOCATION_MINIMAL_MODERATOR_EMAIL }
        : {}),
    },
    user: {
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_USER_LOCAL_USER_ID !== undefined
        ? { localUserId: environment.RESOURCE_ALLOCATION_MINIMAL_USER_LOCAL_USER_ID }
        : {}),
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_USER_DISPLAY_NAME !== undefined
        ? { displayName: environment.RESOURCE_ALLOCATION_MINIMAL_USER_DISPLAY_NAME }
        : {}),
      ...(environment.RESOURCE_ALLOCATION_MINIMAL_USER_EMAIL !== undefined
        ? { email: environment.RESOURCE_ALLOCATION_MINIMAL_USER_EMAIL }
        : {}),
    },
  };
}

async function ensureResponsiblePerson(
  manager: EntityManager,
  role: ResourceAllocationRole.Supervisor | ResourceAllocationRole.Manager,
  input: MinimalPersonInput,
  envHint: string,
): Promise<{ created: boolean; person: ResourcePerson }> {
  const people = manager.getRepository(ResourcePerson);
  const existingById = await people.findOne({ where: { localUserId: input.localUserId } });
  if (existingById) {
    if (existingById.active && existingById.role === role) {
      return { created: false, person: existingById };
    }
    const existingActiveForRole = await people.findOne({
      where: { role, active: true },
      order: { localUserId: 'ASC', id: 'ASC' },
    });
    if (existingActiveForRole) {
      return { created: false, person: existingActiveForRole };
    }
    const roleLabel = role === ResourceAllocationRole.Supervisor ? 'Supervisor' : 'Manager';
    throw new Error(
      `The configured ${roleLabel} Hub profile (${input.localUserId}) already has a Resource Allocation record with a different role or inactive status. It was left unchanged; configure ${envHint} or register an active ${roleLabel} first.`,
    );
  }

  const created = await people.save(
    people.create({
      ...input,
      role,
      active: true,
      groupId: null,
      coveredGroupIds: [],
    }),
  );
  return { created: true, person: created };
}

async function ensureOptionalPerson(
  manager: EntityManager,
  role: ResourceAllocationRole.Supervisor | ResourceAllocationRole.Manager | ResourceAllocationRole.Moderator | ResourceAllocationRole.User,
  input: MinimalPersonInput,
  groupId: string | null,
): Promise<{ created: boolean; person: ResourcePerson }> {
  const people = manager.getRepository(ResourcePerson);
  const existing = await people.findOne({ where: { localUserId: input.localUserId } });
  if (existing) {
    return { created: false, person: existing };
  }
  const created = await people.save(
    people.create({
      ...input,
      role,
      active: true,
      groupId,
      coveredGroupIds: [],
    }),
  );
  return { created: true, person: created };
}

async function refreshLeadershipCoverage(manager: EntityManager, personIds: string[]): Promise<void> {
  const people = manager.getRepository(ResourcePerson);
  const groups = manager.getRepository(ResourceGroup);
  for (const personId of [...new Set(personIds)]) {
    const person = await people.findOne({ where: { id: personId } });
    if (!person) continue;
    const coveredGroups = await groups.find({
      where: [
        { active: true, supervisorId: person.id },
        { active: true, managerId: person.id },
      ],
      order: { id: 'ASC' },
    });
    const coveredGroupIds = coveredGroups.map((group) => group.id);
    if (
      person.coveredGroupIds.length !== coveredGroupIds.length ||
      person.coveredGroupIds.some((id, index) => id !== coveredGroupIds[index])
    ) {
      person.coveredGroupIds = coveredGroupIds;
      await people.save(person);
    }
  }
}

async function findExistingGroup(manager: EntityManager, groupName: string): Promise<ResourceGroup | null> {
  const groups = manager.getRepository(ResourceGroup);
  const byName = await groups
    .createQueryBuilder('group')
    .where('LOWER(BTRIM(group.name)) = LOWER(BTRIM(:name))', { name: groupName })
    .orderBy('group.id', 'ASC')
    .getOne();
  if (byName) return byName;

  return groups
    .createQueryBuilder('group')
    .orderBy('group.active', 'DESC')
    .addOrderBy('group.id', 'ASC')
    .getOne();
}

async function findExistingNonDemoInitiative(
  manager: EntityManager,
  initiativeCode: string,
): Promise<ResourceInitiative | null> {
  const initiatives = manager.getRepository(ResourceInitiative);
  const byCode = await initiatives
    .createQueryBuilder('initiative')
    .where('LOWER(BTRIM(initiative.code)) = LOWER(BTRIM(:code))', { code: initiativeCode })
    .getOne();
  if (byCode) return byCode;

  return initiatives
    .createQueryBuilder('initiative')
    .where("LOWER(BTRIM(initiative.code)) NOT LIKE 'itdm-demo-%'")
    .orderBy('initiative.active', 'DESC')
    .addOrderBy('initiative.id', 'ASC')
    .getOne();
}

export async function ensureMinimalOperationalBaseline(
  manager: EntityManager,
  options: PrepareMinimalRecordsOptions = {},
): Promise<PrepareMinimalRecordsResult> {
  const config = normalizeMinimalRecordsOptions(options);
  const createdPeople: ResourcePerson[] = [];
  const trackedPeople = new Map<string, ResourcePerson>();

  const existingGroup = await findExistingGroup(manager, config.groupName);
  let groupCreated = false;
  let group: ResourceGroup;

  if (existingGroup) {
    group = existingGroup;
    const supervisorResult = await ensureOptionalPerson(
      manager,
      ResourceAllocationRole.Supervisor,
      config.supervisor,
      null,
    );
    if (supervisorResult.created) createdPeople.push(supervisorResult.person);
    trackedPeople.set(supervisorResult.person.id, supervisorResult.person);

    const managerResult = await ensureOptionalPerson(
      manager,
      ResourceAllocationRole.Manager,
      config.manager,
      null,
    );
    if (managerResult.created) createdPeople.push(managerResult.person);
    trackedPeople.set(managerResult.person.id, managerResult.person);
  } else {
    const supervisorResult = await ensureResponsiblePerson(
      manager,
      ResourceAllocationRole.Supervisor,
      config.supervisor,
      'RESOURCE_ALLOCATION_MINIMAL_SUPERVISOR_LOCAL_USER_ID',
    );
    if (supervisorResult.created) createdPeople.push(supervisorResult.person);

    const managerResult = await ensureResponsiblePerson(
      manager,
      ResourceAllocationRole.Manager,
      config.manager,
      'RESOURCE_ALLOCATION_MINIMAL_MANAGER_LOCAL_USER_ID',
    );
    if (managerResult.created) createdPeople.push(managerResult.person);

    const groupRepo = manager.getRepository(ResourceGroup);
    group = await groupRepo.save(
      groupRepo.create({
        name: config.groupName,
        active: true,
        supervisorId: supervisorResult.person.id,
        managerId: managerResult.person.id,
      }),
    );
    groupCreated = true;
    await refreshLeadershipCoverage(manager, [supervisorResult.person.id, managerResult.person.id]);

    const refreshedSupervisor = await manager.getRepository(ResourcePerson).findOneByOrFail({
      id: supervisorResult.person.id,
    });
    const refreshedManager = await manager.getRepository(ResourcePerson).findOneByOrFail({
      id: managerResult.person.id,
    });
    trackedPeople.set(refreshedSupervisor.id, refreshedSupervisor);
    trackedPeople.set(refreshedManager.id, refreshedManager);
  }

  const moderatorExisting = await manager.getRepository(ResourcePerson).findOne({
    where: { localUserId: config.moderator.localUserId },
  });
  if (moderatorExisting) {
    trackedPeople.set(moderatorExisting.id, moderatorExisting);
  } else if (group.active) {
    const moderatorResult = await ensureOptionalPerson(
      manager,
      ResourceAllocationRole.Moderator,
      config.moderator,
      group.id,
    );
    if (moderatorResult.created) createdPeople.push(moderatorResult.person);
    trackedPeople.set(moderatorResult.person.id, moderatorResult.person);
  }

  const userResult = await ensureOptionalPerson(
    manager,
    ResourceAllocationRole.User,
    config.user,
    group.active ? group.id : null,
  );
  if (userResult.created) createdPeople.push(userResult.person);
  trackedPeople.set(userResult.person.id, userResult.person);

  const profileRepo = manager.getRepository(ResourceProfile);
  const existingProfiles = await profileRepo.find({
    where: { groupId: group.id },
    order: { name: 'ASC', id: 'ASC' },
  });
  let profiles: ResourceProfile[];
  let profilesCreated = 0;
  if (existingProfiles.length > 0) {
    profiles = existingProfiles;
  } else if (group.active) {
    const savedProfiles = await profileRepo.save(
      config.profileNames.map((name) =>
        profileRepo.create({
          name,
          groupId: group.id,
          active: true,
        }),
      ),
    );
    profiles = savedProfiles.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    profilesCreated = profiles.length;
  } else {
    profiles = [];
  }

  const initiativeRepo = manager.getRepository(ResourceInitiative);
  const existingInitiative = await findExistingNonDemoInitiative(manager, config.initiativeCode);
  let initiativeCreated = false;
  let initiative: ResourceInitiative;
  if (existingInitiative) {
    initiative = existingInitiative;
  } else {
    initiative = await initiativeRepo.save(
      initiativeRepo.create({
        code: config.initiativeCode,
        name: config.initiativeName,
        active: true,
        codeUsed: false,
      }),
    );
    initiativeCreated = true;
  }

  return {
    groupCreated,
    group,
    profilesCreated,
    profiles,
    initiativeCreated,
    initiative,
    peopleCreated: createdPeople.length,
    people: [...trackedPeople.values()],
  };
}

export async function prepareMinimalRecords(
  dataSource: DataSource,
  options: PrepareMinimalRecordsOptions = {},
): Promise<PrepareMinimalRecordsResult> {
  normalizeMinimalRecordsOptions(options);
  return dataSource.transaction(async (manager) => {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext('pmo.resource-allocation.minimal-records'))");
    await lockResourceAllocationAdministrationWrites(manager);
    return ensureMinimalOperationalBaseline(manager, options);
  });
}

async function run(): Promise<void> {
  const { ResourceAllocationDataSource } = await import('./data-source');
  const options = readMinimalRecordsOptionsFromEnv();
  normalizeMinimalRecordsOptions(options);

  await ResourceAllocationDataSource.initialize();
  try {
    const result = await prepareMinimalRecords(ResourceAllocationDataSource, options);
    const createdTotal =
      (result.groupCreated ? 1 : 0) +
      result.profilesCreated +
      (result.initiativeCreated ? 1 : 0) +
      result.peopleCreated;
    if (createdTotal === 0) {
      console.log('Minimal Tech Resource Allocation baseline records already exist; no records were changed.');
    } else {
      console.log(
        `Prepared minimal Tech Resource Allocation records (group: ${result.group.name}, profiles: ${result.profiles.length}, ITDM: ${result.initiative.code}, new people: ${result.peopleCreated}).`,
      );
    }
  } finally {
    await ResourceAllocationDataSource.destroy();
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Minimal records preparation failed.');
    process.exitCode = 1;
  });
}
