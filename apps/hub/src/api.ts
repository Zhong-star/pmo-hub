import axios from 'axios';
import type { components, paths } from './generated/hub-api';

export type LocalUser = components['schemas']['LocalUserDto'];
export type HubStatus = paths['/api/hub/v1/status']['get']['responses'][200]['content']['application/json'];

export const HUB_API_TIMEOUT_MS = 5_000;

const api = axios.create({
  baseURL: import.meta.env.VITE_HUB_API_BASE_URL ?? '',
});

export async function getHubStatus(): Promise<HubStatus> {
  const { data } = await api.get<HubStatus>('/api/hub/v1/status', { timeout: HUB_API_TIMEOUT_MS });
  if (data.status !== 'available') {
    throw new Error('The Hub is currently unavailable.');
  }
  return data;
}

export async function getLocalUsers(): Promise<LocalUser[]> {
  const { data } = await api.get<LocalUser[]>('/api/hub/v1/local-users', { timeout: HUB_API_TIMEOUT_MS });
  return data;
}

export async function getLocalUser(id: string): Promise<LocalUser> {
  const { data } = await api.get<LocalUser>(`/api/hub/v1/local-users/${encodeURIComponent(id)}`, { timeout: HUB_API_TIMEOUT_MS });
  return data;
}
