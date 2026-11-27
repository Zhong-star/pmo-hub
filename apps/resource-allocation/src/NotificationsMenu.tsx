import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BellIcon } from '../../shared-ui/src/Icons';
import '../../shared-ui/src/NotificationsMenu.css';
import { enumLabel } from './labels';
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATIONS_QUERY_ROOT,
  NotificationRequestError,
  type ResourceNotification,
} from './notificationsApi';
import { formatBusinessTimestamp } from './timeAndHours';

export interface NotificationsMenuProps {
  localUserId: string;
  navigationKey: string;
  onAccessDenied: () => void;
}

function isAccessDenied(error: unknown): error is NotificationRequestError {
  return error instanceof NotificationRequestError && (error.status === 401 || error.status === 403);
}

function errorMessage(error: unknown): string {
  if (error instanceof NotificationRequestError && error.status !== 401 && error.status !== 403) return error.message;
  return 'Notifications could not be updated. Try again.';
}

function formatEventLabel(eventCode: string): string {
  return enumLabel(eventCode.replace(/_\d+$/, ''));
}

function readAttemptStorageKey(localUserId: string, scope: string): string {
  return `pmo-hub.resource-allocation.notification-read:${localUserId}:${scope}`;
}

function getOrCreateReadAttempt(localUserId: string, scope: string): string {
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

function clearReadAttempt(localUserId: string, scope: string): void {
  try {
    window.sessionStorage.removeItem(readAttemptStorageKey(localUserId, scope));
  } catch {
    // The command can still complete when session storage is unavailable.
  }
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

export function NotificationsMenu({
  localUserId,
  navigationKey,
  onAccessDenied,
}: NotificationsMenuProps) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingSingleIds, setPendingSingleIds] = useState<Set<string>>(() => new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const readInFlight = useRef(false);
  const refreshInFlight = useRef(false);
  const previousNavigationKeyRef = useRef(navigationKey);

  const notificationQuery = useInfiniteQuery({
    queryKey: [...NOTIFICATIONS_QUERY_ROOT, localUserId, 'all'],
    queryFn: ({ pageParam }) => getNotifications(localUserId, 'all', pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
    networkMode: 'always',
    retry: false,
  });
  const { refetch: refetchNotifications } = notificationQuery;

  useEffect(() => {
    if (previousNavigationKeyRef.current !== navigationKey) {
      previousNavigationKeyRef.current = navigationKey;
      void refetchNotifications();
    }
  }, [navigationKey, refetchNotifications]);

  useEffect(() => {
    const refreshVisibleNotifications = () => {
      if (document.visibilityState !== 'visible' || refreshInFlight.current) return;
      refreshInFlight.current = true;
      void refetchNotifications().finally(() => {
        refreshInFlight.current = false;
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshVisibleNotifications();
    };
    const interval = window.setInterval(refreshVisibleNotifications, 30_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refetchNotifications]);

  useEffect(() => {
    if (!isOpen) return;
    function handleOutsidePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsidePointerDown);
    return () => document.removeEventListener('mousedown', handleOutsidePointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (notificationQuery.isError && isAccessDenied(notificationQuery.error)) {
      onAccessDenied();
    }
  }, [notificationQuery.error, notificationQuery.isError, onAccessDenied]);

  const invalidateInbox = () => queryClient.invalidateQueries({
    queryKey: [...NOTIFICATIONS_QUERY_ROOT, localUserId],
  });

  const markOne = useMutation({
    mutationFn: ({ notificationId, etag, idempotencyKey }: { notificationId: string; etag: string; idempotencyKey: string }) =>
      markNotificationRead(localUserId, notificationId, etag, idempotencyKey),
    networkMode: 'always',
    onMutate: ({ notificationId }) => {
      setActionError(null);
      setPendingSingleIds((current) => new Set(current).add(notificationId));
    },
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
    onSettled: (_data, _error, variables) => {
      readInFlight.current = false;
      setPendingSingleIds((current) => {
        const next = new Set(current);
        next.delete(variables.notificationId);
        return next;
      });
    },
  });

  const markAll = useMutation({
    mutationFn: ({ idempotencyKey }: { idempotencyKey: string }) => markAllNotificationsRead(localUserId, idempotencyKey),
    networkMode: 'always',
    onMutate: () => setActionError(null),
    onSuccess: () => {
      clearReadAttempt(localUserId, 'all');
      void invalidateInbox();
    },
    onError: (error: unknown) => {
      if (isAccessDenied(error)) onAccessDenied();
      else setActionError(errorMessage(error));
    },
    onSettled: () => {
      readInFlight.current = false;
    },
  });

  const items = useMemo(
    () => notificationQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [notificationQuery.data],
  );
  const unreadCount = items.filter((item) => item.readAt === null).length;
  const isMarkingRead = markOne.isPending || markAll.isPending;

  function handleMarkOne(notification: ResourceNotification) {
    if (readInFlight.current) return;
    readInFlight.current = true;
    markOne.mutate({
      notificationId: notification.id,
      etag: notification.etag,
      idempotencyKey: getOrCreateReadAttempt(localUserId, notification.id),
    });
  }

  function handleMarkAll() {
    if (readInFlight.current) return;
    readInFlight.current = true;
    markAll.mutate({ idempotencyKey: getOrCreateReadAttempt(localUserId, 'all') });
  }

  function toggleMenu() {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    setActionError(null);
    if (nextOpen) {
      void refetchNotifications();
    }
  }

  const triggerLabel = unreadCount > 0
    ? `Notifications (${unreadCount} unread)`
    : 'Notifications';

  return (
    <div
      ref={containerRef}
      className="notifications-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isOpen) {
          event.preventDefault();
          setIsOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="notifications-menu__trigger"
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-expanded={isOpen}
        aria-controls="resource-allocation-notifications-menu"
        onClick={toggleMenu}
      >
        <BellIcon size={18} />
        {unreadCount > 0 && (
          <span className="notifications-menu__badge" aria-hidden="true">
            {unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          id="resource-allocation-notifications-menu"
          className="notifications-menu__panel"
          role="region"
          aria-label="Notifications"
        >
          <div className="notifications-menu__header">
            <div>
              <h2 className="notifications-menu__title">Notifications</h2>
              <p className="notifications-menu__subtitle">
                {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
              </p>
            </div>
            <button
              type="button"
              className="notifications-menu__batch-button"
              disabled={isMarkingRead || (unreadCount === 0 && !notificationQuery.hasNextPage)}
              onClick={handleMarkAll}
            >
              {markAll.isPending ? 'Marking…' : 'Mark all as read'}
            </button>
          </div>

          {actionError && (
            <p className="notifications-menu__error" role="alert">
              {actionError}
            </p>
          )}

          {notificationQuery.isPending && (
            <p className="notifications-menu__status" role="status">
              Loading notifications…
            </p>
          )}

          {notificationQuery.isError && !notificationQuery.data && !notificationQuery.isFetching && !notificationQuery.isFetchNextPageError && (
            <div className="notifications-menu__error" role="alert">
              <p>Notifications could not be loaded.</p>
              <button
                type="button"
                className="notifications-menu__retry"
                onClick={() => void refetchNotifications()}
              >
                Retry
              </button>
            </div>
          )}

          {notificationQuery.isError && notificationQuery.data && !notificationQuery.isFetchNextPageError && (
            <div className="notifications-menu__error" role="alert">
              <p>Updates could not be checked. Your current notifications stay visible until you retry.</p>
              <button
                type="button"
                className="notifications-menu__retry"
                onClick={() => void refetchNotifications()}
                disabled={notificationQuery.isFetching}
              >
                {notificationQuery.isFetching ? 'Retrying…' : 'Retry refresh'}
              </button>
            </div>
          )}

          {!notificationQuery.isPending && !notificationQuery.isError && items.length === 0 && (
            <p className="notifications-menu__empty">No notifications yet.</p>
          )}

          {items.length > 0 && (
            <ul className="notifications-menu__list" aria-label="Your notifications">
              {items.map((notification) => {
                const isRead = notification.readAt !== null;
                const isSinglePending = pendingSingleIds.has(notification.id);
                const hasAvailableTarget = notification.target.available && notification.target.destination;
                return (
                  <li
                    key={notification.id}
                    className={
                      isRead
                        ? 'notifications-menu__item is-read'
                        : 'notifications-menu__item is-unread'
                    }
                  >
                    <div className="notifications-menu__item-meta">
                      <span className="notifications-menu__event-type">
                        {formatEventLabel(notification.eventCode)}
                      </span>
                      <span className="notifications-menu__read-state">
                        {isRead ? 'Read' : 'Unread'}
                      </span>
                    </div>

                    {hasAvailableTarget ? (
                      <a
                        className="notifications-menu__open-button"
                        href={notificationTargetHref(notification)}
                        aria-label={`${notification.target.destination === 'ALLOCATION_DETAIL' ? 'Open related allocation' : 'Open related request'}: ${notification.title}`}
                        onClick={(event) => {
                          if (!event.defaultPrevented) {
                            setIsOpen(false);
                          }
                        }}
                      >
                        <span className="notifications-menu__lesson-ref">{notification.title}</span>
                        <span className="notifications-menu__summary">{notification.message}</span>
                      </a>
                    ) : (
                      <div className="notifications-menu__open-static">
                        <span className="notifications-menu__lesson-ref">{notification.title}</span>
                        <span className="notifications-menu__summary">{notification.message}</span>
                        <span className="notifications-menu__unavailable">
                          {notification.target.available
                            ? 'Request details are not available in this view.'
                            : 'This request is no longer available to you.'}
                        </span>
                      </div>
                    )}

                    <div className="notifications-menu__item-footer">
                      <span className="notifications-menu__actor">
                        {formatBusinessTimestamp(notification.createdAt)}
                      </span>
                      {!isRead && (
                        <button
                          type="button"
                          className="notifications-menu__mark-read"
                          aria-label={`Mark "${notification.title}" as read`}
                          disabled={isMarkingRead}
                          onClick={() => handleMarkOne(notification)}
                        >
                          {isSinglePending ? 'Marking…' : 'Mark as read'}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {notificationQuery.hasNextPage && (
            <div className="notifications-menu__footer">
              {notificationQuery.isFetchNextPageError && (
                <p className="notifications-menu__error" role="alert">
                  More notifications could not be loaded.
                </p>
              )}
              <button
                type="button"
                className="notifications-menu__load-more"
                disabled={notificationQuery.isFetching || (notificationQuery.isError && !notificationQuery.isFetchNextPageError)}
                onClick={() => void notificationQuery.fetchNextPage()}
              >
                {notificationQuery.isFetchingNextPage ? 'Loading more…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
