import axios from 'axios';

export const RESOURCE_ALLOCATION_API_ROOT = '/api/resource-allocation/v1';

export type ResourceAllocationRole =
  | 'ALLOCATION_USER'
  | 'ALLOCATION_MODERATOR'
  | 'ALLOCATION_SUPERVISOR'
  | 'ALLOCATION_MANAGER'
  | 'ALLOCATION_ADMIN';

export type AdminCollection = 'people' | 'groups' | 'resource-profiles' | 'initiatives';

export interface AdminPerson {
  id: string;
  localUserId: string;
  displayName: string;
  email: string;
  active: boolean;
  role: ResourceAllocationRole;
  groupId: string | null;
  coveredGroupIds: string[];
  version: number;
}

export interface AdminGroup {
  id: string;
  name: string;
  active: boolean;
  supervisorId: string | null;
  managerId: string | null;
  version: number;
}

export interface AdminResourceProfile {
  id: string;
  name: string;
  groupId: string;
  active: boolean;
  version: number;
}

export interface AdminInitiative {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
}

export interface AdminRecordMap {
  people: AdminPerson;
  groups: AdminGroup;
  'resource-profiles': AdminResourceProfile;
  initiatives: AdminInitiative;
}

export interface AdminCollectionResponse<T> {
  items: T[];
  page: { nextCursor: string | null; limit: number };
}

export interface ApiFieldError {
  path?: string;
  message?: string;
}

export interface ApiProblem {
  code?: string;
  detail?: string;
  errors?: ApiFieldError[];
}

export class AdministrationRequestError extends Error {
  constructor(readonly status: number, readonly problem: ApiProblem | null) {
    super(problem?.detail ?? `The administration request failed with status ${status}.`);
    this.name = 'AdministrationRequestError';
  }
}

const api = axios.create({
  baseURL: import.meta.env.VITE_RESOURCE_ALLOCATION_API_BASE_URL ?? '',
  timeout: 5_000,
});

function parseProblem(payload: unknown): ApiProblem | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  const errors = Array.isArray(value.errors)
    ? value.errors.filter((item): item is ApiFieldError =>
      typeof item === 'object' && item !== null &&
      (!('path' in item) || typeof item.path === 'string') &&
      (!('message' in item) || typeof item.message === 'string'))
    : undefined;
  return {
    code: typeof value.code === 'string' ? value.code : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
    errors,
  };
}

function requestError(error: unknown): never {
  if (axios.isAxiosError(error) && error.response) {
    throw new AdministrationRequestError(error.response.status, parseProblem(error.response.data));
  }
  throw error;
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
): Promise<AdminCollectionResponse<AdminRecordMap[C]>> {
  try {
    const response = await api.get<AdminCollectionResponse<AdminRecordMap[C]>>(
      `${RESOURCE_ALLOCATION_API_ROOT}/admin/${collection}`,
      {
        headers: requestHeaders(localUserId),
        params: { limit: 50, ...(cursor ? { cursor } : {}) },
      },
    );
    return response.data;
  } catch (error) {
    return requestError(error);
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
    return requestError(error);
  }
}

export async function createAdminResource<C extends AdminCollection>(
  collection: C,
  localUserId: string,
  payload: Record<string, unknown>,
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
    return requestError(error);
  }
}

export async function updateAdminResource<C extends AdminCollection>(
  collection: C,
  id: string,
  localUserId: string,
  etag: string,
  payload: Record<string, unknown>,
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
    return requestError(error);
  }
}
