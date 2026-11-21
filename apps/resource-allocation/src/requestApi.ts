import { api, throwApiRequestError, ResourceAllocationApiError } from './apiClient';
import type { ApiProblem, ApiQuery, ApiRequestBody, ApiResponse } from './apiContracts';

export const REQUESTS_QUERY_ROOT = ['resource-allocation-requests'] as const;
const API_ROOT = '/api/resource-allocation/v1';

export type ResourceRequestItem = ApiResponse<'/api/resource-allocation/v1/requests/{id}', 'get'>;
export type RequestDecisionState = ResourceRequestItem['decisionState'];
export type RequestConfirmationSource = NonNullable<RequestAcceptanceResult['confirmationSource']> | null;
export type RequestedConditions = ResourceRequestItem['requestedConditions'];
export type ApprovedRequestConditions = NonNullable<ResourceRequestItem['approvedConditions']>;
export type RequestAllocation = NonNullable<ResourceRequestItem['allocation']>;
export type RequestRevalidation = NonNullable<ResourceRequestItem['revalidation']>;
export type RequestAcceptanceResult = ApiResponse<'/api/resource-allocation/v1/requests/{id}/acceptances', 'post'>;
type RequestAcceptanceInput = ApiRequestBody<'/api/resource-allocation/v1/requests/{id}/acceptances', 'post'>;
export type ResourceRequestCollection = ApiResponse<'/api/resource-allocation/v1/requests', 'get'>;
export type ResourceRequestUpdateResult = ApiResponse<'/api/resource-allocation/v1/requests/{id}', 'patch'>;
export type ResourceRequestUpdateInput = ApiRequestBody<'/api/resource-allocation/v1/requests/{id}', 'patch'>;
type RequestWithdrawalInput = ApiRequestBody<'/api/resource-allocation/v1/requests/{id}/withdrawals', 'post'>;
type RequestFilterQuery = ApiQuery<'/api/resource-allocation/v1/requests', 'get'>;
export type RequestFilters = Partial<Pick<RequestFilterQuery, 'initiativeId' | 'decisionState' | 'groupId' | 'resourceProfileId'>>;
export type RequestScope = NonNullable<RequestFilterQuery['scope']> | 'mine';
export type RequestAudit = ApiResponse<'/api/resource-allocation/v1/request-audits/{id}', 'get'>;
export type RequestAuditEvent = ApiResponse<'/api/resource-allocation/v1/request-audits/{id}/events', 'get'>['items'][number];
export type RequestProblem = ApiProblem;

export class RequestApiError extends ResourceAllocationApiError {
  constructor(status: number | null, problem: RequestProblem | null) {
    super(status, problem, status === null ? 'The request service could not be reached.' : `The request failed with status ${status}.`, 'RequestApiError');
  }
}

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

export async function getRequestCollection(
  localUserId: string,
  filters: RequestFilters,
  cursor: string | null,
  scope: RequestScope = 'mine',
): Promise<ResourceRequestCollection> {
  try {
    const response = await api.get<ResourceRequestCollection>(`${API_ROOT}/requests`, {
      headers: headers(localUserId),
      params: { ...filters, ...(scope === 'visible' ? { scope } : {}), limit: 50, ...(cursor ? { cursor } : {}) } satisfies RequestFilterQuery,
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, RequestApiError);
  }
}

export async function getRequest(localUserId: string, requestId: string): Promise<ResourceRequestItem> {
  try {
    const response = await api.get<ResourceRequestItem>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}`, {
      headers: headers(localUserId),
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, RequestApiError);
  }
}

export async function updateRequest(
  localUserId: string,
  requestId: string,
  version: number,
  conditions: ResourceRequestUpdateInput,
): Promise<ResourceRequestUpdateResult> {
  try {
    const response = await api.patch<ResourceRequestUpdateResult>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}`, conditions, {
      headers: { ...headers(localUserId), 'If-Match': `"${version}"`, 'Content-Type': 'application/merge-patch+json' },
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, RequestApiError);
  }
}

export async function withdrawRequest(
  localUserId: string,
  requestId: string,
  version: number,
  reason: string,
  idempotencyKey: string,
): Promise<RequestAuditEvent> {
  try {
    const response = await api.post<RequestAuditEvent>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/withdrawals`, { reason } satisfies RequestWithdrawalInput, {
      headers: { ...headers(localUserId), 'If-Match': `"${version}"`, 'Idempotency-Key': idempotencyKey },
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, RequestApiError);
  }
}

export async function acceptRequest(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
): Promise<RequestAcceptanceResult> {
  try {
    const body: RequestAcceptanceInput = {};
    const response = await api.post<RequestAcceptanceResult>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/acceptances`, body, {
      headers: {
        ...headers(localUserId),
        'If-Match': `"${version}"`,
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-ID': crypto.randomUUID(),
      },
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, RequestApiError);
  }
}

export async function getRequestAudit(localUserId: string, requestId: string): Promise<RequestAudit> {
  try {
    const response = await api.get<RequestAudit>(`${API_ROOT}/request-audits/${encodeURIComponent(requestId)}`, {
      headers: headers(localUserId),
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, RequestApiError);
  }
}
