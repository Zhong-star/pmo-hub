/* This file is generated from services/lessons-learned-api/openapi/lessons-learned-v1.json. Do not edit directly. */
import axios from 'axios';
import type { paths } from './lessons-learned-api';

export const LESSONS_LEARNED_HEALTH_PATH = '/api/lessons-learned/v1/health' satisfies keyof paths;
export const LESSONS_LEARNED_HOME_PATH = '/api/lessons-learned/v1/home' satisfies keyof paths;
export const LESSONS_LEARNED_LESSONS_PATH = '/api/lessons-learned/v1/lessons' satisfies keyof paths;
export const LESSONS_LEARNED_PROJECTS_PATH = '/api/lessons-learned/v1/lessons/projects' satisfies keyof paths;
export const LESSONS_LEARNED_SUBMISSIONS_PATH = '/api/lessons-learned/v1/lessons/mine' satisfies keyof paths;
export const LESSONS_LEARNED_DRAFT_PATH = '/api/lessons-learned/v1/lessons/{id}' satisfies keyof paths;
export const LESSONS_LEARNED_SUBMIT_PATH = '/api/lessons-learned/v1/lessons/{id}/submit' satisfies keyof paths;
export const LESSONS_LEARNED_CANCEL_PATH = '/api/lessons-learned/v1/lessons/{id}/cancel' satisfies keyof paths;
type HealthResponse = paths[typeof LESSONS_LEARNED_HEALTH_PATH]['get']['responses'][200]['content']['application/json'];
type HomeResponse = paths[typeof LESSONS_LEARNED_HOME_PATH]['get']['responses'][200]['content']['application/json'];
export type LessonDraft = paths[typeof LESSONS_LEARNED_LESSONS_PATH]['get']['responses'][200]['content']['application/json'][number];
export type CreateLessonDraftBody = paths[typeof LESSONS_LEARNED_LESSONS_PATH]['post']['requestBody']['content']['application/json'];
export type LessonProject = paths[typeof LESSONS_LEARNED_PROJECTS_PATH]['get']['responses'][200]['content']['application/json'][number];
export type UpdateLessonDraftBody = paths[typeof LESSONS_LEARNED_DRAFT_PATH]['patch']['requestBody']['content']['application/json'];
export type SubmitLessonBody = paths[typeof LESSONS_LEARNED_SUBMIT_PATH]['post']['requestBody']['content']['application/json'];
export type CancelLessonBody = paths[typeof LESSONS_LEARNED_CANCEL_PATH]['post']['requestBody']['content']['application/json'];

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

export async function getMySubmissions(localUserId: string): Promise<LessonDraft[]> {
  const { data } = await api.get<LessonDraft[]>(LESSONS_LEARNED_SUBMISSIONS_PATH, {
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

export async function cancelLesson(
  localUserId: string,
  lessonId: number,
  input: CancelLessonBody,
): Promise<LessonDraft> {
  const { data } = await api.post<LessonDraft>(LESSONS_LEARNED_CANCEL_PATH.replace('{id}', String(lessonId)), input, {
    timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    headers: { 'X-PMO-Local-User-ID': localUserId },
  });

  return data;
}
