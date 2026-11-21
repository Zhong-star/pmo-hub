import axios from 'axios';

export const NOTIFICATIONS_QUERY_ROOT = ['resource-allocation-notifications'] as const;
const API_ROOT = '/api/resource-allocation/v1';

export type NotificationReadFilter = 'all' | 'read' | 'unread';

export interface ResourceNotification {
  id: string;
  eventCode: string;
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  target: {
    type: 'REQUEST';
    requestId: string;
    available: boolean;
    destination: 'REQUEST_DETAIL' | 'PRESENTATION_QUEUE' | 'TEAM_DECISION_QUEUE' | null;
  };
  etag: string;
}

export interface ResourceNotificationCollection {
  items: ResourceNotification[];
  page: { nextCursor: string | null; limit: number };
}

export interface NotificationReadAllResult {
  cutoffAt: string;
  markedCount: number;
}

interface NotificationProblem {
  code?: string;
  detail?: string;
  title?: string;
}

export class NotificationRequestError extends Error {
  constructor(readonly status: number | null, readonly problem: NotificationProblem | null) {
    super(problem?.detail ?? problem?.title ?? (status === null
      ? 'The notification service could not be reached.'
      : `The notification request failed with status ${status}.`));
    this.name = 'NotificationRequestError';
  }
}

const api = axios.create({
  baseURL: import.meta.env.VITE_RESOURCE_ALLOCATION_API_BASE_URL ?? '',
  timeout: 10_000,
});

function parseProblem(payload: unknown): NotificationProblem | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  return {
    code: typeof value.code === 'string' ? value.code : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
    title: typeof value.title === 'string' ? value.title : undefined,
  };
}

function throwRequestError(error: unknown): never {
  if (axios.isAxiosError(error)) {
    throw new NotificationRequestError(error.response?.status ?? null, parseProblem(error.response?.data));
  }
  throw error;
}

function headers(localUserId: string) {
  return { 'X-PMO-Local-User-ID': localUserId, 'Cache-Control': 'no-cache' };
}

export async function getNotifications(
  localUserId: string,
  filter: NotificationReadFilter,
  cursor: string | null,
): Promise<ResourceNotificationCollection> {
  try {
    const response = await api.get<ResourceNotificationCollection>(`${API_ROOT}/notifications`, {
      headers: headers(localUserId),
      params: {
        limit: 50,
        ...(filter === 'all' ? {} : { read: filter === 'read' }),
        ...(cursor ? { cursor } : {}),
      },
    });
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function markNotificationRead(
  localUserId: string,
  notificationId: string,
  etag: string,
  idempotencyKey: string,
): Promise<ResourceNotification> {
  try {
    const response = await api.post<ResourceNotification>(
      `${API_ROOT}/notifications/${encodeURIComponent(notificationId)}/readings`,
      undefined,
      { headers: { ...headers(localUserId), 'If-Match': etag, 'Idempotency-Key': idempotencyKey } },
    );
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}

export async function markAllNotificationsRead(localUserId: string, idempotencyKey: string): Promise<NotificationReadAllResult> {
  try {
    const response = await api.post<NotificationReadAllResult>(
      `${API_ROOT}/notification-readings`,
      undefined,
      { headers: { ...headers(localUserId), 'Idempotency-Key': idempotencyKey } },
    );
    return response.data;
  } catch (error) {
    return throwRequestError(error);
  }
}
