import { api, throwApiRequestError, ResourceAllocationApiError } from './apiClient';
import type { ApiProblem, ApiQuery, ApiRequestBody, ApiResponse } from './apiContracts';

export const RESOURCE_ALLOCATION_API_ROOT = '/api/resource-allocation/v1';

export type AdminCollection = 'people' | 'groups' | 'resource-profiles' | 'initiatives';
type AdminCollectionPath<C extends AdminCollection> = {
  people: '/api/resource-allocation/v1/admin/people';
  groups: '/api/resource-allocation/v1/admin/groups';
  'resource-profiles': '/api/resource-allocation/v1/admin/resource-profiles';
  initiatives: '/api/resource-allocation/v1/admin/initiatives';
}[C];

type AdminCollectionQueryMap = {
  [C in AdminCollection]: ApiQuery<AdminCollectionPath<C>, 'get'>;
};

type AdminResourcePath<C extends AdminCollection> = {
  people: '/api/resource-allocation/v1/admin/people/{id}';
  groups: '/api/resource-allocation/v1/admin/groups/{id}';
  'resource-profiles': '/api/resource-allocation/v1/admin/resource-profiles/{id}';
  initiatives: '/api/resource-allocation/v1/admin/initiatives/{id}';
}[C];

export type AdminPerson = ApiResponse<'/api/resource-allocation/v1/admin/people/{id}', 'get'>;
export type ResourcePersonClassification = Exclude<AdminPerson['classification'], null>;
export type AdminGroup = ApiResponse<'/api/resource-allocation/v1/admin/groups/{id}', 'get'>;
export type AdminResourceProfile = ApiResponse<'/api/resource-allocation/v1/admin/resource-profiles/{id}', 'get'>;
export type AdminInitiative = ApiResponse<'/api/resource-allocation/v1/admin/initiatives/{id}', 'get'>;
export type ResourceAllocationRole = AdminPerson['role'];
export type AdminRecordMap = {
  people: AdminPerson;
  groups: AdminGroup;
  'resource-profiles': AdminResourceProfile;
  initiatives: AdminInitiative;
};
export type AdminCollectionResponse<C extends AdminCollection> = ApiResponse<AdminCollectionPath<C>, 'get'>;
export type ApiFieldError = NonNullable<ApiProblem['errors']>[number];
export type { ApiProblem };

type AdminCreatePayload<C extends AdminCollection> = ApiRequestBody<AdminCollectionPath<C>, 'post'>;
type AdminUpdatePayload<C extends AdminCollection> = ApiRequestBody<AdminResourcePath<C>, 'patch'>;
export class AdministrationRequestError extends ResourceAllocationApiError {
  constructor(status: number | null, problem: ApiProblem | null) {
    super(status, problem, status === null ? 'The administration service could not be reached.' : `The administration request failed with status ${status}.`, 'AdministrationRequestError');
  }
}

function requestHeaders(localUserId: string) {
  return {
    'X-PMO-Local-User-ID': localUserId,
    'Cache-Control': 'no-cache',
  };
}

export async function getAdminCollection<C extends AdminCollection>(
  collection: C,
  localUserId: string,
  cursor: string | null,
): Promise<AdminCollectionResponse<C>> {
  try {
    const response = await api.get<AdminCollectionResponse<C>>(
      `${RESOURCE_ALLOCATION_API_ROOT}/admin/${collection}`,
      {
        headers: requestHeaders(localUserId),
        params: { limit: 50, ...(cursor ? { cursor } : {}) } satisfies Partial<AdminCollectionQueryMap[C]>,
      },
    );
    return response.data;
  } catch (error) {
    return throwApiRequestError(error, AdministrationRequestError);
  }
}

export interface AdminResourceResponse<T> {
  record: T;
  etag: string;
}

export async function getAdminResource<C extends AdminCollection>(
  collection: C,
  id: string,
  localUserId: string,
): Promise<AdminResourceResponse<AdminRecordMap[C]>> {
  try {
    const response = await api.get<AdminRecordMap[C]>(
      `${RESOURCE_ALLOCATION_API_ROOT}/admin/${collection}/${encodeURIComponent(id)}`,
      { headers: requestHeaders(localUserId) },
    );
    const etag = response.headers.etag;
    if (typeof etag !== 'string' || etag.length === 0) {
      throw new Error('The server did not provide a record version. Close and reopen this record.');
    }
    return { record: response.data, etag };
  } catch (error) {
    return throwApiRequestError(error, AdministrationRequestError);
  }
}

export async function createAdminResource<C extends AdminCollection>(
  collection: C,
  localUserId: string,
  payload: AdminCreatePayload<C>,
  idempotencyKey: string,
): Promise<AdminResourceResponse<AdminRecordMap[C]>> {
  try {
    const response = await api.post<AdminRecordMap[C]>(
      `${RESOURCE_ALLOCATION_API_ROOT}/admin/${collection}`,
      payload,
      {
        headers: {
          ...requestHeaders(localUserId),
          'Idempotency-Key': idempotencyKey,
        },
      },
    );
    return { record: response.data, etag: response.headers.etag ?? '' };
  } catch (error) {
    return throwApiRequestError(error, AdministrationRequestError);
  }
}

export async function updateAdminResource<C extends AdminCollection>(
  collection: C,
  id: string,
  localUserId: string,
  etag: string,
  payload: AdminUpdatePayload<C>,
): Promise<AdminResourceResponse<AdminRecordMap[C]>> {
  try {
    const response = await api.patch<AdminRecordMap[C]>(
      `${RESOURCE_ALLOCATION_API_ROOT}/admin/${collection}/${encodeURIComponent(id)}`,
      payload,
      {
        headers: {
          ...requestHeaders(localUserId),
          'Content-Type': 'application/merge-patch+json',
          'If-Match': etag,
        },
      },
    );
    return { record: response.data, etag: response.headers.etag ?? '' };
  } catch (error) {
    return throwApiRequestError(error, AdministrationRequestError);
  }
}
