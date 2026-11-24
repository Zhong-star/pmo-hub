import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATIONS_QUERY_ROOT,
  NotificationRequestError,
  type NotificationReadFilter,
  type ResourceNotification,
} from './notificationsApi';
import { formatBusinessTimestamp } from './timeAndHours';

interface NotificationsInboxProps {
  localUserId: string;
  onAccessDenied: () => void;
}

function isAccessDenied(error: unknown): error is NotificationRequestError {
  return error instanceof NotificationRequestError && (error.status === 401 || error.status === 403);
}

function errorMessage(error: unknown) {
  if (error instanceof NotificationRequestError && error.status !== 401 && error.status !== 403) return error.message;
  return 'Notifications could not be updated. Try again.';
}

function readAttemptStorageKey(localUserId: string, scope: string) {
  return `pmo-hub.resource-allocation.notification-read:${localUserId}:${scope}`;
}

function getOrCreateReadAttempt(localUserId: string, scope: string) {
  const storageKey = readAttemptStorageKey(localUserId, scope);
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const created = window.crypto.randomUUID();
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return window.crypto.randomUUID();
  }
}

function clearReadAttempt(localUserId: string, scope: string) {
  try {
    window.sessionStorage.removeItem(readAttemptStorageKey(localUserId, scope));
  } catch {
    // The command can still complete when session storage is unavailable.
  }
}

