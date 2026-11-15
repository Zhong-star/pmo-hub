import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = resolve(appDirectory, '../../services/lessons-learned-api/openapi/lessons-learned-v1.json');
const outputPath = resolve(appDirectory, 'src/generated/lessons-learned-api-client.ts');
const healthPath = '/api/lessons-learned/v1/health';
const homePath = '/api/lessons-learned/v1/home';
const lessonsPath = '/api/lessons-learned/v1/lessons';
const projectsPath = `${lessonsPath}/projects`;
const submissionsPath = `${lessonsPath}/mine`;
const pmoDraftsPath = `${lessonsPath}/pmo-drafts`;
const evaluationQueuePath = `${lessonsPath}/evaluation-queue`;
const evaluationProjectsPath = evaluationQueuePath + '/projects';
const libraryPath = `${lessonsPath}/library`;
const draftPath = `${lessonsPath}/{id}`;
const submitPath = `${draftPath}/submit`;
const returnPath = `${draftPath}/return`;
const cancelPath = `${draftPath}/cancel`;
const approvePath = `${draftPath}/approve`;
const rejectPath = `${draftPath}/reject`;
const closePath = `${draftPath}/close`;
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const operation = contract.paths?.[healthPath]?.get;
const responseSchema = operation?.responses?.['200']?.content?.['application/json']?.schema;
const homeOperation = contract.paths?.[homePath]?.get;
const homeResponseSchema = homeOperation?.responses?.['200']?.content?.['application/json']?.schema;
const lessonsOperation = contract.paths?.[lessonsPath]?.get;
const lessonsResponseSchema = lessonsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const createLessonOperation = contract.paths?.[lessonsPath]?.post;
const createLessonRequestSchema = createLessonOperation?.requestBody?.content?.['application/json']?.schema;
const createLessonResponseSchema = createLessonOperation?.responses?.['201']?.content?.['application/json']?.schema;
const projectsOperation = contract.paths?.[projectsPath]?.get;
const projectsResponseSchema = projectsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const submissionsOperation = contract.paths?.[submissionsPath]?.get;
const submissionsResponseSchema = submissionsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const pmoDraftsOperation = contract.paths?.[pmoDraftsPath]?.get;
const pmoDraftsResponseSchema = pmoDraftsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const evaluationQueueOperation = contract.paths?.[evaluationQueuePath]?.get;
const evaluationQueueResponseSchema = evaluationQueueOperation?.responses?.['200']?.content?.['application/json']?.schema;
const libraryOperation = contract.paths?.[libraryPath]?.get;
const libraryResponseSchema = libraryOperation?.responses?.['200']?.content?.['application/json']?.schema;
const detailsOperation = contract.paths?.[draftPath]?.get;
const detailsResponseSchema = detailsOperation?.responses?.['200']?.content?.['application/json']?.schema;
const updateLessonOperation = contract.paths?.[draftPath]?.patch;
const updateLessonRequestSchema = updateLessonOperation?.requestBody?.content?.['application/json']?.schema;
const updateLessonResponseSchema = updateLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const submitLessonOperation = contract.paths?.[submitPath]?.post;
const submitLessonRequestSchema = submitLessonOperation?.requestBody?.content?.['application/json']?.schema;
const submitLessonResponseSchema = submitLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const returnLessonOperation = contract.paths?.[returnPath]?.post;
const returnLessonRequestSchema = returnLessonOperation?.requestBody?.content?.['application/json']?.schema;
const returnLessonResponseSchema = returnLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const cancelLessonOperation = contract.paths?.[cancelPath]?.post;
const cancelLessonRequestSchema = cancelLessonOperation?.requestBody?.content?.['application/json']?.schema;
const cancelLessonResponseSchema = cancelLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const approveLessonOperation = contract.paths?.[approvePath]?.post;
const approveLessonRequestSchema = approveLessonOperation?.requestBody?.content?.['application/json']?.schema;
const approveLessonResponseSchema = approveLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const rejectLessonOperation = contract.paths?.[rejectPath]?.post;
const rejectLessonRequestSchema = rejectLessonOperation?.requestBody?.content?.['application/json']?.schema;
const rejectLessonResponseSchema = rejectLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const closeLessonOperation = contract.paths?.[closePath]?.post;
const closeLessonRequestSchema = closeLessonOperation?.requestBody?.content?.['application/json']?.schema;
const closeLessonResponseSchema = closeLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;

