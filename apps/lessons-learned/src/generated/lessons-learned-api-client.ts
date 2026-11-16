/* This file is generated from services/lessons-learned-api/openapi/lessons-learned-v1.json. Do not edit directly. */
import axios from 'axios';
import type { components, paths } from './lessons-learned-api';

export const LESSONS_LEARNED_HEALTH_PATH = '/api/lessons-learned/v1/health' satisfies keyof paths;
export const LESSONS_LEARNED_HOME_PATH = '/api/lessons-learned/v1/home' satisfies keyof paths;
export const LESSONS_LEARNED_LESSONS_PATH = '/api/lessons-learned/v1/lessons' satisfies keyof paths;
export const LESSONS_LEARNED_PROJECTS_PATH = '/api/lessons-learned/v1/lessons/projects' satisfies keyof paths;
export const LESSONS_LEARNED_SUBMISSIONS_PATH = '/api/lessons-learned/v1/lessons/mine' satisfies keyof paths;
export const LESSONS_LEARNED_PMO_DRAFTS_PATH = '/api/lessons-learned/v1/lessons/pmo-drafts' satisfies keyof paths;
export const LESSONS_LEARNED_EVALUATION_QUEUE_PATH = '/api/lessons-learned/v1/lessons/evaluation-queue' satisfies keyof paths;
export const LESSONS_LEARNED_EVALUATION_PROJECTS_PATH = '/api/lessons-learned/v1/lessons/evaluation-queue/projects' satisfies keyof paths;
export const LESSONS_LEARNED_LIBRARY_PATH = '/api/lessons-learned/v1/lessons/library' satisfies keyof paths;
export const LESSONS_LEARNED_LIBRARY_DETAIL_PATH = '/api/lessons-learned/v1/lessons/library/{id}' satisfies keyof paths;
export const LESSONS_LEARNED_LIBRARY_VIEW_PATH = '/api/lessons-learned/v1/lessons/library/{id}/views' satisfies keyof paths;
export const LESSONS_LEARNED_LIBRARY_PROJECTS_PATH = '/api/lessons-learned/v1/lessons/library/projects' satisfies keyof paths;
export const LESSONS_LEARNED_DRAFT_PATH = '/api/lessons-learned/v1/lessons/{id}' satisfies keyof paths;
export const LESSONS_LEARNED_SUBMIT_PATH = '/api/lessons-learned/v1/lessons/{id}/submit' satisfies keyof paths;
export const LESSONS_LEARNED_RETURN_PATH = '/api/lessons-learned/v1/lessons/{id}/return' satisfies keyof paths;
export const LESSONS_LEARNED_CANCEL_PATH = '/api/lessons-learned/v1/lessons/{id}/cancel' satisfies keyof paths;
export const LESSONS_LEARNED_APPROVE_PATH = '/api/lessons-learned/v1/lessons/{id}/approve' satisfies keyof paths;
export const LESSONS_LEARNED_REJECT_PATH = '/api/lessons-learned/v1/lessons/{id}/reject' satisfies keyof paths;
export const LESSONS_LEARNED_CLOSE_PATH = '/api/lessons-learned/v1/lessons/{id}/close' satisfies keyof paths;
type HealthResponse = paths[typeof LESSONS_LEARNED_HEALTH_PATH]['get']['responses'][200]['content']['application/json'];
type HomeResponse = paths[typeof LESSONS_LEARNED_HOME_PATH]['get']['responses'][200]['content']['application/json'];
export type LessonDraft = paths[typeof LESSONS_LEARNED_LESSONS_PATH]['get']['responses'][200]['content']['application/json'][number];
export type LessonDetails = paths[typeof LESSONS_LEARNED_DRAFT_PATH]['get']['responses'][200]['content']['application/json'];
export type LessonHistoryEvent = LessonDetails['history'][number];
export type LessonSubmissionsFilters = NonNullable<paths[typeof LESSONS_LEARNED_SUBMISSIONS_PATH]['get']['parameters']['query']>;
export type PmoDraftsFilters = NonNullable<paths[typeof LESSONS_LEARNED_PMO_DRAFTS_PATH]['get']['parameters']['query']>;
export type LessonPage = components['schemas']['LessonPage'];
export type LibraryLesson = components['schemas']['LessonLibraryResponse'];
export type LibraryPage = components['schemas']['LessonLibraryPage'];
type PageParameters = { paged: 'true'; cursor?: string };
export type LessonsLibraryFilters = Omit<NonNullable<paths[typeof LESSONS_LEARNED_LIBRARY_PATH]['get']['parameters']['query']>, 'paged' | 'cursor' | 'limit'>;
type LibraryPageParameters = PageParameters & LessonsLibraryFilters;
export type PmoEvaluationQueueFilters = Omit<NonNullable<paths[typeof LESSONS_LEARNED_EVALUATION_QUEUE_PATH]['get']['parameters']['query']>, 'paged' | 'cursor' | 'limit'>;
export type CreateLessonDraftBody = paths[typeof LESSONS_LEARNED_LESSONS_PATH]['post']['requestBody']['content']['application/json'];
export type LessonProject = paths[typeof LESSONS_LEARNED_PROJECTS_PATH]['get']['responses'][200]['content']['application/json'][number];
export type UpdateLessonDraftBody = paths[typeof LESSONS_LEARNED_DRAFT_PATH]['patch']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type SubmitLessonBody = paths[typeof LESSONS_LEARNED_SUBMIT_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type ReturnLessonBody = paths[typeof LESSONS_LEARNED_RETURN_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type CancelLessonBody = paths[typeof LESSONS_LEARNED_CANCEL_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type ApproveLessonBody = paths[typeof LESSONS_LEARNED_APPROVE_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type RejectLessonBody = paths[typeof LESSONS_LEARNED_REJECT_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type CloseLessonBody = paths[typeof LESSONS_LEARNED_CLOSE_PATH]['post']['requestBody']['content']['application/json'] & { version: number; etag?: string };
export type RecordLibraryViewBody = paths[typeof LESSONS_LEARNED_LIBRARY_VIEW_PATH]['post']['requestBody']['content']['application/json'];
export type RecordLibraryViewResponse = paths[typeof LESSONS_LEARNED_LIBRARY_VIEW_PATH]['post']['responses'][200]['content']['application/json'];

export const LESSONS_LEARNED_API_TIMEOUT_MS = 5_000;

export const api = axios.create();
api.defaults.headers.common.Accept = 'application/json, application/problem+json';

api.interceptors.response.use(undefined, (error: unknown) => {
  if (axios.isAxiosError(error) && error.response &&
    String(error.response.headers['content-type']).startsWith('application/problem+json')) {
    const problem = error.response.data as Partial<components['schemas']['LessonProblem']>;
    const fieldErrors = Object.fromEntries((problem.errors ?? []).map(({ path, message }) => [path, message]));
    error.response.data = {
      ...problem,
      code: problem.code === 'PRECONDITION_FAILED' ? 'STALE_LESSON_VERSION' : problem.code,
      message: problem.detail,
      ...(Object.keys(fieldErrors).length ? { fieldErrors } : {}),
    };
  }
  return Promise.reject(error);
});

export async function getHealth(): Promise<HealthResponse> {
  const { data } = await api.get<HealthResponse>(LESSONS_LEARNED_HEALTH_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
  });

  if (data.status !== 'ok') {
    throw new Error('The Lessons Learned API is unavailable.');
  }

  return data;
}

export async function getHome(localUserId: string): Promise<HomeResponse> {
  const { data } = await api.get<HomeResponse>(LESSONS_LEARNED_HOME_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function getMyOpenDrafts(localUserId: string): Promise<LessonDraft[]> {
  const { data } = await api.get<LessonDraft[]>(LESSONS_LEARNED_LESSONS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function getMySubmissions(localUserId: string, filters: LessonSubmissionsFilters = {}): Promise<LessonDraft[]> {
  const { data } = await api.get<LessonDraft[]>(LESSONS_LEARNED_SUBMISSIONS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
    params: filters,
  });

  return data;
}

export async function getPmoDrafts(localUserId: string, filters: PmoDraftsFilters = {}): Promise<LessonDraft[]> {
  const { data } = await api.get<LessonDraft[]>(LESSONS_LEARNED_PMO_DRAFTS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
    params: filters,
  });

  return data;
}

export function getPmoEvaluationQueue(localUserId: string, filters?: PmoEvaluationQueueFilters): Promise<LessonDraft[]>;
export function getPmoEvaluationQueue(localUserId: string, filters: PmoEvaluationQueueFilters, page: PageParameters): Promise<LessonPage | LessonDraft[]>;
export async function getPmoEvaluationQueue(
  localUserId: string,
  filters: PmoEvaluationQueueFilters = {},
  page?: PageParameters,
): Promise<LessonPage | LessonDraft[]> {
  const { data } = await api.get<LessonPage | LessonDraft[]>(LESSONS_LEARNED_EVALUATION_QUEUE_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
    params: page ? { ...filters, ...page } : filters,
  });

  return data;
}

export async function getEvaluationProjectSnapshots(localUserId: string, signal?: AbortSignal): Promise<LessonProject[]> {
  const projects: LessonProject[] = [];
  let cursor: string | undefined;
  try {
    do {
      const { data } = await api.get<LessonProject[] | components['schemas']['LessonProjectPage']>(
        LESSONS_LEARNED_EVALUATION_PROJECTS_PATH, {
          timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
          headers: { 'X-PMO-Local-User-ID': localUserId },
          params: { paged: 'true', cursor },
          signal,
        },
      );
      if (Array.isArray(data)) return data;
      projects.push(...data.items);
      cursor = data.page.nextCursor ?? undefined;
    } while (cursor);
    return projects;
  } catch (error) {
    if (cursor || !axios.isAxiosError(error) || error.response?.status !== 404) throw error;
    const legacy = await getPmoEvaluationQueue(localUserId);
    return legacy.flatMap(({ projectId, projectName }) =>
      projectId && projectName ? [{ id: projectId, name: projectName }] : [],
    );
  }
}

export function getLibrary(localUserId: string): Promise<LibraryLesson[]>;
export function getLibrary(localUserId: string, page: LibraryPageParameters): Promise<LibraryPage | LibraryLesson[]>;
export async function getLibrary(localUserId: string, page?: LibraryPageParameters): Promise<LibraryPage | LibraryLesson[]> {
  const { data } = await api.get<LibraryPage | LibraryLesson[]>(LESSONS_LEARNED_LIBRARY_PATH, {
    ...(page ? { params: page } : {}),
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function getLibraryProjectSnapshots(localUserId: string): Promise<LessonProject[]> {
  const { data } = await api.get<LessonProject[]>(LESSONS_LEARNED_LIBRARY_PROJECTS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function getLibraryLessonDetails(localUserId: string, lessonId: number): Promise<LessonDetails> {
  const { data } = await api.get<LessonDetails>(LESSONS_LEARNED_LIBRARY_DETAIL_PATH.replace('{id}', String(lessonId)), {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function recordLibraryView(
  localUserId: string,
  lessonId: number,
  input: RecordLibraryViewBody,
): Promise<RecordLibraryViewResponse> {
  const { data } = await api.post<RecordLibraryViewResponse>(
    LESSONS_LEARNED_LIBRARY_VIEW_PATH.replace('{id}', String(lessonId)),
    input,
    {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
    },
  );

  return data;
}

export async function getLessonDetails(localUserId: string, lessonId: number): Promise<LessonDetails> {
  const { data } = await api.get<LessonDetails>(LESSONS_LEARNED_DRAFT_PATH.replace('{id}', String(lessonId)), {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function createLessonDraft(
  localUserId: string,
  titleOrInput: string | CreateLessonDraftBody,
): Promise<LessonDraft> {
  const body: CreateLessonDraftBody = typeof titleOrInput === 'string' ? { title: titleOrInput } : titleOrInput;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_LESSONS_PATH, body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function getLessonProjects(localUserId: string): Promise<LessonProject[]> {
  const { data } = await api.get<LessonProject[]>(LESSONS_LEARNED_PROJECTS_PATH, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function updateLessonDraft(
  localUserId: string,
  lessonId: number,
  input: UpdateLessonDraftBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.patch<LessonDraft>(LESSONS_LEARNED_DRAFT_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function submitLesson(
  localUserId: string,
  lessonId: number,
  input: SubmitLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_SUBMIT_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function returnLesson(
  localUserId: string,
  lessonId: number,
  input: ReturnLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_RETURN_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function cancelLesson(
  localUserId: string,
  lessonId: number,
  input: CancelLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_CANCEL_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function approveLesson(
  localUserId: string,
  lessonId: number,
  input: ApproveLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_APPROVE_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });
  return data;
}

export async function rejectLesson(
  localUserId: string,
  lessonId: number,
  input: RejectLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_REJECT_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}

export async function closeLesson(
  localUserId: string,
  lessonId: number,
  input: CloseLessonBody,
): Promise<LessonDraft> {
  const { etag, ...body } = input;
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_CLOSE_PATH.replace('{id}', String(lessonId)), body, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId, ...(etag ? { 'If-Match': etag } : {}) },
  });

  return data;
}
