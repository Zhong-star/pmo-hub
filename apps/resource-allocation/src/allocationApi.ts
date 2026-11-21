import axios from 'axios';

const API_ROOT = '/api/resource-allocation/v1';

export const ALLOCATIONS_QUERY_ROOT = ['resource-allocation-allocations'] as const;

export type AllocationState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'SUSPENDED'
  | 'ALLOCATED_WITHOUT_ACTION'
  | 'DONE'
  | 'CANCELED';

export type AllocationAction = 'SUSPEND' | 'RESERVE' | 'RESUME' | 'ACTIVATE' | 'COMPLETE' | 'CANCEL';

export interface AllocationRecord {
  id: string;
  requestId: string;
  person: { personId: string; displayName: string };
  group: { id: string; name: string };
  initiative: { id: string; code: string; name: string };
  resourceProfile: { id: string; name: string };
  startDate: string;
  endDate: string;
  approvedPeriod: { startDate: string; endDate: string };
  weeklyHours: number;
  state: AllocationState;
  approvedAt: string;
  version: number;
  availableActions: string[];
}

export interface AllocationFilters {
  initiativeId?: string;
  personId?: string;
  groupId?: string;
  resourceProfileId?: string;
  operationalState?: AllocationState | '';
  periodStart?: string;
  periodEnd?: string;
}

export interface AllocationCollection {
  items: AllocationRecord[];
  page: { nextCursor: string | null; limit: number };
}

export interface AllocationLoadItem {
  person: { personId: string; displayName: string };
  weeklyHoursByState: Record<AllocationState, number>;
  totalWeeklyHours: number;
}

export interface AllocationLoadCollection {
  date: string;
  items: AllocationLoadItem[];
  page: { nextCursor: string | null; limit: number };
}

export interface AllocationHistoryEvent {
  id: string;
  actor: Record<string, unknown>;
  action: string;
  reason: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  occurredAt: string;
  correlationId: string;
}

export interface AllocationHistoryCollection {
  items: AllocationHistoryEvent[];
  page: { nextCursor: string | null; limit: number };
}

interface AllocationProblem {
  code?: string;
  detail?: string;
  title?: string;
}

export class AllocationRequestError extends Error {
  constructor(readonly status: number | null, readonly problem: AllocationProblem | null) {
    super(problem?.detail ?? problem?.title ?? (status === null
      ? 'The allocation service could not be reached.'
      : `The allocation request failed with status ${status}.`));
    this.name = 'AllocationRequestError';
  }
}

const api = axios.create({
  baseURL: import.meta.env.VITE_RESOURCE_ALLOCATION_API_BASE_URL ?? '',
  timeout: 10_000,
});

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

function parseProblem(payload: unknown): AllocationProblem | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  return {
    code: typeof value.code === 'string' ? value.code : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
    title: typeof value.title === 'string' ? value.title : undefined,
  };
}

function throwAllocationError(error: unknown): never {
  if (axios.isAxiosError(error)) {
    throw new AllocationRequestError(error.response?.status ?? null, parseProblem(error.response?.data));
  }
  throw error;
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
    return throwAllocationError(error);
  }
}

export async function getAllocation(localUserId: string, allocationId: string) {
  try {
    const response = await api.get<AllocationRecord>(`${API_ROOT}/allocations/${encodeURIComponent(allocationId)}`, {
      headers: headers(localUserId),
    });
    return { allocation: response.data, etag: response.headers.etag as string | undefined };
  } catch (error) {
    return throwAllocationError(error);
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
    return throwAllocationError(error);
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
    return throwAllocationError(error);
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
      { reason },
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
    return throwAllocationError(error);
  }
}

export function isAllocationAction(value: string): value is AllocationAction {
  return value in actionPaths;
}
