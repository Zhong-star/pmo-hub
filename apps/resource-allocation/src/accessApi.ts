import { api, throwApiRequestError, ResourceAllocationApiError } from './apiClient';
import type { ApiProblem, ApiResponse, ApiSchemas } from './apiContracts';

export const RESOURCE_ALLOCATION_ACCESS_PATH = '/api/resource-allocation/v1/access';
export const LOCAL_USER_STORAGE_KEY = 'pmo-hub.local-user-id';

export type ResourceAllocationRole = ApiSchemas['ResourcePersonAccessDto']['role'];
export type ResourcePersonAccess = ApiResponse<'/api/resource-allocation/v1/access', 'get'>['person'];
export type AdministratorContact = ApiProblem['administrators'] extends Array<infer Contact> ? Contact : never;
export type ResourceAccessResponse = ApiResponse<'/api/resource-allocation/v1/access', 'get'>;
export type AccessProblem = ApiProblem;

export class AccessRequestError extends ResourceAllocationApiError {
  constructor(status: number | null, problem: AccessProblem | null) {
    super(status, problem, status === null ? 'The access service could not be reached.' : `Access request failed with status ${status}.`, 'AccessRequestError');
  }
}

export async function getResourceAllocationAccess(localUserId: string): Promise<ResourceAccessResponse> {
  try {
    const response = await api.get<ResourceAccessResponse>(RESOURCE_ALLOCATION_ACCESS_PATH, {
      headers: {
        'X-PMO-Local-User-ID': localUserId,
        'Cache-Control': 'no-cache',
      },
    });
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, AccessRequestError);
  }
}

export function readSelectedProfileId(): string | null {
  try {
    return window.localStorage.getItem(LOCAL_USER_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}
