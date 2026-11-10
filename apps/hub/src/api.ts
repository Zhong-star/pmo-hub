import axios from 'axios';
import type { components, paths } from './generated/hub-api';

export type LocalUser = components['schemas']['LocalUserDto'];
const statusPath = '/api/hub/v1/status' satisfies keyof paths;
const localUsersPath = '/api/hub/v1/local-users' satisfies keyof paths;
const localUserPathTemplate = '/api/hub/v1/local-users/{id}' satisfies keyof paths;
export type HubStatus = paths[typeof statusPath]['get']['responses'][200]['content']['application/json'];
type LocalUsersResponse = paths[typeof localUsersPath]['get']['responses'][200]['content']['application/json'];
type LocalUserResponse = paths[typeof localUserPathTemplate]['get']['responses'][200]['content']['application/json'];

export const HUB_API_TIMEOUT_MS = 5_000;

const api = axios.create({
  baseURL: import.meta.env.VITE_HUB_API_BASE_URL ?? '',
});

export async function getHubStatus(): Promise<HubStatus> {
  const { data } = await api.get<HubStatus>(statusPath, { timeout: HUB_API_TIMEOUT_MS });
  if (data.status !== 'available') {
    throw new Error('The Hub is currently unavailable.');
  }
  return data;
}

export async function getLocalUsers(): Promise<LocalUser[]> {
  const { data } = await api.get<LocalUsersResponse>(localUsersPath, { timeout: HUB_API_TIMEOUT_MS });
  return data;
}

export async function getLocalUser(id: string): Promise<LocalUser> {
  const url = localUserPathTemplate.replace('{id}', encodeURIComponent(id));
  const { data } = await api.get<LocalUserResponse>(url, { timeout: HUB_API_TIMEOUT_MS });
  return data;
}