if (!operation || responseSchema?.$ref !== '#/components/schemas/HealthResponse') {
  throw new Error(`Expected GET ${healthPath} with a HealthResponse schema in ${contractPath}`);
}

if (!homeOperation || homeResponseSchema?.$ref !== '#/components/schemas/LessonsLearnedHomeResponse') {
  throw new Error(`Expected GET ${homePath} with a LessonsLearnedHomeResponse schema in ${contractPath}`);
}

if (!lessonsOperation || lessonsResponseSchema?.type !== 'array' ||
  lessonsResponseSchema.items?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected GET ${lessonsPath} with an array of LessonDraftResponse in ${contractPath}`);
}

if (!createLessonOperation || createLessonRequestSchema?.$ref !== '#/components/schemas/CreateLessonRequest' ||
  createLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${lessonsPath} with CreateLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!projectsOperation || projectsResponseSchema?.type !== 'array' ||
  projectsResponseSchema.items?.$ref !== '#/components/schemas/LessonProjectResponse') {
  throw new Error(`Expected GET ${projectsPath} with an array of LessonProjectResponse in ${contractPath}`);
}

if (!submissionsOperation || submissionsResponseSchema?.type !== 'array' ||
  submissionsResponseSchema.items?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected GET ${submissionsPath} with an array of LessonDraftResponse in ${contractPath}`);
}

if (!pmoDraftsOperation || pmoDraftsResponseSchema?.type !== 'array' ||
  pmoDraftsResponseSchema.items?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected GET ${pmoDraftsPath} with an array of LessonDraftResponse in ${contractPath}`);
}

if (!evaluationQueueResponseSchema?.oneOf?.some((schema) => schema.$ref === '#/components/schemas/LessonPage')) {
  throw new Error('Expected a LessonPage response in the Lessons Learned OpenAPI contract.');
}

if (!libraryResponseSchema?.oneOf?.some((schema) => schema.$ref === '#/components/schemas/LessonPage')) {
  throw new Error('Expected a LessonPage response in the Lessons Learned OpenAPI contract.');
}

if (!detailsOperation || detailsResponseSchema?.$ref !== '#/components/schemas/LessonDetailsResponse') {
  throw new Error(`Expected GET ${draftPath} with LessonDetailsResponse in ${contractPath}`);
}

if (!updateLessonOperation || updateLessonRequestSchema?.$ref !== '#/components/schemas/UpdateLessonDraftRequest' ||
  updateLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected PATCH ${draftPath} with UpdateLessonDraftRequest and LessonDraftResponse in ${contractPath}`);
}

if (!submitLessonOperation || submitLessonRequestSchema?.$ref !== '#/components/schemas/SubmitLessonRequest' ||
  submitLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${submitPath} with SubmitLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!returnLessonOperation || returnLessonRequestSchema?.$ref !== '#/components/schemas/ReturnLessonRequest' ||
  returnLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${returnPath} with ReturnLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!cancelLessonOperation || cancelLessonRequestSchema?.$ref !== '#/components/schemas/CancelLessonRequest' ||
  cancelLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${cancelPath} with CancelLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!approveLessonOperation || approveLessonRequestSchema?.$ref !== '#/components/schemas/ApproveLessonRequest' ||
  approveLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${approvePath} with ApproveLessonRequest and LessonDraftResponse in ${contractPath}`);
}
if (!rejectLessonOperation || rejectLessonRequestSchema?.$ref !== '#/components/schemas/RejectLessonRequest' ||
  rejectLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${rejectPath} with RejectLessonRequest and LessonDraftResponse in ${contractPath}`);
}

