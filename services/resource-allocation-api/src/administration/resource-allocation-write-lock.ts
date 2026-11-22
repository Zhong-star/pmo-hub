import type { EntityManager } from 'typeorm';

const resourceAllocationWriteLockKey = 20261120;
const resourceAllocationWriteLockScope = 59;

/** Shared serialization point for administrative eligibility changes and request creation. */
export async function lockResourceAllocationAdministrationWrites(manager: EntityManager): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [resourceAllocationWriteLockKey, resourceAllocationWriteLockScope]);
}
