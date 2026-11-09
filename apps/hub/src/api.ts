import axios from 'axios';

export interface LocalUser {
  id: string;
  displayName: string;
}

interface HubStatus {
  status: 'available';
}

const api = axios.create({
  baseURL: import.meta.env.VITE_HUB_API_BASE_URL ?? '',
});

export async function getHubStatus(): Promise<HubStatus> {
  const { data } = await api.get<HubStatus>('/api/hub/v1/status');
  if (data.status !== 'available') {
    throw new Error('The Hub is currently unavailable.');
  }
  return data;
}

export async function getLocalUsers(): Promise<LocalUser[]> {
  const { data } = await api.get<LocalUser[]>('/api/hub/v1/local-users');
  return data;
}

export async function getLocalUser(id: string): Promise<LocalUser> {
  const { data } = await api.get<LocalUser>(`/api/hub/v1/local-users/${encodeURIComponent(id)}`);
  return data;
}
