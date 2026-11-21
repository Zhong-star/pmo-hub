import axios from 'axios';
import { getSelectionCollection, type SelectionItem } from './submissionApi';
import type { ApprovedRequestConditions, RequestAllocation } from './requestApi';

export const REQUEST_QUEUES_QUERY_ROOT = ['resource-allocation-request-queues'] as const;
const API_ROOT = '/api/resource-allocation/v1';

export type RequestQueueCode = 'presentation' | 'team-decision';

export interface RequestQueueItem {
  id: string;
  requester: { personId?: string; displayName?: string; role?: string };
  requestedConditions: {
    initiativeId: string;
    initiativeCode?: string;
    initiativeName?: string;
    groupId: string;
    groupName?: string;
    resourceProfileId: string;
    resourceProfileName?: string;
    startDate?: string;
    endDate?: string;
    weeklyHours?: number;
    comment?: string;
  };
  decisionState: string;
  receivedAt: string;
  stageEnteredAt: string;
  dueAt: string | null;
  impediments?: string[];
  nextResponsible: { role?: string } | Array<{ personId: string; displayName: string; role: string }>;
  availableActions: string[];
  approvedConditions?: ApprovedRequestConditions;
  allocation?: RequestAllocation;
  version: number;
}

export interface RequestQueueCollection {
  items: RequestQueueItem[];
  page: { nextCursor: string | null; limit: number };
}

export type RequestActionResult = Omit<RequestQueueItem, 'nextResponsible' | 'availableActions'>;

export interface QueueSelections {
  groups: SelectionItem[];
  profiles: SelectionItem[];
  initiatives: SelectionItem[];
  people: QueuePersonSelection[];
}

export interface QueuePersonSelection {
  id: string;
  displayName: string;
  groupId: string | null;
}

export interface RequestActionProblem {
  code?: string;
  detail?: string;
  title?: string;
}

export class RequestQueueRequestError extends Error {
  constructor(readonly status: number | null, readonly problem: RequestActionProblem | null) {
    super(problem?.detail ?? problem?.title ?? (status === null
      ? 'The request queue service could not be reached.'
      : `The request action failed with status ${status}.`));
    this.name = 'RequestQueueRequestError';
  }
}

const api = axios.create({
  baseURL: import.meta.env.VITE_RESOURCE_ALLOCATION_API_BASE_URL ?? '',
  timeout: 10_000,
});

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

function parseProblem(payload: unknown): RequestActionProblem | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  return {
    code: typeof value.code === 'string' ? value.code : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
    title: typeof value.title === 'string' ? value.title : undefined,
  };
}

function throwRequestError(error: unknown): never {
  if (axios.isAxiosError(error)) {
    throw new RequestQueueRequestError(error.response?.status ?? null, parseProblem(error.response?.data));
  }
  throw error;
}

export async function getRequestQueue(
  localUserId: string,
  queue: RequestQueueCode,
  cursor: string | null,
): Promise<RequestQueueCollection> {
  try {
    const response = await api.get<RequestQueueCollection>(`${API_ROOT}/request-queues/${queue}`, {
      headers: headers(localUserId),
      params: { limit: 50, ...(cursor ? { cursor } : {}) },
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function getQueueSelections(localUserId: string, approvalRequestId?: string): Promise<QueueSelections> {
  try {
    const [groups, profiles, initiatives, people] = await Promise.all([
      loadSelectionPages(localUserId, 'groups'),
      loadSelectionPages(localUserId, 'resource-profiles'),
      loadSelectionPages(localUserId, 'initiatives'),
      approvalRequestId ? loadPeoplePages(localUserId, approvalRequestId) : Promise.resolve([]),
    ]);
    return { groups, profiles, initiatives, people };
  } catch (error) {
    return throwRequestError(error);
  }
}

async function loadPeoplePages(localUserId: string, requestId: string): Promise<QueuePersonSelection[]> {
  const people: QueuePersonSelection[] = [];
  let cursor: string | null = null;
  do {
    try {
      const response: { data: { items: QueuePersonSelection[]; page: { nextCursor: string | null } } } = await api.get(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/approval-candidates`, {
        headers: headers(localUserId),
        params: { limit: 50, ...(cursor ? { cursor } : {}) },
      });
      people.push(...response.data.items);
      cursor = response.data.page.nextCursor;
    } catch (error) {
      return throwRequestError(error);
    }
  } while (cursor !== null);
  return people;
}

async function loadSelectionPages(
  localUserId: string,
  collection: 'groups' | 'resource-profiles' | 'initiatives',
): Promise<SelectionItem[]> {
  const items: SelectionItem[] = [];
  let cursor: string | null = null;
  do {
    const page = await getSelectionCollection(collection, localUserId, cursor);
    items.push(...page.items);
    cursor = page.page.nextCursor;
  } while (cursor !== null);
  return items;
}

async function postAction<T>(
  localUserId: string,
  requestId: string,
  action: 'referrals' | 'reference-corrections' | 'administrative-removals' | 'approvals',
  version: number,
  idempotencyKey: string,
  body: Record<string, string | undefined>,
): Promise<T> {
  try {
    const response = await api.post<T>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/${action}`, body, {
      headers: {
        ...headers(localUserId),
        'If-Match': `"${version}"`,
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-ID': crypto.randomUUID(),
      },
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export function referRequest(localUserId: string, requestId: string, version: number, idempotencyKey: string) {
  return postAction<RequestActionResult>(localUserId, requestId, 'referrals', version, idempotencyKey, {});
}

export function approveRequest(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  approval: { personId: string; resourceProfileId?: string; explanation?: string },
) {
  return postAction<RequestActionResult>(localUserId, requestId, 'approvals', version, idempotencyKey, approval);
}

export function correctRequestReferences(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  correction: { initiativeId?: string; groupId?: string; resourceProfileId?: string; reason: string },
) {
  return postAction<RequestActionResult>(localUserId, requestId, 'reference-corrections', version, idempotencyKey, correction);
}

export function removeRequestAdministratively(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  reason: string,
) {
  return postAction<{ requestId: string; action: 'ADMIN_REMOVED'; removedAt: string }>(
    localUserId, requestId, 'administrative-removals', version, idempotencyKey, { reason },
  );
}
