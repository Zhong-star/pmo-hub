import axios from 'axios';
import type { ResourceRequestItem } from './requestApi';

const API_ROOT = '/api/resource-allocation/v1';

export interface RequestHistoryEvent {
  id: string;
  action: string;
  actorSnapshot: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string | null;
  occurredAt: string;
  correlationId: string;
}

export interface RequestHistoryCollection {
  items: RequestHistoryEvent[];
  page: { nextCursor: string | null; limit: number };
  latestDenial?: RequestHistoryEvent | null;
  latestResponse?: RequestHistoryEvent | null;
}

interface RequestDecisionProblem {
  code?: string;
  detail?: string;
  title?: string;
}

export class RequestDecisionApiError extends Error {
  constructor(readonly status: number | null, readonly problem: RequestDecisionProblem | null) {
    super(problem?.detail ?? problem?.title ?? (status === null
      ? 'The request decision service could not be reached.'
      : `The request decision failed with status ${status}.`));
    this.name = 'RequestDecisionApiError';
  }
}

const api = axios.create({
  baseURL: import.meta.env.VITE_RESOURCE_ALLOCATION_API_BASE_URL ?? '',
  timeout: 10_000,
});

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

function parseProblem(payload: unknown): RequestDecisionProblem | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  return {
    code: typeof value.code === 'string' ? value.code : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
    title: typeof value.title === 'string' ? value.title : undefined,
  };
}

function throwDecisionError(error: unknown): never {
  if (axios.isAxiosError(error)) {
    throw new RequestDecisionApiError(error.response?.status ?? null, parseProblem(error.response?.data));
  }
  throw error;
}

export async function getRequestHistory(localUserId: string, requestId: string, cursor: string | null = null): Promise<RequestHistoryCollection> {
  try {
    const response = await api.get<RequestHistoryCollection>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/history`, {
      headers: headers(localUserId),
      params: { limit: 50, ...(cursor ? { cursor } : {}) },
    });
    return response.data;
  } catch (error) {
    return throwDecisionError(error);
  }
}

async function postDecision(
  localUserId: string,
  requestId: string,
  action: 'denials' | 'contests' | 'cancellations',
  version: number,
  idempotencyKey: string,
  payload: { explanation?: string; reason?: string },
): Promise<ResourceRequestItem> {
  try {
    const response = await api.post<ResourceRequestItem>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/${action}`, payload, {
      headers: {
        ...headers(localUserId),
        'If-Match': `"${version}"`,
        'Idempotency-Key': idempotencyKey,
      },
    });
    return response.data;
  } catch (error) {
    return throwDecisionError(error);
  }
}

export function denyRequest(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  explanation: string,
) {
  return postDecision(localUserId, requestId, 'denials', version, idempotencyKey, { explanation });
}

export function contestDeniedRequest(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  explanation: string,
) {
  return postDecision(localUserId, requestId, 'contests', version, idempotencyKey, { explanation });
}

export function cancelDeniedRequest(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  reason: string,
) {
  return postDecision(localUserId, requestId, 'cancellations', version, idempotencyKey, { reason });
}