export function NotificationsInbox({ localUserId, onAccessDenied }: NotificationsInboxProps) {
  const queryClient = useQueryClient();
  const [readFilter, setReadFilter] = useState<NotificationReadFilter>('all');
  const [actionError, setActionError] = useState<string | null>(null);
  const refreshInFlight = useRef(false);

  const notificationQuery = useInfiniteQuery({
    queryKey: [...NOTIFICATIONS_QUERY_ROOT, localUserId, readFilter],
    queryFn: ({ pageParam }) => getNotifications(localUserId, readFilter, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const { refetch: refetchNotifications } = notificationQuery;

  useEffect(() => {
    const refreshVisibleInbox = () => {
      if (document.visibilityState !== 'visible' || refreshInFlight.current) return;
      refreshInFlight.current = true;
      void refetchNotifications().finally(() => {
        refreshInFlight.current = false;
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshVisibleInbox();
    };
    const interval = window.setInterval(refreshVisibleInbox, 30_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refetchNotifications]);

  const invalidateInbox = () => queryClient.invalidateQueries({
    queryKey: [...NOTIFICATIONS_QUERY_ROOT, localUserId],
  });

  const markOne = useMutation({
    mutationFn: ({ notificationId, etag, idempotencyKey }: { notificationId: string; etag: string; idempotencyKey: string }) =>
      markNotificationRead(localUserId, notificationId, etag, idempotencyKey),
    onMutate: () => setActionError(null),
    onSuccess: (_notification, variables) => {
      clearReadAttempt(localUserId, variables.notificationId);
      void invalidateInbox();
    },
    onError: (error: unknown) => {
      if (isAccessDenied(error)) onAccessDenied();
      else {
        setActionError(errorMessage(error));
        void invalidateInbox();
      }
    },
  });

  const markAll = useMutation({
    mutationFn: ({ idempotencyKey }: { idempotencyKey: string }) => markAllNotificationsRead(localUserId, idempotencyKey),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      clearReadAttempt(localUserId, 'all');
      void invalidateInbox();
    },
    onError: (error: unknown) => {
      if (isAccessDenied(error)) onAccessDenied();
      else setActionError(errorMessage(error));
    },
  });

  const items = useMemo(() => notificationQuery.data?.pages.flatMap((page) => page.items) ?? [], [notificationQuery.data]);
  const unreadCount = items.filter((item) => item.readAt === null).length;

  useEffect(() => {
    if (notificationQuery.isError && isAccessDenied(notificationQuery.error)) onAccessDenied();
  }, [notificationQuery.error, notificationQuery.isError, onAccessDenied]);

  return (
    <section className="notification-panel" aria-labelledby="notifications-heading">
      <div className="notification-heading">
        <div>
          <p className="eyebrow">Your inbox</p>
          <h2 id="notifications-heading">Notifications</h2>
          <p className="notification-intro">Updates stay here until you mark them as read.</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => markAll.mutate({ idempotencyKey: getOrCreateReadAttempt(localUserId, 'all') })}
          disabled={markAll.isPending || markOne.isPending || readFilter === 'read'}
        >
          {markAll.isPending ? 'Marking all as read…' : 'Mark all as read'}
        </button>
      </div>

      <div className="notification-toolbar">
        <label className="notification-filter" htmlFor="notification-read-filter">
          <span>Show</span>
          <select
            id="notification-read-filter"
            value={readFilter}
            onChange={(event) => setReadFilter(event.target.value as NotificationReadFilter)}
          >
            <option value="all">All notifications</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
        </label>
        <span className="notification-count" aria-live="polite">
          {unreadCount} unread on this page
        </span>
      </div>

      {actionError && <p className="notification-action-error" role="alert">{actionError}</p>}

      {notificationQuery.isPending && <p className="notification-loading" role="status">Loading notifications…</p>}
      {notificationQuery.isError && !notificationQuery.data && (
        <div className="notification-error" role="alert">
          <p>{errorMessage(notificationQuery.error)}</p>
          <button type="button" className="secondary-button" onClick={() => void notificationQuery.refetch()} disabled={notificationQuery.isFetching}>
            {notificationQuery.isFetching ? 'Retrying…' : 'Try again'}
          </button>
        </div>
      )}
      {notificationQuery.isError && notificationQuery.data && !notificationQuery.isFetchNextPageError && (
        <div className="notification-stale" role="alert">
          <p>Updates could not be checked. Your current inbox stays visible until you retry.</p>
          <button
            type="button"
            className="text-button"
            onClick={() => void notificationQuery.refetch()}
            disabled={notificationQuery.isFetching}
          >
            {notificationQuery.isFetching ? 'Retrying…' : 'Retry refresh'}
          </button>
        </div>
      )}

      {notificationQuery.data && items.length === 0 && (
        <p className="notification-empty">No notifications match this filter.</p>
      )}

      {items.length > 0 && (
        <ul className="notification-list" aria-label="Your notifications">
          {items.map((notification) => (
            <NotificationCard
              key={notification.id}
              notification={notification}
              isUpdating={markOne.isPending || markAll.isPending}
              onMarkRead={() => markOne.mutate({
                notificationId: notification.id,
                etag: notification.etag,
                idempotencyKey: getOrCreateReadAttempt(localUserId, notification.id),
              })}
            />
          ))}
        </ul>
      )}

      {notificationQuery.hasNextPage && (
        <div className="notification-load-more">
          {notificationQuery.isFetchNextPageError && (
            <p className="notification-stale" role="alert">More notifications could not be loaded. The notices already shown remain available.</p>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={() => void notificationQuery.fetchNextPage()}
            disabled={notificationQuery.isFetching || notificationQuery.isError && !notificationQuery.isFetchNextPageError}
          >
            {notificationQuery.isFetchingNextPage ? 'Loading more…' : 'Load more'}
          </button>
          {notificationQuery.isFetchNextPageError && (
            <button
              type="button"
              className="text-button"
              onClick={() => void notificationQuery.fetchNextPage()}
              disabled={notificationQuery.isFetching || (notificationQuery.isError && !notificationQuery.isFetchNextPageError)}
            >
              Retry loading more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function NotificationCard({
  notification,
  isUpdating,
  onMarkRead,
}: {
  notification: ResourceNotification;
  isUpdating: boolean;
  onMarkRead: () => void;
}) {
  return (
    <li className={`notification-card${notification.readAt === null ? ' notification-card-unread' : ''}`}>
      <div className="notification-card-main">
        <div className="notification-card-title-row">
          <h3>{notification.title}</h3>
          <span className={`notification-status${notification.readAt === null ? ' notification-status-unread' : ''}`}>
            {notification.readAt === null ? 'Unread' : 'Read'}
          </span>
        </div>
        <p className="notification-message">{notification.message}</p>
        <p className="notification-date">{formatBusinessTimestamp(notification.createdAt)}</p>
        {notification.target.available && notification.target.destination ? (
          <a className="notification-target-link" href={notificationTargetHref(notification)}>
            {notification.target.destination === 'ALLOCATION_DETAIL' ? 'Open related allocation' : 'Open related request'}
          </a>
        ) : (
          <p className={`notification-target${notification.target.available ? '' : ' notification-target-unavailable'}`}>
            {notification.target.available
              ? 'Request details are not available in this view.'
              : 'This request is no longer available to you.'}
          </p>
        )}
      </div>
      {notification.readAt === null ? (
        <button type="button" className="text-button notification-read-button" onClick={onMarkRead} disabled={isUpdating}>
          Mark as read
        </button>
      ) : (
        <span className="notification-read-time">Read {formatBusinessTimestamp(notification.readAt)}</span>
      )}
    </li>
  );
}

function notificationTargetHref(notification: ResourceNotification): string {
  const { destination, requestId, allocationId } = notification.target;
  if (destination === 'ALLOCATION_DETAIL' && allocationId) {
    return `/resource-allocation/?${new URLSearchParams({ page: 'allocations', allocationId })}`;
  }
  if (!requestId) return '/resource-allocation/?page=allocations';
  if (destination === 'REQUEST_DETAIL') {
    return `/resource-allocation/?${new URLSearchParams({ page: 'requests', requestId })}`;
  }
  const queue = destination === 'PRESENTATION_QUEUE'
    ? 'presentation'
    : destination === 'TEAM_DECISION_QUEUE'
      ? 'team-decision'
      : null;
  return queue
    ? `/resource-allocation/?${new URLSearchParams({ page: 'request-queues', queue, requestId })}`
    : '/resource-allocation/?page=requests';
}
