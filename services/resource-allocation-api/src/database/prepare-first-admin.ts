import { DataSource, type EntityManager } from 'typeorm';
import { ResourcePerson } from '../people/resource-person.entity';
import { ResourceAllocationRole } from '../people/resource-allocation-role';

export interface FirstAdminInput {
  localUserId: string;
  displayName: string;
  email: string;
}

export interface FirstAdminResult {
  created: boolean;
  person: ResourcePerson;
}

function validateInput(input: FirstAdminInput): FirstAdminInput {
  const localUserId = input.localUserId.trim();
  const displayName = input.displayName.trim();
  const email = input.email.trim();
  if (!localUserId || localUserId.length > 200) throw new Error('The Hub local profile ID must contain 1 to 200 characters.');
  if (!displayName || displayName.length > 200) throw new Error('The Admin display name must contain 1 to 200 characters.');
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('The Admin email address is invalid.');
  }
  return { localUserId, displayName, email };
}

async function findActiveAdmin(manager: EntityManager): Promise<ResourcePerson | null> {
  return manager.getRepository(ResourcePerson).findOne({
    where: { role: ResourceAllocationRole.Admin, active: true },
    order: { localUserId: 'ASC', id: 'ASC' },
  });
}

export async function prepareFirstAdmin(dataSource: DataSource, input: FirstAdminInput): Promise<FirstAdminResult> {
  const normalized = validateInput(input);
  return dataSource.transaction(async (manager) => {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext('pmo.resource-allocation.first-admin'))");
    const activeAdmin = await findActiveAdmin(manager);
    if (activeAdmin) return { created: false, person: activeAdmin };

    const people = manager.getRepository(ResourcePerson);
    const existing = await people.findOne({ where: { localUserId: normalized.localUserId } });
    if (existing) {
      throw new Error('The configured Hub profile already has a Resource Allocation record. It was left unchanged; resolve the existing record before preparing the first Admin.');
    }

    const person = people.create({
      ...normalized,
      role: ResourceAllocationRole.Admin,
      active: true,
      coveredGroupIds: [],
    });
    return { created: true, person: await people.save(person) };
  });
}

async function run(): Promise<void> {
  const { ResourceAllocationDataSource } = await import('./data-source');
  const input = validateInput({
    localUserId: process.env.RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID ?? '',
    displayName: process.env.RESOURCE_ALLOCATION_FIRST_ADMIN_DISPLAY_NAME ?? '',
    email: process.env.RESOURCE_ALLOCATION_FIRST_ADMIN_EMAIL ?? '',
  });

  await ResourceAllocationDataSource.initialize();
  try {
    const result = await prepareFirstAdmin(ResourceAllocationDataSource, input);
    if (result.created) {
      console.log(`Prepared the first Tech Resource Allocation Admin for Hub profile ${result.person.localUserId}.`);
    } else {
      console.log(`An active Tech Resource Allocation Admin is already configured for Hub profile ${result.person.localUserId}; no records were changed.`);
    }
  } finally {
    await ResourceAllocationDataSource.destroy();
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'First Admin preparation failed.');
    process.exitCode = 1;
  });
}
