import { api, throwApiRequestError, ResourceAllocationApiError } from './apiClient';
import type { ApiProblem, ApiQuery, ApiRequestBody, ApiResponse } from './apiContracts';

const API_ROOT = '/api/resource-allocation/v1';
type CapacityCollectionPath = '/api/resource-allocation/v1/capacities';
type CapacityDetailPath = '/api/resource-allocation/v1/capacities/{id}';
type CapacityHistoryPath = '/api/resource-allocation/v1/capacities/{id}/history';
type CapacityOptionsPath = '/api/resource-allocation/v1/capacity-options';

export const CAPACITY_QUERY_ROOT = ['resource-allocation-capacity'] as const;

export type CapacityCollection = ApiResponse<CapacityCollectionPath, 'get'>;
export type CapacityEntry = ApiResponse<CapacityDetailPath, 'get'>;
export type CapacityFilters = Pick<ApiQuery<CapacityCollectionPath, 'get'>, 'groupId' | 'resourceProfileId' | 'classification'>;
export type CapacityCreateInput = ApiRequestBody<CapacityCollectionPath, 'post'>;
export type CapacityUpdateInput = ApiRequestBody<CapacityDetailPath, 'patch'>;
export type CapacityOptions = ApiResponse<CapacityOptionsPath, 'get'>;
export type CapacityHistory = ApiResponse<CapacityHistoryPath, 'get'>;
export type CapacityHistoryEvent = CapacityHistory['items'][number];

export class CapacityRequestError extends ResourceAllocationApiError {
  constructor(status: number | null, problem: ApiProblem | null) {
    super(
      status,
      problem,
      status === null ? 'The capacity service could not be reached.' : `The capacity request failed with status ${status}.`,
      'CapacityRequestError',
    );
  }
}

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

export async function getCapacityOptions(localUserId: string): Promise<CapacityOptions> {
  try {
    const response = await api.get<CapacityOptions>(`${API_ROOT}/capacity-options`, { headers: headers(localUserId) });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, CapacityRequestError);
  }
}

export async function getCapacities(
  localUserId: string,
  filters: CapacityFilters,
  cursor: string | null,
): Promise<CapacityCollection> {
  try {
    const response = await api.get<CapacityCollection>(`${API_ROOT}/capacities`, {
      headers: headers(localUserId),
      params: { ...filters, limit: 50, ...(cursor ? { cursor } : {}) } satisfies ApiQuery<CapacityCollectionPath, 'get'>,
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, CapacityRequestError);
  }
}

export async function getCapacityHistory(localUserId: string, capacityId: string): Promise<CapacityHistory> {
  try {
    const response = await api.get<CapacityHistory>(`${API_ROOT}/capacities/${encodeURIComponent(capacityId)}/history`, {
      headers: headers(localUserId),
      params: { limit: 50 } satisfies ApiQuery<CapacityHistoryPath, 'get'>,
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, CapacityRequestError);
  }
}

export async function createCapacity(
  localUserId: string,
  input: CapacityCreateInput,
  idempotencyKey: string,
) {
  try {
    const response = await api.post<CapacityEntry>(`${API_ROOT}/capacities`, input, {
      headers: { ...headers(localUserId), 'Idempotency-Key': idempotencyKey },
    });
    return { capacity: response.data, replayed: response.headers['idempotency-replayed'] === 'true' };
  } catch (error) {
    return throwApiRequestError(error, CapacityRequestError);
  }
}

export async function updateCapacity(
  localUserId: string,
  capacityId: string,
  version: number,
  input: CapacityUpdateInput,
  idempotencyKey: string,
) {
  try {
    const response = await api.patch<CapacityEntry>(`${API_ROOT}/capacities/${encodeURIComponent(capacityId)}`, input, {
      headers: {
        ...headers(localUserId),
        'If-Match': `"${version}"`,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/merge-patch+json',
      },
    });
    return { capacity: response.data, replayed: response.headers['idempotency-replayed'] === 'true' };
  } catch (error) {
    return throwApiRequestError(error, CapacityRequestError);
  }
}

export async function removeCapacity(
  localUserId: string,
  capacityId: string,
  version: number,
  reason: string,
  idempotencyKey: string,
): Promise<void> {
  try {
    await api.delete(`${API_ROOT}/capacities/${encodeURIComponent(capacityId)}`, {
      headers: {
        ...headers(localUserId),
        'If-Match': `"${version}"`,
        'Idempotency-Key': idempotencyKey,
      },
      data: { reason } satisfies ApiRequestBody<CapacityDetailPath, 'delete'>,
    });
  } catch (error) {
    return throwApiRequestError(error, CapacityRequestError);
  }
}
