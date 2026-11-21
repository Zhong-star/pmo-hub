import { api, throwApiRequestError, ResourceAllocationApiError } from './apiClient';
import type { ApiProblem, ApiQuery, ApiRequestBody, ApiResponse } from './apiContracts';

const API_ROOT = '/api/resource-allocation/v1';
type AllocationCollectionPath = '/api/resource-allocation/v1/allocations';
type AllocationDetailPath = '/api/resource-allocation/v1/allocations/{id}';
type AllocationHistoryPath = '/api/resource-allocation/v1/allocations/{id}/history';
type AllocationLoadPath = '/api/resource-allocation/v1/allocation-load';
type AllocationActionPathMap = {
  SUSPEND: '/api/resource-allocation/v1/allocations/{id}/suspensions';
  RESERVE: '/api/resource-allocation/v1/allocations/{id}/reservations';
  RESUME: '/api/resource-allocation/v1/allocations/{id}/resumptions';
  ACTIVATE: '/api/resource-allocation/v1/allocations/{id}/activations';
  COMPLETE: '/api/resource-allocation/v1/allocations/{id}/completions';
  CANCEL: '/api/resource-allocation/v1/allocations/{id}/cancellations';
};

export const ALLOCATIONS_QUERY_ROOT = ['resource-allocation-allocations'] as const;

export type AllocationRecord = ApiResponse<AllocationDetailPath, 'get'>;
export type AllocationState = AllocationRecord['state'];
export type AllocationAction = AllocationRecord['availableActions'][number];
export type AllocationFilters = Partial<ApiQuery<AllocationCollectionPath, 'get'>>;
export type AllocationCollection = ApiResponse<AllocationCollectionPath, 'get'>;
export type AllocationLoadCollection = ApiResponse<AllocationLoadPath, 'get'>;
export type AllocationLoadItem = AllocationLoadCollection['items'][number];
export type AllocationHistoryCollection = ApiResponse<AllocationHistoryPath, 'get'>;
export type AllocationHistoryEvent = AllocationHistoryCollection['items'][number];
type AllocationCommand = ApiRequestBody<AllocationActionPathMap['SUSPEND'], 'post'>;
type AllocationActionResult<Action extends AllocationAction> = ApiResponse<AllocationActionPathMap[Action], 'post'>;

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
      params: { ...filters, limit: 50, ...(cursor ? { cursor } : {}) } satisfies ApiQuery<AllocationCollectionPath, 'get'>,
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, AllocationRequestError);
  }
}

export async function getAllocation(localUserId: string, allocationId: string) {
  try {
    const response = await api.get<ApiResponse<AllocationDetailPath, 'get'>>(`${API_ROOT}/allocations/${encodeURIComponent(allocationId)}`, {
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
      params: { date, limit: 50 } satisfies ApiQuery<AllocationLoadPath, 'get'>,
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
      params: { limit: 50 } satisfies ApiQuery<AllocationHistoryPath, 'get'>,
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

export async function changeAllocationState<Action extends AllocationAction>(
  localUserId: string,
  allocationId: string,
  action: Action,
  version: number,
  reason: string,
  idempotencyKey: string,
  correlationId: string,
) {
  try {
    const command: AllocationCommand = { reason };
    const response = await api.post<AllocationActionResult<Action>>(
      `${API_ROOT}/allocations/${encodeURIComponent(allocationId)}/${actionPaths[action]}`,
      command,
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
