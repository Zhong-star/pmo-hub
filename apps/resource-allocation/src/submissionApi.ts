import { api, throwApiRequestError, ResourceAllocationApiError } from './apiClient';
import type { ApiProblem, ApiRequestBody, ApiResponse } from './apiContracts';

export const SUBMISSIONS_QUERY_ROOT = ['resource-allocation-submissions'] as const;
export const SELECTIONS_QUERY_ROOT = ['resource-allocation-selections'] as const;
const API_ROOT = '/api/resource-allocation/v1';

type SelectionPath = {
  groups: '/api/resource-allocation/v1/groups';
  'resource-profiles': '/api/resource-allocation/v1/resource-profiles';
  initiatives: '/api/resource-allocation/v1/initiatives';
};
type SelectionCollectionName = keyof SelectionPath;
type SelectionResponse<C extends SelectionCollectionName> = C extends SelectionCollectionName
  ? ApiResponse<SelectionPath[C], 'get'>
  : never;

export type RequestCategory = ApiRequestBody<'/api/resource-allocation/v1/submissions', 'post'>['category'];
export type SelectionCollection = SelectionResponse<SelectionCollectionName>;
export type SelectionItem<C extends SelectionCollectionName = SelectionCollectionName> = SelectionResponse<C>['items'][number];
export type SelectionCollectionPage<C extends SelectionCollectionName> = SelectionResponse<C>;
export type SubmissionLineInput = ApiRequestBody<'/api/resource-allocation/v1/submissions', 'post'>['lines'][number];
export type CreateSubmissionInput = ApiRequestBody<'/api/resource-allocation/v1/submissions', 'post'>;
export type SubmissionCollection = ApiResponse<'/api/resource-allocation/v1/submissions', 'get'>;
export type SubmissionSummary = SubmissionCollection['items'][number];
export type SubmissionLineCollection = ApiResponse<'/api/resource-allocation/v1/submissions/{id}/lines', 'get'>;
export type SubmissionLine = SubmissionLineCollection['items'][number];
export type SubmissionCounts = SubmissionSummary['counts'];
export type SubmissionProblem = NonNullable<SubmissionLine['problem']>;
export type SubmissionLineStatus = SubmissionLine['status'];
export type SubmittedConditions = SubmissionLine['submittedConditions'];
export type SubmissionReceipt = ApiResponse<'/api/resource-allocation/v1/submissions', 'post'>;

export class SubmissionRequestError extends ResourceAllocationApiError {
  constructor(status: number | null, problem: ApiProblem | null) {
    super(status, problem, status === null ? 'The submission service could not be reached.' : `The submission request failed with status ${status}.`, 'SubmissionRequestError');
  }
}

function throwRequestError(error: unknown): never {
  return throwApiRequestError(error, SubmissionRequestError);
}

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

export async function getSelectionCollection<C extends SelectionCollectionName>(
  collection: C,
  localUserId: string,
  cursor: string | null,
  groupId?: string,
): Promise<SelectionResponse<C>> {
  try {
    const response = await api.get<SelectionResponse<C>>(`${API_ROOT}/${collection}`, {
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
