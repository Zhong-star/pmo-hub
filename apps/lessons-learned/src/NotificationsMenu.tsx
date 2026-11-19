import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  getNotifications,
  markNotificationAsRead,
  markNotificationsReadBatch,
  type LessonNotificationEventType,
  type LessonNotificationItem,
  type LessonNotificationPage,
} from './api';

const utcDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function formatUtcTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${utcDateTimeFormatter.format(parsed)} UTC`;
}

function getEventTypeLabel(eventType: LessonNotificationEventType): string {
  switch (eventType) {
    case 'LESSON_RETURNED':
      return 'Lesson returned';
    case 'LESSON_APPROVED':
      return 'Lesson approved';
    case 'LESSON_REJECTED':
      return 'Lesson rejected';
    case 'COMMENT_ADDED':
      return 'New comment';
    case 'REPLY_ADDED':
      return 'New reply';
  }
}

export interface NotificationsMenuProps {
  profileId: string;
  navigationKey: string;
  onOpenLesson: (lessonId: number) => void;
}

export function NotificationsMenu({
  profileId,
  navigationKey,
  onOpenLesson,
}: NotificationsMenuProps) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingSingleIds, setPendingSingleIds] = useState<Set<number>>(() => new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousNavigationKeyRef = useRef(navigationKey);

  const queryKey = ['lessons-learned-notifications', profileId] as const;

  const notificationsQuery = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const response = await getNotifications(profileId, pageParam ? { cursor: pageParam } : {}, signal);
      return response ?? { items: [], page: { limit: 20, nextCursor: null }, unreadCount: 0 };
    },
    getNextPageParam: (lastPage) => lastPage?.page?.nextCursor ?? undefined,
    networkMode: 'always',
    retry: false,
  });

  const refetchNotifications = notificationsQuery.refetch;
  useEffect(() => {
    if (previousNavigationKeyRef.current !== navigationKey) {
      previousNavigationKeyRef.current = navigationKey;
      void refetchNotifications();
    }
  }, [navigationKey, refetchNotifications]);

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

  const pages = notificationsQuery.data?.pages ?? [];
  const items: LessonNotificationItem[] = pages.flatMap((page) => page?.items ?? []);
  const unreadCount = pages[0]?.unreadCount ?? 0;
  const loadedUnreadIds = items.filter((item) => !item.isRead).map((item) => item.id);

  function updateCacheReadState(readIds: Set<number>, nextUnreadCount: number, readAtValue: string) {
    queryClient.setQueryData<InfiniteData<LessonNotificationPage>>(queryKey, (current) => {
      if (!current) return current;
      return {
        ...current,
        pages: current.pages.map((page, index) => ({
          ...page,
          unreadCount: index === 0 ? nextUnreadCount : page.unreadCount,
          items: page.items.map((item) =>
            readIds.has(item.id)
              ? { ...item, isRead: true, readAt: item.readAt ?? readAtValue }
              : item,
          ),
        })),
      };
    });
  }

  const singleReadMutation = useMutation({
    mutationFn: (notificationId: number) => markNotificationAsRead(profileId, notificationId),
    networkMode: 'always',
    onMutate: (notificationId) => {
      setActionError(null);
      setPendingSingleIds((current) => new Set(current).add(notificationId));
    },
    onSuccess: (result) => {
      updateCacheReadState(
        new Set([result.notification.id]),
        result.unreadCount,
        result.notification.readAt ?? new Date().toISOString(),
      );
    },
    onError: () => {
      setActionError('Could not mark the notification as read. Please try again.');
    },
    onSettled: (_data, _error, notificationId) => {
      setPendingSingleIds((current) => {
        const next = new Set(current);
        next.delete(notificationId);
        return next;
      });
    },
  });

  const batchReadMutation = useMutation({
    mutationFn: (notificationIds: number[]) =>
      markNotificationsReadBatch(profileId, { notificationIds }),
    networkMode: 'always',
    onMutate: () => {
      setActionError(null);
    },
    onSuccess: (result) => {
      updateCacheReadState(
        new Set(result.updatedIds),
        result.unreadCount,
        new Date().toISOString(),
      );
    },
    onError: () => {
      setActionError('Could not mark loaded notifications as read. Please try again.');
    },
  });

  function toggleMenu() {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    setActionError(null);
    if (nextOpen) {
      void refetchNotifications();
    }
  }

  function handleSelectNotification(notification: LessonNotificationItem) {
    setIsOpen(false);
    onOpenLesson(notification.lessonId);
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
        aria-expanded={isOpen}
        aria-controls="lessons-notifications-menu"
        onClick={toggleMenu}
      >
        <span>Notifications</span>
        {unreadCount > 0 && (
          <span className="notifications-menu__badge" aria-hidden="true">
            {unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          id="lessons-notifications-menu"
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
              disabled={loadedUnreadIds.length === 0 || batchReadMutation.isPending}
              onClick={() => batchReadMutation.mutate(loadedUnreadIds)}
            >
              {batchReadMutation.isPending ? 'Marking…' : 'Mark loaded as read'}
            </button>
          </div>

          {actionError && (
            <p className="notifications-menu__error" role="alert">
              {actionError}
            </p>
          )}

          {notificationsQuery.isPending && (
            <p className="notifications-menu__status" role="status">
              Loading notifications…
            </p>
          )}

          {notificationsQuery.isError && !notificationsQuery.isFetching && (
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

          {!notificationsQuery.isPending && !notificationsQuery.isError && items.length === 0 && (
            <p className="notifications-menu__empty">No notifications yet.</p>
          )}

          {items.length > 0 && (
            <ul className="notifications-menu__list">
              {items.map((item) => {
                const isSinglePending = pendingSingleIds.has(item.id);
                return (
                  <li
                    key={item.id}
                    className={
                      item.isRead
                        ? 'notifications-menu__item is-read'
                        : 'notifications-menu__item is-unread'
                    }
                  >
                    <div className="notifications-menu__item-meta">
                      <span className="notifications-menu__event-type">
                        {getEventTypeLabel(item.eventType)}
                      </span>
                      <span className="notifications-menu__read-state">
                        {item.isRead ? 'Read' : 'Unread'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="notifications-menu__open-button"
                      aria-label={`Open lesson #${item.lessonId}: ${item.lessonTitle}`}
                      onClick={() => handleSelectNotification(item)}
                    >
                      <span className="notifications-menu__lesson-ref">
                        #{item.lessonId} · {item.lessonTitle}
                      </span>
                      <span className="notifications-menu__summary">{item.summary}</span>
                    </button>
                    <div className="notifications-menu__item-footer">
                      <span className="notifications-menu__actor">
                        {item.actorDisplayName} · {formatUtcTimestamp(item.createdAt)}
                      </span>
                      {!item.isRead && (
                        <button
                          type="button"
                          className="notifications-menu__mark-read"
                          aria-label={`Mark notification for #${item.lessonId} as read`}
                          disabled={isSinglePending || batchReadMutation.isPending}
                          onClick={() => singleReadMutation.mutate(item.id)}
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

          {notificationsQuery.hasNextPage && (
            <div className="notifications-menu__footer">
              <button
                type="button"
                className="notifications-menu__load-more"
                disabled={notificationsQuery.isFetchingNextPage}
                onClick={() => void notificationsQuery.fetchNextPage()}
              >
                {notificationsQuery.isFetchingNextPage ? 'Loading more…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
