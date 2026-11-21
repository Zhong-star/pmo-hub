import { api, throwApiRequestError, ResourceAllocationApiError } from './apiClient';
import type { ApiProblem, ApiQuery, ApiRequestBody, ApiResponse } from './apiContracts';

const API_ROOT = '/api/resource-allocation/v1';

export const ALLOCATIONS_QUERY_ROOT = ['resource-allocation-allocations'] as const;

export type AllocationRecord = ApiResponse<'/api/resource-allocation/v1/allocations', 'get'>['items'][number];
export type AllocationState = AllocationRecord['state'];
export type AllocationAction = AllocationRecord['availableActions'][number];
export type AllocationFilters = Partial<ApiQuery<'/api/resource-allocation/v1/allocations', 'get'>>;
export type AllocationCollection = ApiResponse<'/api/resource-allocation/v1/allocations', 'get'>;
export type AllocationLoadCollection = ApiResponse<'/api/resource-allocation/v1/allocation-load', 'get'>;
export type AllocationLoadItem = AllocationLoadCollection['items'][number];
export type AllocationHistoryCollection = ApiResponse<'/api/resource-allocation/v1/allocations/{id}/history', 'get'>;
export type AllocationHistoryEvent = AllocationHistoryCollection['items'][number];
type AllocationCommand = ApiRequestBody<'/api/resource-allocation/v1/allocations/{id}/suspensions', 'post'>;

export class AllocationRequestError extends ResourceAllocationApiError {
  constructor(status: number | null, problem: ApiProblem | null) {
    super(status, problem, status === null ? 'The allocation service could not be reached.' : `The allocation request failed with status ${status}.`, 'AllocationRequestError');
  }
}

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

export async function getAllocations(
  localUserId: string,
  filters: AllocationFilters,
  cursor: string | null,
): Promise<AllocationCollection> {
  try {
    const response = await api.get<AllocationCollection>(`${API_ROOT}/allocations`, {
      headers: headers(localUserId),
      params: { ...filters, limit: 50, ...(cursor ? { cursor } : {}) },
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, AllocationRequestError);
  }
}

export async function getAllocation(localUserId: string, allocationId: string) {
  try {
    const response = await api.get<AllocationRecord>(`${API_ROOT}/allocations/${encodeURIComponent(allocationId)}`, {
      headers: headers(localUserId),
    });
    return { allocation: response.data, etag: response.headers.etag as string | undefined };
  } catch (error) {
    return throwApiRequestError(error, AllocationRequestError);
  }
}

export async function getAllocationLoad(
  localUserId: string,
  date: string,
): Promise<AllocationLoadCollection> {
  try {
    const response = await api.get<AllocationLoadCollection>(`${API_ROOT}/allocation-load`, {
      headers: headers(localUserId),
      params: { date, limit: 50 },
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, AllocationRequestError);
  }
}

export async function getAllocationHistory(
  localUserId: string,
  allocationId: string,
): Promise<AllocationHistoryCollection> {
  try {
    const response = await api.get<AllocationHistoryCollection>(`${API_ROOT}/allocations/${encodeURIComponent(allocationId)}/history`, {
      headers: headers(localUserId),
      params: { limit: 50 },
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, AllocationRequestError);
  }
}

const actionPaths: Record<AllocationAction, string> = {
  SUSPEND: 'suspensions',
  RESERVE: 'reservations',
  RESUME: 'resumptions',
  ACTIVATE: 'activations',
  COMPLETE: 'completions',
  CANCEL: 'cancellations',
};

export async function changeAllocationState(
  localUserId: string,
  allocationId: string,
  action: AllocationAction,
  version: number,
  reason: string,
  idempotencyKey: string,
  correlationId: string,
) {
  try {
    const response = await api.post<AllocationRecord>(
      `${API_ROOT}/allocations/${encodeURIComponent(allocationId)}/${actionPaths[action]}`,
      { reason } satisfies AllocationCommand,
      {
        headers: {
          ...headers(localUserId),
          'If-Match': `"${version}"`,
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-ID': correlationId,
        },
      },
    );
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, AllocationRequestError);
  }
}

export function isAllocationAction(value: string): value is AllocationAction {
  return value in actionPaths;
}
