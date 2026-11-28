import { SubmissionRequestError, type CreateSubmissionInput } from './submissionApi';

export interface StoredEnvelope {
  idempotencyKey: string;
  payload: CreateSubmissionInput;
  savedAt: string;
}

export function outboxStorageKey(localUserId: string) {
  return `pmo-hub.resource-allocation.submission-outbox:${encodeURIComponent(localUserId)}`;
}

export function readOutbox(localUserId: string): StoredEnvelope | null {
  try {
    const stored = window.localStorage.getItem(outboxStorageKey(localUserId));
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<StoredEnvelope>;
    if (typeof value.idempotencyKey !== 'string' || !value.payload || typeof value.savedAt !== 'string') return null;
    return value as StoredEnvelope;
  } catch {
    return null;
  }
}

export function saveOutbox(localUserId: string, envelope: StoredEnvelope) {
  try {
    window.localStorage.setItem(outboxStorageKey(localUserId), JSON.stringify(envelope));
  } catch {
    // The form remains usable; durable local recovery stays best-effort.
  }
}

export function clearOutbox(localUserId: string) {
  try {
    window.localStorage.removeItem(outboxStorageKey(localUserId));
  } catch {
    // Clearing a browser-only recovery copy must not interrupt the server flow.
  }
}

export function hasSubmissionAccessError(error: unknown) {
  return error instanceof SubmissionRequestError && (error.status === 401 || error.status === 403);
}
