import { api, throwApiRequestError, ResourceAllocationApiError } from './apiClient';
import type { ApiProblem, ApiRequestBody, ApiResponse } from './apiContracts';

const API_ROOT = '/api/resource-allocation/v1';

export type RequestHistoryCollection = ApiResponse<'/api/resource-allocation/v1/requests/{id}/history', 'get'>;
export type RequestHistoryEvent = RequestHistoryCollection['items'][number];
type RequestDecisionProblem = ApiProblem;
type RequestDecisionAction = 'denials' | 'contests' | 'cancellations';
type RequestDecisionPath<Action extends RequestDecisionAction> = `/api/resource-allocation/v1/requests/{id}/${Action}`;
export type RequestDecisionResult = ApiResponse<RequestDecisionPath<'denials'>, 'post'>;

export class RequestDecisionApiError extends ResourceAllocationApiError {
  constructor(status: number | null, problem: RequestDecisionProblem | null) {
    super(status, problem, status === null ? 'The request decision service could not be reached.' : `The request decision failed with status ${status}.`, 'RequestDecisionApiError');
  }
}

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

export async function getRequestHistory(localUserId: string, requestId: string, cursor: string | null = null): Promise<RequestHistoryCollection> {
  try {
    const response = await api.get<RequestHistoryCollection>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/history`, {
      headers: headers(localUserId),
      params: { limit: 50, ...(cursor ? { cursor } : {}) },
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, RequestDecisionApiError);
  }
}

async function postDecision<Action extends RequestDecisionAction>(
  localUserId: string,
  requestId: string,
  action: Action,
  version: number,
  idempotencyKey: string,
  payload: ApiRequestBody<RequestDecisionPath<Action>, 'post'>,
): Promise<ApiResponse<RequestDecisionPath<Action>, 'post'>> {
  try {
    const response = await api.post<ApiResponse<RequestDecisionPath<Action>, 'post'>>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/${action}`, payload, {
      headers: {
        ...headers(localUserId),
        'If-Match': `"${version}"`,
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-ID': crypto.randomUUID(),
      },
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, RequestDecisionApiError);
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

export function contestRequest(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  explanation: string,
) {
  return postDecision(localUserId, requestId, 'contests', version, idempotencyKey, { explanation });
}

export function cancelRequest(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  reason: string,
) {
  return postDecision(localUserId, requestId, 'cancellations', version, idempotencyKey, { reason });
}
