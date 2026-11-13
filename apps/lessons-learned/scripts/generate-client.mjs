import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = resolve(appDirectory, '../../services/lessons-learned-api/openapi/lessons-learned-v1.json');
const outputPath = resolve(appDirectory, 'src/generated/lessons-learned-api-client.ts');
const healthPath = '/api/lessons-learned/v1/health';
const homePath = '/api/lessons-learned/v1/home';
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const operation = contract.paths?.[healthPath]?.get;
const responseSchema = operation?.responses?.['200']?.content?.['application/json']?.schema;
const homeOperation = contract.paths?.[homePath]?.get;
const homeResponseSchema = homeOperation?.responses?.['200']?.content?.['application/json']?.schema;

if (!operation || responseSchema?.$ref !== '#/components/schemas/HealthResponse') {
  throw new Error(`Expected GET ${healthPath} with a HealthResponse schema in ${contractPath}`);
}

if (!homeOperation || homeResponseSchema?.$ref !== '#/components/schemas/LessonsLearnedHomeResponse') {
  throw new Error(`Expected GET ${homePath} with a LessonsLearnedHomeResponse schema in ${contractPath}`);
}

const generatedClient = `/* This file is generated from services/lessons-learned-api/openapi/lessons-learned-v1.json. Do not edit directly. */
import axios from 'axios';
import type { paths } from './lessons-learned-api';

export const LESSONS_LEARNED_HEALTH_PATH = '${healthPath}' satisfies keyof paths;
export const LESSONS_LEARNED_HOME_PATH = '${homePath}' satisfies keyof paths;
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
`;

await writeFile(outputPath, generatedClient, 'utf8');
