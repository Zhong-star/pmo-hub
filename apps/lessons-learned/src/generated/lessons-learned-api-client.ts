/* This file is generated from services/lessons-learned-api/openapi/lessons-learned-v1.json. Do not edit directly. */
import axios from 'axios';
import type { paths } from './lessons-learned-api';

export const LESSONS_LEARNED_HEALTH_PATH = '/api/lessons-learned/v1/health' satisfies keyof paths;
export const LESSONS_LEARNED_HOME_PATH = '/api/lessons-learned/v1/home' satisfies keyof paths;
type HealthResponse = paths[typeof LESSONS_LEARNED_HEALTH_PATH]['get']['responses'][200]['content']['application/json'];
type HomeResponse = paths[typeof LESSONS_LEARNED_HOME_PATH]['get']['responses'][200]['content']['application/json'];

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
