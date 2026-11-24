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

type AllocationCreationBody = ApiRequestBody<AllocationCollectionPath, 'post'>;
export type AllocationCategory = AllocationCreationBody['category'];
export type CreateAllocationInput = Omit<AllocationCreationBody, 'category'> & { category: AllocationCategory };
type SelectionPeoplePath = '/api/resource-allocation/v1/people';
type SelectionProfilesPath = '/api/resource-allocation/v1/resource-profiles';
type SelectionInitiativesPath = '/api/resource-allocation/v1/initiatives';
export type AllocationPersonOption = ApiResponse<SelectionPeoplePath, 'get'>['items'][number];
export type AllocationProfileOption = ApiResponse<SelectionProfilesPath, 'get'>['items'][number];
export type AllocationInitiativeOption = ApiResponse<SelectionInitiativesPath, 'get'>['items'][number];

export const operationalCategories = ['ROUTINE_SUPPORT', 'TRAINING', 'INTERNAL_ACTIVITIES', 'VACATION'] as const satisfies readonly AllocationCategory[];
export const initiativeCategories = [
  'DEMAND_ANALYSIS', 'POC_BBP', 'EXECUTION_PROJECT', 'EXECUTION_FAST_TRACK', 'EXECUTION_ENHANCEMENT',
] as const satisfies readonly AllocationCategory[];

const categoryLabels: Record<AllocationCategory, string> = {
  ROUTINE_SUPPORT: 'Routine / Support',
  TRAINING: 'Training',
  INTERNAL_ACTIVITIES: 'Internal activities',
  VACATION: 'Vacation',
  DEMAND_ANALYSIS: 'Demand Analysis',
  POC_BBP: 'POC/BBP',
  EXECUTION_PROJECT: 'Execution — Project',
  EXECUTION_FAST_TRACK: 'Execution — Fast track',
  EXECUTION_ENHANCEMENT: 'Execution — Enhancement',
};

export function allocationCategoryLabel(category: string | null | undefined): string | null {
  return category && category in categoryLabels ? categoryLabels[category as AllocationCategory] : null;
}

export function isOperationalCategory(category: string | null | undefined): boolean {
  return (operationalCategories as readonly string[]).includes(category ?? '');
}

export async function createAllocation(
  localUserId: string,
  input: CreateAllocationInput,
  idempotencyKey: string,
  correlationId: string,
): Promise<{ allocation: AllocationRecord; etag: string | undefined }> {
  try {
    const response = await api.post<AllocationRecord>(`${API_ROOT}/allocations`, input satisfies AllocationCreationBody, {
      headers: {
        ...headers(localUserId),
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-ID': correlationId,
      },
    });
    return { allocation: response.data, etag: response.headers.etag as string | undefined };
  } catch (error) {
    return throwApiRequestError(error, AllocationRequestError);
  }
}

async function loadAllSelectionPages<Item>(
  path: SelectionPeoplePath | SelectionProfilesPath | SelectionInitiativesPath,
  localUserId: string,
  groupId?: string,
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;
  do {
    const response: { data: { items: Item[]; page: { nextCursor: string | null } } } = await api.get(path, {
      headers: headers(localUserId),
      params: { limit: 100, ...(groupId ? { groupId } : {}), ...(cursor ? { cursor } : {}) },
    });
    items.push(...response.data.items);
    cursor = response.data.page.nextCursor;
  } while (cursor !== null);
  return items;
}

export type AllocationGroupOption = ApiResponse<'/api/resource-allocation/v1/allocation-groups', 'get'>['items'][number];

/** Groups where the current person may record direct allocations (empty for a User). */
export async function getDirectAllocationGroups(localUserId: string): Promise<AllocationGroupOption[]> {
  try {
    const response = await api.get<ApiResponse<'/api/resource-allocation/v1/allocation-groups', 'get'>>(`${API_ROOT}/allocation-groups`, {
      headers: headers(localUserId),
    });
    return response.data.items;
  } catch (error) {
    return throwApiRequestError(error, AllocationRequestError);
  }
}

/** Loads the active profiles, and for direct allocations the people, that can be chosen for one group. */
export async function getGroupAllocationOptions(localUserId: string, groupId: string, includePeople: boolean) {
  try {
    const [people, profiles] = await Promise.all([
      includePeople
        ? loadAllSelectionPages<AllocationPersonOption>('/api/resource-allocation/v1/people', localUserId, groupId)
        : Promise.resolve([] as AllocationPersonOption[]),
      loadAllSelectionPages<AllocationProfileOption>('/api/resource-allocation/v1/resource-profiles', localUserId, groupId),
    ]);
    return { people, profiles };
  } catch (error) {
    return throwApiRequestError(error, AllocationRequestError);
  }
}

export async function getInitiativeOptions(localUserId: string): Promise<AllocationInitiativeOption[]> {
  try {
    return await loadAllSelectionPages<AllocationInitiativeOption>('/api/resource-allocation/v1/initiatives', localUserId);
  } catch (error) {
    return throwApiRequestError(error, AllocationRequestError);
  }
}