if (!closeLessonOperation || closeLessonRequestSchema?.$ref !== '#/components/schemas/CloseLessonRequest' ||
  closeLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${closePath} with CloseLessonRequest and LessonDraftResponse in ${contractPath}`);
}

const generatedClient = `/* This file is generated from services/lessons-learned-api/openapi/lessons-learned-v1.json. Do not edit directly. */
import axios from 'axios';
import type { components, paths } from './lessons-learned-api';

export const LESSONS_LEARNED_HEALTH_PATH = '${healthPath}' satisfies keyof paths;
export const LESSONS_LEARNED_HOME_PATH = '${homePath}' satisfies keyof paths;
export const LESSONS_LEARNED_LESSONS_PATH = '${lessonsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_PROJECTS_PATH = '${projectsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_SUBMISSIONS_PATH = '${submissionsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_PMO_DRAFTS_PATH = '${pmoDraftsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_EVALUATION_QUEUE_PATH = '${evaluationQueuePath}' satisfies keyof paths;
export const LESSONS_LEARNED_EVALUATION_PROJECTS_PATH = '${evaluationProjectsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_LIBRARY_PATH = '${libraryPath}' satisfies keyof paths;
export const LESSONS_LEARNED_DRAFT_PATH = '${draftPath}' satisfies keyof paths;
export const LESSONS_LEARNED_SUBMIT_PATH = '${submitPath}' satisfies keyof paths;
export const LESSONS_LEARNED_RETURN_PATH = '${returnPath}' satisfies keyof paths;
export const LESSONS_LEARNED_CANCEL_PATH = '${cancelPath}' satisfies keyof paths;
export const LESSONS_LEARNED_APPROVE_PATH = '${approvePath}' satisfies keyof paths;
export const LESSONS_LEARNED_REJECT_PATH = '${rejectPath}' satisfies keyof paths;
export const LESSONS_LEARNED_CLOSE_PATH = '${closePath}' satisfies keyof paths;
type HealthResponse = paths[typeof LESSONS_LEARNED_HEALTH_PATH]['get']['responses'][200]['content']['application/json'];
type HomeResponse = paths[typeof LESSONS_LEARNED_HOME_PATH]['get']['responses'][200]['content']['application/json'];
export type LessonDraft = paths[typeof LESSONS_LEARNED_LESSONS_PATH]['get']['responses'][200]['content']['application/json'][number];
export type LessonDetails = paths[typeof LESSONS_LEARNED_DRAFT_PATH]['get']['responses'][200]['content']['application/json'];
export type LessonHistoryEvent = LessonDetails['history'][number];
export type LessonSubmissionsFilters = NonNullable<paths[typeof LESSONS_LEARNED_SUBMISSIONS_PATH]['get']['parameters']['query']>;
export type PmoDraftsFilters = NonNullable<paths[typeof LESSONS_LEARNED_PMO_DRAFTS_PATH]['get']['parameters']['query']>;
export type LessonPage = components['schemas']['LessonPage'];
type PageParameters = { paged: 'true'; cursor?: string };
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

export async function getEvaluationProjectSnapshots(localUserId: string): Promise<LessonProject[]> {
  try {
    const { data } = await api.get<LessonProject[]>(LESSONS_LEARNED_EVALUATION_PROJECTS_PATH, {
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: { 'X-PMO-Local-User-ID': localUserId },
    });
    return data;
  } catch (error) {
    if (!axios.isAxiosError(error) || error.response?.status !== 404) throw error;
    const legacy = await getPmoEvaluationQueue(localUserId);
    return legacy.flatMap(({ projectId, projectName }) =>
      projectId && projectName ? [{ id: projectId, name: projectName }] : [],
    );
  }
}

export function getLibrary(localUserId: string): Promise<LessonDraft[]>;
export function getLibrary(localUserId: string, page: PageParameters): Promise<LessonPage | LessonDraft[]>;
export async function getLibrary(localUserId: string, page?: PageParameters): Promise<LessonPage | LessonDraft[]> {
  const { data } = await api.get<LessonPage | LessonDraft[]>(LESSONS_LEARNED_LIBRARY_PATH, {
    ...(page ? { params: page } : {}),
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

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
`;

await writeFile(outputPath, generatedClient, 'utf8');
