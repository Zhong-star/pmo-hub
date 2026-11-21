import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { ResourceAllocationException } from '../../access/resource-allocation-problem';
import { parseUuidHeader } from '../../access/request-headers';
import { ResourceAllocationOperationReceipt } from './resource-allocation-operation-receipt.entity';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IdempotencyOperationInput {
  actorId: string;
  operation: string;
  key?: string;
  payload: unknown;
}

export interface IdempotentOperationResult<T> {
  result: T;
  replayed: boolean;
}

/**
 * Runs a create callback once for an actor, operation, and UUID key. Call this
 * with the EntityManager from the transaction that performs the mutation so
 * the receipt and the mutation commit or roll back together.
 */
export async function runIdempotentOperation<T>(
  manager: EntityManager,
  input: IdempotencyOperationInput,
  create: () => Promise<T>,
): Promise<IdempotentOperationResult<T>> {
  if (!manager.queryRunner?.isTransactionActive) {
    throw new Error('runIdempotentOperation must use the caller transaction EntityManager.');
  }

  const actorId = requireUuid(input.actorId, 'actor');
  const key = parseUuidHeader(input.key, 'Idempotency-Key');
  const operation = input.operation.trim();
  if (operation.length === 0 || operation.length > 200) {
    throw validationError('The operation identifier must contain between 1 and 200 characters.');
  }

  const payloadHash = hashPayload(input.payload);

  // Hashing a canonical tuple gives PostgreSQL one stable, unambiguous lock key.
  // A rare 64-bit hash collision only serializes unrelated operations; it cannot
  // make them share receipts because the actual lookup remains fully scoped.
  const lockKey = JSON.stringify([actorId, operation, key]);
  await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

  const receipts = manager.getRepository(ResourceAllocationOperationReceipt);
  const previous = await receipts.findOne({ where: { actorId, operation, key } });
  if (previous) {
    if (previous.payloadHash !== payloadHash) {
      throw new ResourceAllocationException(
        'RESOURCE_CONFLICT',
        'Idempotency key already used',
        409,
        'This Idempotency-Key was already used with different request content.',
      );
    }
    const storedResponse = previous.responseBody as { value?: T };
    return { result: storedResponse.value as T, replayed: true };
  }

  const result = await create();
  const responseBody = snapshotJsonResult(result);
  await receipts.save(receipts.create({
    actorId,
    operation,
    key,
    payloadHash,
    responseBody,
  }));

  return { result: responseBody.value as T, replayed: false };
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw validationError(`${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** Sort object keys recursively while preserving array order and null values. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  // At the top level, an absent body is distinct from an explicit JSON null.
  // Object properties with undefined values are omitted below as absent fields.
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw validationError('Request content must be valid JSON.');
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw validationError('Request content must be valid JSON.');
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw validationError('Request content must not contain cycles.');
    ancestors.add(value);
    const canonical = `[${value.map((item) => {
      if (item === undefined) throw validationError('Request content must be valid JSON.');
      return canonicalJson(item, ancestors);
    }).join(',')}]`;
    ancestors.delete(value);
    return canonical;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (ancestors.has(object)) throw validationError('Request content must not contain cycles.');
    ancestors.add(object);
    // Undefined DTO properties are equivalent to omitted properties; explicit
    // null remains encoded and therefore hashes differently from omission.
    const entries = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`);
    ancestors.delete(object);
    return `{${entries.join(',')}}`;
  }
  throw validationError('Request content must be valid JSON.');
}

function snapshotJsonResult<T>(result: T): { value?: T } {
  let serialized: string | undefined;
  try {
    // The envelope keeps a null JSON result distinct from a missing response,
    // while also ensuring PostgreSQL receives a non-null JSONB value.
    serialized = JSON.stringify({ value: result });
  } catch {
    throw new Error('The operation result cannot be stored as JSON.');
  }
  if (serialized === undefined) {
    throw new Error('The operation result cannot be stored as JSON.');
  }
  return JSON.parse(serialized) as { value?: T };
}

function validationError(detail: string): ResourceAllocationException {
  return new ResourceAllocationException(
    'VALIDATION_ERROR',
    'Request validation failed',
    400,
    detail,
  );
}
