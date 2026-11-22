import type { EntityManager } from 'typeorm';
import { ResourceAllocationException } from '../access/resource-allocation-problem';
import { ResourceRequest } from './resource-request.entity';
import { ResourceRequestAudit, type ResourceRequestRemovalAction } from './resource-request-audit.entity';
import { ResourceRequestHistory } from './resource-request-history.entity';

export interface RemoveResourceRequestInput {
  request: ResourceRequest;
  action: ResourceRequestRemovalAction;
  actorSnapshot: { personId: string; displayName: string; role: string };
  reason: string;
  correlationId: string;
}

/**
 * Soft-removes an already locked request while preserving all references and
 * atomically recording the audit, history, and durable submission outcome.
 * Call this with the transaction manager that owns the request lock.
 */
export async function removeResourceRequest(
  manager: EntityManager,
  input: RemoveResourceRequestInput,
): Promise<ResourceRequestAudit> {
  if (!manager.queryRunner?.isTransactionActive) {
    throw new Error('removeResourceRequest must use a transaction EntityManager.');
  }
  if (input.request.removedAt) {
    throw new ResourceAllocationException('RESOURCE_CONFLICT', 'Request already removed', 409, 'This request has already been removed from the operation.');
  }

  const timestamps = await manager.query('SELECT clock_timestamp() AS removed_at') as Array<{ removed_at: Date }>;
  const removedAt = timestamps[0].removed_at;
  const removalSnapshot = {
    action: input.action,
    reason: input.reason,
    removedAt: removedAt.toISOString(),
  };
  const requestSnapshot = {
    id: input.request.id,
    requesterId: input.request.requesterId,
    requesterSnapshot: input.request.requesterSnapshot,
    requestedConditions: input.request.requestedConditions,
    decisionState: input.request.decisionState,
    receivedAt: input.request.receivedAt.toISOString(),
    stageEnteredAt: input.request.stageEnteredAt.toISOString(),
    expirationDueAt: input.request.expirationDueAt.toISOString(),
    version: input.request.version,
  };

  const updated = await manager.query(
    `WITH changed AS (
       UPDATE resource_requests
       SET removed_at = $1, version = version + 1
       WHERE id = $2 AND removed_at IS NULL
       RETURNING version
     )
     SELECT version FROM changed`,
    [removedAt, input.request.id],
  ) as Array<{ version: number }>;
  if (updated.length === 0) {
    throw new ResourceAllocationException('RESOURCE_CONFLICT', 'Request already removed', 409, 'This request has already been removed from the operation.');
  }

  const auditRepository = manager.getRepository(ResourceRequestAudit);
  const audit = await auditRepository.save(auditRepository.create({
    requestId: input.request.id,
    action: input.action,
    requesterSnapshot: input.request.requesterSnapshot,
    actorSnapshot: input.actorSnapshot,
    requestSnapshot,
    reason: input.reason,
    correlationId: input.correlationId,
    occurredAt: removedAt,
  }));

  await manager.getRepository(ResourceRequestHistory).insert({
    requestId: input.request.id,
    actorSnapshot: input.actorSnapshot,
    action: input.action,
    afterSnapshot: { requestId: input.request.id, removal: removalSnapshot },
    correlationId: input.correlationId,
    occurredAt: removedAt,
  });
  await manager.query(
    `UPDATE resource_submission_lines
     SET request_outcome = $1::jsonb
     WHERE request_id = $2 AND status = 'SUCCEEDED'`,
    [JSON.stringify({ status: 'REMOVED', ...removalSnapshot }), input.request.id],
  );

  input.request.removedAt = removedAt;
  input.request.version = Number(updated[0].version);
  return audit;
}
