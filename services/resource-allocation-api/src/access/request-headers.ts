import { randomUUID } from 'node:crypto';
import { ResourceAllocationException } from './resource-allocation-problem';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseStrongVersionIfMatch(
  value: string | undefined,
  detail = 'A single strong If-Match version is required.',
  requireSafeInteger = true,
): number {
  const match = value?.match(/^"([1-9][0-9]*)"$/);
  const version = match ? Number(match[1]) : Number.NaN;
  if (!match || (requireSafeInteger && !Number.isSafeInteger(version))) {
    throw validationError(detail);
  }
  return version;
}

export function parseOpaqueIfMatch(
  value: string | undefined,
  pattern: RegExp,
  detail: string,
): string {
  if (!value || !pattern.test(value)) throw validationError(detail);
  return value;
}

export function parseUuidHeader(
  value: string | undefined,
  field: 'Idempotency-Key' | 'X-Correlation-ID',
  detail = field === 'Idempotency-Key' ? 'Idempotency-Key must be a UUID.' : 'A valid X-Correlation-ID is required.',
  pattern: RegExp = uuidPattern,
): string {
  if (!value || !pattern.test(value)) throw validationError(detail);
  return value.toLowerCase();
}

/** Uses a valid client correlation ID, or replaces a missing or untrusted one (api-conventions: replaced, not rejected). */
export function correlationIdOrNew(value: string | undefined): string {
  return value && uuidPattern.test(value) ? value.toLowerCase() : randomUUID();
}

function validationError(detail: string): ResourceAllocationException {
  return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, detail);
}
