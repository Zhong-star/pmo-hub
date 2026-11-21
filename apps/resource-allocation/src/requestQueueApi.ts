import { api, throwApiRequestError, ResourceAllocationApiError } from './apiClient';
import type { ApiPathParameters, ApiProblem, ApiQuery, ApiRequestBody, ApiResponse } from './apiContracts';
import { getSelectionCollection, type SelectionCollectionPage, type SelectionItem } from './submissionApi';

export const REQUEST_QUEUES_QUERY_ROOT = ['resource-allocation-request-queues'] as const;
const API_ROOT = '/api/resource-allocation/v1';

type RequestQueuePath = '/api/resource-allocation/v1/request-queues/{queueCode}';
type RequestAction = 'referrals' | 'reference-corrections' | 'administrative-removals' | 'approvals' | 'escalations' | 'cancellations' | 'strategies' | 'resolutions';
type RequestActionPath<Action extends RequestAction> = `/api/resource-allocation/v1/requests/{id}/${Action}`;

export type RequestQueueCode = ApiPathParameters<RequestQueuePath, 'get'>['queueCode'];
export type RequestQueueItem = ApiResponse<RequestQueuePath, 'get'>['items'][number];
export type ExceptionDecisionState = Extract<RequestQueueItem['decisionState'], 'PRE_N3' | 'ESCALATION'>;
export type ExceptionResolutionStrategy = ApiRequestBody<RequestActionPath<'resolutions'>, 'post'>['strategy'];
export type RequestQueueFilters = Partial<Pick<ApiQuery<RequestQueuePath, 'get'>, 'groupId' | 'initiativeId' | 'resourceProfileId' | 'decisionState'>>;
export type RequestQueueCollection = ApiResponse<RequestQueuePath, 'get'>;
export type RequestActionResult = ApiResponse<RequestActionPath<'approvals'>, 'post'>;

export interface QueueSelections {
  groups: SelectionItem<'groups'>[];
  profiles: SelectionItem<'resource-profiles'>[];
  initiatives: SelectionItem<'initiatives'>[];
  people: QueuePersonSelection[];
}

export type QueuePersonSelection = ApiResponse<'/api/resource-allocation/v1/requests/{id}/approval-candidates', 'get'>['items'][number];
export type RequestActionProblem = ApiProblem;

export class RequestQueueRequestError extends ResourceAllocationApiError {
  constructor(status: number | null, problem: RequestActionProblem | null) {
    super(status, problem, status === null ? 'The request queue service could not be reached.' : `The request action failed with status ${status}.`, 'RequestQueueRequestError');
  }
}

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

function throwRequestError(error: unknown): never {
  return throwApiRequestError(error, RequestQueueRequestError);
}

export async function getRequestQueue(
  localUserId: string,
  queue: RequestQueueCode,
  cursor: string | null,
  filters: RequestQueueFilters = {},
): Promise<RequestQueueCollection> {
  try {
    const response = await api.get<RequestQueueCollection>(`${API_ROOT}/request-queues/${queue}`, {
      headers: headers(localUserId),
      params: { limit: 50, ...(cursor ? { cursor } : {}), ...filters } satisfies ApiQuery<RequestQueuePath, 'get'>,
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

async function loadPeoplePage(
  localUserId: string,
  requestId: string,
  cursor: string | null,
): Promise<ApiResponse<'/api/resource-allocation/v1/requests/{id}/approval-candidates', 'get'>> {
  const response = await api.get<ApiResponse<'/api/resource-allocation/v1/requests/{id}/approval-candidates', 'get'>>(
    `${API_ROOT}/requests/${encodeURIComponent(requestId)}/approval-candidates`,
    {
      headers: headers(localUserId),
      params: { limit: 50, ...(cursor ? { cursor } : {}) } satisfies ApiQuery<'/api/resource-allocation/v1/requests/{id}/approval-candidates', 'get'>,
    },
  );
  return response.data;
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
      const page = await loadPeoplePage(localUserId, requestId, cursor);
      people.push(...page.items);
      cursor = page.page.nextCursor;
    } catch (error) {
      return throwRequestError(error);
    }
  } while (cursor !== null);
  return people;
}

async function loadSelectionPages<C extends 'groups' | 'resource-profiles' | 'initiatives'>(
  localUserId: string,
  collection: C,
): Promise<SelectionItem<C>[]> {
  const items: SelectionItem<C>[] = [];
  let cursor: string | null = null;
  do {
    const page: SelectionCollectionPage<C> = await getSelectionCollection(collection, localUserId, cursor);
    items.push(...page.items);
    cursor = page.page.nextCursor;
  } while (cursor !== null);
  return items;
}

async function postAction<Action extends RequestAction>(
  localUserId: string,
  requestId: string,
  action: Action,
  version: number,
  idempotencyKey: string,
  body: ApiRequestBody<RequestActionPath<Action>, 'post'>,
): Promise<ApiResponse<RequestActionPath<Action>, 'post'>> {
  try {
    const response = await api.post<ApiResponse<RequestActionPath<Action>, 'post'>>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/${action}`, body, {
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
  return postAction(localUserId, requestId, 'referrals', version, idempotencyKey, {});
}

export function approveRequest(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  approval: ApiRequestBody<RequestActionPath<'approvals'>, 'post'>,
) {
  return postAction(localUserId, requestId, 'approvals', version, idempotencyKey, approval);
}

export function correctRequestReferences(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  correction: ApiRequestBody<RequestActionPath<'reference-corrections'>, 'post'>,
) {
  return postAction(localUserId, requestId, 'reference-corrections', version, idempotencyKey, correction);
}

export function removeRequestAdministratively(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  reason: string,
) {
  return postAction(
    localUserId, requestId, 'administrative-removals', version, idempotencyKey, { reason },
  );
}

export type ExceptionStrategyInput = ApiRequestBody<RequestActionPath<'strategies'>, 'post'>;
export type ExceptionResolutionInput = ApiRequestBody<RequestActionPath<'resolutions'>, 'post'>;

export function escalateRequest(localUserId: string, requestId: string, version: number, idempotencyKey: string, reason: string) {
  return postAction(localUserId, requestId, 'escalations', version, idempotencyKey, { reason });
}

export function cancelExceptionRequest(localUserId: string, requestId: string, version: number, idempotencyKey: string, reason: string) {
  return postAction(localUserId, requestId, 'cancellations', version, idempotencyKey, { reason });
}

export function recordExceptionStrategy(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  strategy: ExceptionStrategyInput,
) {
  return postAction(localUserId, requestId, 'strategies', version, idempotencyKey, { ...strategy });
}

export function resolveException(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
  resolution: ExceptionResolutionInput,
) {
  return postAction(localUserId, requestId, 'resolutions', version, idempotencyKey, { ...resolution });
}
