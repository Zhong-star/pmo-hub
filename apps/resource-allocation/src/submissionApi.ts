import axios from 'axios';

export const SUBMISSIONS_QUERY_ROOT = ['resource-allocation-submissions'] as const;
const API_ROOT = '/api/resource-allocation/v1';

export type RequestCategory =
  | 'DEMAND_ANALYSIS'
  | 'POC_BBP'
  | 'EXECUTION_PROJECT'
  | 'EXECUTION_FAST_TRACK'
  | 'EXECUTION_ENHANCEMENT';

export interface SelectionItem {
  id: string;
  code?: string;
  name?: string;
  groupId?: string | null;
}

export interface SelectionCollection {
  items: SelectionItem[];
  page: { nextCursor: string | null; limit: number };
}

export interface SubmissionLineInput {
  attemptKey: string;
  groupId: string;
  resourceProfileId: string;
  startDate: string;
  endDate: string;
  weeklyHours: number;
  comment?: string;
}

export interface CreateSubmissionInput {
  initiativeId: string;
  category: RequestCategory;
  lines: SubmissionLineInput[];
}

export interface SubmissionCounts {
  received: number;
  processing: number;
  succeeded: number;
  failed: number;
}

export interface SubmissionSummary {
  id: string;
  initiativeId?: string;
  initiative?: SelectionItem;
  category?: RequestCategory;
  receivedAt: string;
  lineCount: number;
  counts: SubmissionCounts;
}

export interface SubmissionCollection {
  items: SubmissionSummary[];
  page: { nextCursor: string | null; limit: number };
}

export interface SubmissionProblem {
  code?: string;
  detail?: string;
  title?: string;
  errors?: Array<{ path?: string; message?: string }>;
}

export type SubmissionLineStatus = 'RECEIVED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | string;

export interface SubmittedConditions {
  initiativeId?: string;
  category?: RequestCategory;
  attemptKey?: string;
  groupId: string;
  resourceProfileId: string;
  startDate: string;
  endDate: string;
  weeklyHours: number;
  comment?: string;
}

export interface SubmissionLine {
  id: string;
  attemptKey: string;
  submittedConditions: SubmittedConditions;
  status: SubmissionLineStatus;
  requestId?: string;
  problem?: SubmissionProblem;
  receivedAt: string;
  completedAt?: string;
  requestOutcome?: string | {
    decisionState?: string;
    requestedConditions?: Partial<SubmittedConditions>;
  };
}

export interface SubmissionLineCollection {
  items: SubmissionLine[];
  page: { nextCursor: string | null; limit: number };
}

export interface SubmissionReceipt {
  id: string;
  receivedAt: string;
  lineCount: number;
  counts: SubmissionCounts;
}

export class SubmissionRequestError extends Error {
  constructor(readonly status: number | null, readonly problem: SubmissionProblem | null) {
    super(problem?.detail ?? problem?.title ?? (status === null
      ? 'The submission service could not be reached.'
      : `The submission request failed with status ${status}.`));
    this.name = 'SubmissionRequestError';
  }
}

const api = axios.create({
  baseURL: import.meta.env.VITE_RESOURCE_ALLOCATION_API_BASE_URL ?? '',
  timeout: 10_000,
});

function parseProblem(payload: unknown): SubmissionProblem | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  const errors = Array.isArray(value.errors)
    ? value.errors.filter((item): item is { path?: string; message?: string } =>
      typeof item === 'object' && item !== null &&
      (!('path' in item) || typeof item.path === 'string') &&
      (!('message' in item) || typeof item.message === 'string'))
    : undefined;
  return {
    code: typeof value.code === 'string' ? value.code : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
    title: typeof value.title === 'string' ? value.title : undefined,
    errors,
  };
}

function throwRequestError(error: unknown): never {
  if (axios.isAxiosError(error)) {
    throw new SubmissionRequestError(error.response?.status ?? null, parseProblem(error.response?.data));
  }
  throw error;
}

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

export async function getSelectionCollection(
  collection: 'groups' | 'resource-profiles' | 'initiatives',
  localUserId: string,
  cursor: string | null,
  groupId?: string,
): Promise<SelectionCollection> {
  try {
    const response = await api.get<SelectionCollection>(`${API_ROOT}/${collection}`, {
      headers: headers(localUserId),
      params: { limit: 100, ...(cursor ? { cursor } : {}), ...(groupId ? { groupId } : {}) },
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function getSubmissionCollection(localUserId: string, cursor: string | null): Promise<SubmissionCollection> {
  try {
    const response = await api.get<SubmissionCollection>(`${API_ROOT}/submissions`, {
      headers: headers(localUserId),
      params: { limit: 50, ...(cursor ? { cursor } : {}) },
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function getSubmission(localUserId: string, submissionId: string): Promise<SubmissionSummary> {
  try {
    const response = await api.get<SubmissionSummary>(`${API_ROOT}/submissions/${encodeURIComponent(submissionId)}`, {
      headers: headers(localUserId),
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function getSubmissionLines(
  localUserId: string,
  submissionId: string,
  cursor: string | null = null,
): Promise<SubmissionLineCollection> {
  try {
    const response = await api.get<SubmissionLineCollection>(
      `${API_ROOT}/submissions/${encodeURIComponent(submissionId)}/lines`,
      { headers: headers(localUserId), params: { limit: 100, ...(cursor ? { cursor } : {}) } },
    );
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function createSubmission(
  localUserId: string,
  submission: CreateSubmissionInput,
  idempotencyKey: string,
): Promise<SubmissionReceipt> {
  try {
    const response = await api.post<SubmissionReceipt>(`${API_ROOT}/submissions`, submission, {
      headers: { ...headers(localUserId), 'Idempotency-Key': idempotencyKey },
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}
