import axios from 'axios';
import type { RequestCategory } from './submissionApi';

export const REQUESTS_QUERY_ROOT = ['resource-allocation-requests'] as const;
const API_ROOT = '/api/resource-allocation/v1';

export type RequestDecisionState =
  | 'WAITING_FOR_PRESENTATION'
  | 'PENDING_TEAM_DECISION'
  | 'APPROVED_WITH_CHANGES'
  | 'APPROVED'
  | 'DENIED'
  | 'PRE_N3'
  | 'ESCALATION'
  | 'REQUIRES_REVALIDATION'
  | 'CANCELLED';

export type RequestConfirmationSource = 'REQUESTER_ACCEPTANCE' | 'SYSTEM_DEADLINE' | null;

export interface RequestedConditions {
  initiativeId: string;
  initiativeCode: string;
  initiativeName: string;
  category: RequestCategory;
  groupId: string;
  groupName: string;
  resourceProfileId: string;
  resourceProfileName: string;
  startDate: string;
  endDate: string;
  weeklyHours: number;
  comment?: string;
}

export interface ApprovedRequestConditions {
  personId: string;
  personName: string;
  resourceProfileId: string;
  resourceProfileName: string;
  groupId: string;
  groupName: string;
  initiativeId: string;
  initiativeCode: string;
  initiativeName: string;
  startDate: string;
  endDate: string;
  weeklyHours: number;
  explanation?: string;
}

export interface RequestAllocation {
  id: string;
  person: { personId: string; displayName: string };
  group: { id: string; name: string };
  initiative: { id: string; code: string; name: string };
  resourceProfile: { id: string; name: string };
  startDate: string;
  endDate: string;
  weeklyHours: number;
  state: string;
  approvedAt: string;
  version: number;
}

export interface ResourceRequestItem {
  id: string;
  requesterSnapshot: { personId: string; displayName: string; role: string };
  requestedConditions: RequestedConditions;
  decisionState: RequestDecisionState;
  receivedAt: string;
  stageEnteredAt: string;
  expirationDueAt: string;
  dueAt?: string | null;
  availableActions?: string[];
  confirmationSource?: RequestConfirmationSource;
  approvedConditions?: ApprovedRequestConditions;
  allocation?: RequestAllocation;
  version: number;
}

export interface RequestAcceptanceResult {
  id: string;
  decisionState: RequestDecisionState;
  version: number;
  confirmationSource?: RequestConfirmationSource;
}

export interface ResourceRequestCollection {
  items: ResourceRequestItem[];
  page: { nextCursor: string | null; limit: number };
}

export interface RequestFilters {
  initiativeId?: string;
  decisionState?: RequestDecisionState;
  groupId?: string;
  resourceProfileId?: string;
}

export interface RequestAuditEvent {
  id: string;
  requestId: string;
  action: 'WITHDRAWN' | 'ADMIN_REMOVED' | 'EXPIRED';
  requesterSnapshot: Record<string, unknown>;
  actorSnapshot: Record<string, unknown>;
  requestSnapshot: Record<string, unknown>;
  reason: string;
  occurredAt: string;
  correlationId: string;
}

export interface RequestAudit {
  requestId: string;
  events: RequestAuditEvent[];
}

export interface RequestProblem {
  code?: string;
  detail?: string;
  title?: string;
}

export class RequestApiError extends Error {
  constructor(readonly status: number | null, readonly problem: RequestProblem | null) {
    super(problem?.detail ?? problem?.title ?? (status === null
      ? 'The request service could not be reached.'
      : `The request failed with status ${status}.`));
    this.name = 'RequestApiError';
  }
}

const api = axios.create({
  baseURL: import.meta.env.VITE_RESOURCE_ALLOCATION_API_BASE_URL ?? '',
  timeout: 10_000,
});

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

function parseProblem(payload: unknown): RequestProblem | null {
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
    throw new RequestApiError(error.response?.status ?? null, parseProblem(error.response?.data));
  }
  throw error;
}

export async function getRequestCollection(
  localUserId: string,
  filters: RequestFilters,
  cursor: string | null,
): Promise<ResourceRequestCollection> {
  try {
    const response = await api.get<ResourceRequestCollection>(`${API_ROOT}/requests`, {
      headers: headers(localUserId),
      params: { ...filters, limit: 50, ...(cursor ? { cursor } : {}) },
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function getRequest(localUserId: string, requestId: string): Promise<ResourceRequestItem> {
  try {
    const response = await api.get<ResourceRequestItem>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}`, {
      headers: headers(localUserId),
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function updateRequest(
  localUserId: string,
  requestId: string,
  version: number,
  conditions: Partial<RequestedConditions>,
): Promise<ResourceRequestItem> {
  try {
    const response = await api.patch<ResourceRequestItem>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}`, conditions, {
      headers: { ...headers(localUserId), 'If-Match': `"${version}"`, 'Content-Type': 'application/merge-patch+json' },
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function withdrawRequest(
  localUserId: string,
  requestId: string,
  version: number,
  reason: string,
  idempotencyKey: string,
): Promise<RequestAuditEvent> {
  try {
    const response = await api.post<RequestAuditEvent>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/withdrawals`, { reason }, {
      headers: { ...headers(localUserId), 'If-Match': `"${version}"`, 'Idempotency-Key': idempotencyKey },
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function acceptRequest(
  localUserId: string,
  requestId: string,
  version: number,
  idempotencyKey: string,
): Promise<RequestAcceptanceResult> {
  try {
    const response = await api.post<RequestAcceptanceResult>(`${API_ROOT}/requests/${encodeURIComponent(requestId)}/acceptances`, {}, {
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

export async function getRequestAudit(localUserId: string, requestId: string): Promise<RequestAudit> {
  try {
    const response = await api.get<RequestAudit>(`${API_ROOT}/request-audits/${encodeURIComponent(requestId)}`, {
      headers: headers(localUserId),
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}
