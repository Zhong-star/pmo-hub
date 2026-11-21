import axios from 'axios';

export const RESOURCE_ALLOCATION_ACCESS_PATH = '/api/resource-allocation/v1/access';
export const LOCAL_USER_STORAGE_KEY = 'pmo-hub.local-user-id';
export const RESOURCE_ALLOCATION_API_TIMEOUT_MS = 5_000;

export type ResourceAllocationRole =
  | 'ALLOCATION_USER'
  | 'ALLOCATION_MODERATOR'
  | 'ALLOCATION_SUPERVISOR'
  | 'ALLOCATION_MANAGER'
  | 'ALLOCATION_ADMIN';

export interface ResourcePersonAccess {
  id: string;
  localUserId: string;
  displayName: string;
  role: ResourceAllocationRole;
  groupId?: string | null;
  coveredGroupIds: string[];
}

export interface AdministratorContact {
  displayName: string;
  email: string;
}

export interface ResourceAccessResponse {
  person: ResourcePersonAccess;
}

export interface AccessProblem {
  status?: number;
  code?: string;
  detail?: string;
  administrators?: AdministratorContact[];
}

export class AccessRequestError extends Error {
  constructor(readonly status: number, readonly problem: AccessProblem | null) {
    super(problem?.detail ?? `Access request failed with status ${status}.`);
    this.name = 'AccessRequestError';
  }
}

const api = axios.create({
  baseURL: import.meta.env.VITE_RESOURCE_ALLOCATION_API_BASE_URL ?? '',
  timeout: RESOURCE_ALLOCATION_API_TIMEOUT_MS,
});

function parseProblem(payload: unknown): AccessProblem | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  const administrators = Array.isArray(value.administrators)
    ? value.administrators.filter((item): item is AdministratorContact =>
      typeof item === 'object' && item !== null &&
      'displayName' in item && typeof item.displayName === 'string' &&
      'email' in item && typeof item.email === 'string')
    : undefined;
  return {
    status: typeof value.status === 'number' ? value.status : undefined,
    code: typeof value.code === 'string' ? value.code : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
    administrators,
  };
}

export async function getResourceAllocationAccess(localUserId: string): Promise<ResourceAccessResponse> {
  let payload: unknown;
  try {
    const response = await api.get<ResourceAccessResponse>(RESOURCE_ALLOCATION_ACCESS_PATH, {
      headers: {
        'X-PMO-Local-User-ID': localUserId,
        'Cache-Control': 'no-cache',
      },
    });
    payload = response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      throw new AccessRequestError(error.response.status, parseProblem(error.response.data));
    }
    throw error;
  }

  if (typeof payload !== 'object' || payload === null || !('person' in payload)) {
    throw new Error('The access response was invalid.');
  }
  return payload as ResourceAccessResponse;
}

export function readSelectedProfileId(): string | null {
  try {
    return window.localStorage.getItem(LOCAL_USER_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}
