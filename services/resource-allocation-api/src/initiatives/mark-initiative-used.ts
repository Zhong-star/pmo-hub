import type { EntityManager } from 'typeorm';
import { ResourceAllocationException } from '../access/resource-allocation-problem';

/** Call inside the same transaction that creates the first request for this ITDM. */
export async function markInitiativeUsedForRequest(manager: EntityManager, initiativeId: string): Promise<void> {
  const [initiative] = await manager.query(
    'SELECT code_used FROM resource_initiatives WHERE id = $1 FOR UPDATE',
    [initiativeId],
  ) as Array<{ code_used: boolean }>;
  if (!initiative) {
    throw new ResourceAllocationException('INELIGIBLE_REFERENCE', 'Ineligible reference', 422, 'The selected ITDM is unavailable.');
  }
  if (!initiative.code_used) {
    await manager.query(
      'UPDATE resource_initiatives SET code_used = TRUE, version = version + 1 WHERE id = $1',
      [initiativeId],
    );
  }
}
