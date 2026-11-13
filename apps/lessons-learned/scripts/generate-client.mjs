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
const draftPath = `${lessonsPath}/{id}`;
const submitPath = `${draftPath}/submit`;
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
const updateLessonOperation = contract.paths?.[draftPath]?.patch;
const updateLessonRequestSchema = updateLessonOperation?.requestBody?.content?.['application/json']?.schema;
const updateLessonResponseSchema = updateLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;
const submitLessonOperation = contract.paths?.[submitPath]?.post;
const submitLessonRequestSchema = submitLessonOperation?.requestBody?.content?.['application/json']?.schema;
const submitLessonResponseSchema = submitLessonOperation?.responses?.['200']?.content?.['application/json']?.schema;

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

if (!updateLessonOperation || updateLessonRequestSchema?.$ref !== '#/components/schemas/UpdateLessonDraftRequest' ||
  updateLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected PATCH ${draftPath} with UpdateLessonDraftRequest and LessonDraftResponse in ${contractPath}`);
}

if (!submitLessonOperation || submitLessonRequestSchema?.$ref !== '#/components/schemas/SubmitLessonRequest' ||
  submitLessonResponseSchema?.$ref !== '#/components/schemas/LessonDraftResponse') {
  throw new Error(`Expected POST ${submitPath} with SubmitLessonRequest and LessonDraftResponse in ${contractPath}`);
}

const generatedClient = `/* This file is generated from services/lessons-learned-api/openapi/lessons-learned-v1.json. Do not edit directly. */
import axios from 'axios';
import type { paths } from './lessons-learned-api';

export const LESSONS_LEARNED_HEALTH_PATH = '${healthPath}' satisfies keyof paths;
export const LESSONS_LEARNED_HOME_PATH = '${homePath}' satisfies keyof paths;
export const LESSONS_LEARNED_LESSONS_PATH = '${lessonsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_PROJECTS_PATH = '${projectsPath}' satisfies keyof paths;
export const LESSONS_LEARNED_DRAFT_PATH = '${draftPath}' satisfies keyof paths;
export const LESSONS_LEARNED_SUBMIT_PATH = '${submitPath}' satisfies keyof paths;
type HealthResponse = paths[typeof LESSONS_LEARNED_HEALTH_PATH]['get']['responses'][200]['content']['application/json'];
type HomeResponse = paths[typeof LESSONS_LEARNED_HOME_PATH]['get']['responses'][200]['content']['application/json'];
export type LessonDraft = paths[typeof LESSONS_LEARNED_LESSONS_PATH]['get']['responses'][200]['content']['application/json'][number];
export type CreateLessonDraftBody = paths[typeof LESSONS_LEARNED_LESSONS_PATH]['post']['requestBody']['content']['application/json'];
export type LessonProject = paths[typeof LESSONS_LEARNED_PROJECTS_PATH]['get']['responses'][200]['content']['application/json'][number];
export type UpdateLessonDraftBody = paths[typeof LESSONS_LEARNED_DRAFT_PATH]['patch']['requestBody']['content']['application/json'];
export type SubmitLessonBody = paths[typeof LESSONS_LEARNED_SUBMIT_PATH]['post']['requestBody']['content']['application/json'];

export const LESSONS_LEARNED_API_TIMEOUT_MS = 5_000;

export const api = axios.create();

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
  const { data } = await api.patch<LessonDraft>(LESSONS_LEARNED_DRAFT_PATH.replace('{id}', String(lessonId)), input, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}

export async function submitLesson(
  localUserId: string,
  lessonId: number,
  input: SubmitLessonBody,
): Promise<LessonDraft> {
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_SUBMIT_PATH.replace('{id}', String(lessonId)), input, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}
`;

await writeFile(outputPath, generatedClient, 'utf8');
