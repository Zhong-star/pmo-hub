import { api, throwApiRequestError, ResourceAllocationApiError } from './apiClient';
import type { ApiProblem, ApiQuery, ApiResponse } from './apiContracts';

export const NOTIFICATIONS_QUERY_ROOT = ['resource-allocation-notifications'] as const;
const API_ROOT = '/api/resource-allocation/v1';

export type NotificationReadFilter = 'all' | 'read' | 'unread';

export type ResourceNotification = ApiResponse<'/api/resource-allocation/v1/notifications', 'get'>['items'][number];
export type ResourceNotificationCollection = ApiResponse<'/api/resource-allocation/v1/notifications', 'get'>;
export type NotificationReadAllResult = ApiResponse<'/api/resource-allocation/v1/notification-readings', 'post'>;
type NotificationQuery = ApiQuery<'/api/resource-allocation/v1/notifications', 'get'>;

export class NotificationRequestError extends ResourceAllocationApiError {
  constructor(status: number | null, problem: ApiProblem | null) {
    super(status, problem, status === null ? 'The notification service could not be reached.' : `The notification request failed with status ${status}.`, 'NotificationRequestError');
  }
}

function throwRequestError(error: unknown): never {
  return throwApiRequestError(error, NotificationRequestError);
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
      } satisfies NotificationQuery,
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
