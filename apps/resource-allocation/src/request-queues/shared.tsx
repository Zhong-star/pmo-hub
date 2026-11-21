import { useEffect, useState, type ReactNode } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { RequestQueueCode, RequestQueueFilters, RequestQueueItem, RequestQueueCollection, QueueSelections } from '../requestQueueApi';
import { getQueueSelections, getRequestQueue, REQUEST_QUEUES_QUERY_ROOT, RequestQueueRequestError } from '../requestQueueApi';
import { RequestDecisionApiError } from '../requestDecisionApi';
import { invalidateRequestSurfaces } from '../requestSurfaces';
import { businessDate, formatBusinessTimestamp } from '../timeAndHours';
import { requestResponsibleLabel } from '../revalidation';

export type QueueFilterValues = Omit<RequestQueueFilters, 'decisionState'>;

export interface QueueVerticalProps {
  localUserId: string;
  personId: string;
  role: import('../accessApi').ResourceAllocationRole;
  selectedRequestId: string | null;
  onAccessDenied: () => void;
}

export function readRequestValue(item: RequestQueueItem, key: keyof RequestQueueItem['requestedConditions']): string {
  const value = item.requestedConditions[key];
  return typeof value === 'string' ? value : '';
}

export function optionLabel(item: { id: string; name?: string; code?: string }): string {
  return item.code ? `${item.code} — ${item.name ?? ''}` : item.name ?? item.id;
}

export function isQueueAccessDenied(error: unknown): boolean {
  return (error instanceof RequestQueueRequestError || error instanceof RequestDecisionApiError)
    && (error.status === 401 || error.status === 403);
}

export function useRequestQueueQuery(
  localUserId: string,
  queue: RequestQueueCode,
  filters: RequestQueueFilters,
) {
  return useInfiniteQuery<RequestQueueCollection, Error, import('@tanstack/react-query').InfiniteData<RequestQueueCollection, string | null>, readonly unknown[], string | null>({
    queryKey: [...REQUEST_QUEUES_QUERY_ROOT, localUserId, queue, filters],
    queryFn: ({ pageParam }) => getRequestQueue(localUserId, queue, pageParam, filters),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: () => document.visibilityState === 'visible' ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useQueueSelections(
  localUserId: string,
  enabled: boolean,
  groupId: string | null,
  candidateRequestId: string | undefined,
  onAccessDenied: () => void,
) {
  const selections = useQuery<QueueSelections>({
    queryKey: [...REQUEST_QUEUES_QUERY_ROOT, localUserId, 'reference-selections', groupId, candidateRequestId],
    queryFn: () => getQueueSelections(localUserId, candidateRequestId),
    enabled,
    retry: false,
  });

  useEffect(() => {
    if (isQueueAccessDenied(selections.error)) onAccessDenied();
  }, [onAccessDenied, selections.error]);

  return selections;
}

export type RequestQueueQuery = ReturnType<typeof useRequestQueueQuery>;

export function useQueueAccessGuard(query: RequestQueueQuery, onAccessDenied: () => void) {
  useEffect(() => {
    if (isQueueAccessDenied(query.error)) onAccessDenied();
  }, [onAccessDenied, query.error]);
}

export function useQueueDeepLink(query: RequestQueueQuery, selectedRequestId: string | null) {
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const focusedItem = selectedRequestId ? items.find((item) => item.id === selectedRequestId) : undefined;

  useEffect(() => {
    if (!selectedRequestId || !query.isSuccess || focusedItem || query.isFetchingNextPage || query.isFetchNextPageError) return;
    if (query.hasNextPage) void query.fetchNextPage();
  }, [focusedItem, query, selectedRequestId]);

  useEffect(() => {
    if (!focusedItem || !selectedRequestId) return;
    const element = document.getElementById(`resource-request-${selectedRequestId}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element?.focus();
  }, [focusedItem, selectedRequestId]);

  const missing = Boolean(
    selectedRequestId && query.isSuccess && !focusedItem && !query.isFetchingNextPage
    && !query.hasNextPage && !query.isFetchNextPageError,
  );

  return { items, missing };
}

const pendingActionKeys = new Map<string, Promise<string>>();

async function getActionIdempotencyKey(identity: string): Promise<string> {
  const pending = pendingActionKeys.get(identity);
  if (pending) return pending;

  const keyPromise = (async () => {
    let slot = identity;
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
      slot = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      // Keep retries stable for this page session if Web Crypto is unavailable.
    }

    const storageKey = `pmo-hub.resource-allocation.request-action.${slot}`;
    try {
      const existing = window.sessionStorage.getItem(storageKey);
      if (existing) return existing;
    } catch {
      // Some embedded browsers disable storage; use the in-memory cache below.
    }

    const idempotencyKey = crypto.randomUUID();
    try {
      window.sessionStorage.setItem(storageKey, idempotencyKey);
    } catch {
      // The in-memory promise cache still keeps retries in this page stable.
    }
    return idempotencyKey;
  })();

  pendingActionKeys.set(identity, keyPromise);
  return keyPromise;
}

function actionIdentity(localUserId: string, item: RequestQueueItem, operation: string, payload: Record<string, unknown>) {
  const canonicalPayload = Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify([localUserId, item.id, item.version, operation, canonicalPayload]);
}

export function useQueueActionRunner(localUserId: string, onAccessDenied: () => void) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);

  async function performAction(
    item: RequestQueueItem,
    operation: string,
    payload: Record<string, unknown>,
    action: (idempotencyKey: string) => Promise<unknown>,
  ): Promise<boolean> {
    setActionError(null);
    setPendingRequestId(item.id);
    try {
      const identity = actionIdentity(localUserId, item, operation, payload);
      await action(await getActionIdempotencyKey(identity));
      await invalidateRequestSurfaces(queryClient, { includeAllocations: true });
      return true;
    } catch (error) {
      if (isQueueAccessDenied(error)) onAccessDenied();
      if ((error instanceof RequestQueueRequestError || error instanceof RequestDecisionApiError) && error.status === 412) {
        setActionError('This request changed after you opened it. Your entries are preserved; review the current details before trying again.');
        void invalidateRequestSurfaces(queryClient, { includeAllocations: true });
      } else if (!isQueueAccessDenied(error)) {
        setActionError(error instanceof Error ? error.message : 'The request could not be updated. Try again.');
      }
      return false;
    } finally {
      setPendingRequestId(null);
    }
  }

  return { actionError, setActionError, pendingRequestId, performAction };
}

export function RequestQueueCard({
  item,
  queueLabel,
  highlighted,
  children,
}: {
  item: RequestQueueItem;
  queueLabel: string;
  highlighted: boolean;
  children: ReactNode;
}) {
  const conditions = item.requestedConditions;
  const responsible = requestResponsibleLabel(item.nextResponsible);
  const requestedStartDatePassed = Boolean(conditions.startDate && conditions.startDate < businessDate());

  return (
    <article id={`resource-request-${item.id}`} tabIndex={-1} className={`request-queue-card${highlighted ? ' request-queue-card-highlighted' : ''}`} aria-labelledby={`request-title-${item.id}`}>
      <div className="request-queue-card-heading">
        <div>
          <p className="eyebrow">{queueLabel}</p>
          <h3 id={`request-title-${item.id}`}>{conditions.initiativeCode ?? 'ITDM'} — {conditions.initiativeName ?? 'Resource request'}</h3>
          <p className="request-queue-requester">Requested by {item.requester.displayName ?? 'Unknown requester'}</p>
        </div>
        <span className="status-badge">{item.decisionState.replaceAll('_', ' ')}</span>
      </div>

      <dl className="request-queue-details">
        <div><dt>Group</dt><dd>{conditions.groupName ?? 'Group unavailable'}</dd></div>
        <div><dt>Resource profile</dt><dd>{conditions.resourceProfileName ?? 'Profile unavailable'}</dd></div>
        <div><dt>Period</dt><dd>{conditions.startDate ?? '—'} to {conditions.endDate ?? '—'}</dd></div>
        <div><dt>Weekly hours</dt><dd>{conditions.weeklyHours ?? '—'}</dd></div>
        <div><dt>Next responsible</dt><dd>{responsible || 'No active group leaders'}</dd></div>
        <div><dt>Received</dt><dd>{formatBusinessTimestamp(item.receivedAt)}</dd></div>
        {item.dueAt && <div><dt>Presentation deadline</dt><dd>{formatBusinessTimestamp(item.dueAt)}</dd></div>}
      </dl>

      {item.impediments?.includes('PRESENTATION_DEADLINE_PASSED') && (
        <p className="form-error request-queue-impediment" role="status">The 21-day presentation deadline has passed. Automatic removal is pending, so actions are unavailable.</p>
      )}
      {requestedStartDatePassed && item.availableActions.includes('APPROVE') && (
        <p className="request-queue-guidance" role="status">
          The requested start date has already passed. Open Approve request to propose a valid future period starting on or after the 72-hour acceptance deadline with an explanation.
        </p>
      )}
      {conditions.comment && <p className="request-queue-comment">{conditions.comment}</p>}
      {children}
    </article>
  );
}

export function RequestQueueFilterPanel({
  filters,
  selections,
  disabled,
  label,
  onChange,
}: {
  filters: QueueFilterValues;
  selections: QueueSelections | undefined;
  disabled: boolean;
  label: string;
  onChange: (filters: QueueFilterValues) => void;
}) {
  return (
    <div className="request-exception-filters" role="group" aria-label={label}>
      <label className="form-field">
        <span>Group</span>
        <select value={filters.groupId ?? ''} onChange={(event) => onChange({ ...filters, groupId: event.target.value || undefined })} disabled={disabled}>
          <option value="">All groups</option>
          {selections?.groups.map((group) => <option key={group.id} value={group.id}>{optionLabel(group)}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>ITDM</span>
        <select value={filters.initiativeId ?? ''} onChange={(event) => onChange({ ...filters, initiativeId: event.target.value || undefined })} disabled={disabled}>
          <option value="">All ITDMs</option>
          {selections?.initiatives.map((initiative) => <option key={initiative.id} value={initiative.id}>{optionLabel(initiative)}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>Resource profile</span>
        <select value={filters.resourceProfileId ?? ''} onChange={(event) => onChange({ ...filters, resourceProfileId: event.target.value || undefined })} disabled={disabled}>
          <option value="">All profiles</option>
          {selections?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{optionLabel(profile)}</option>)}
        </select>
      </label>
    </div>
  );
}

export function RequestQueueResults({
  query,
  items,
  label,
  selectedRequestId,
  deepLinkMissing,
  actionError,
  renderItem,
  children,
}: {
  query: RequestQueueQuery;
  items: RequestQueueItem[];
  label: string;
  selectedRequestId: string | null;
  deepLinkMissing: boolean;
  actionError: string | null;
  renderItem: (item: RequestQueueItem) => ReactNode;
  children?: ReactNode;
}) {
  const topLevelError = query.isError && !query.isFetchNextPageError;

  return (
    <div role="tabpanel" aria-label={label} className="request-queue-content">
      <button type="button" className="secondary-button" onClick={() => void query.refetch()} disabled={query.isFetching}>
        {query.isFetching ? 'Refreshing…' : 'Refresh queue'}
      </button>
      {children}
      {query.isPending && <p role="status" className="supporting-copy">Loading requests…</p>}
      {topLevelError && (
        <div className="form-error" role="alert">
          <p>{isQueueAccessDenied(query.error) ? 'Your permission to view this queue changed. Protected request data has been cleared.' : 'The queue could not be refreshed. Loaded requests remain visible, but actions are paused until you refresh.'}</p>
          <button type="button" className="secondary-button" onClick={() => void query.refetch()} disabled={query.isFetching}>Try again</button>
        </div>
      )}
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      {deepLinkMissing && selectedRequestId && <p className="form-error" role="status">This request is not available in the current queue or your access has changed.</p>}
      {!query.isError && items.length === 0 && !query.isPending && <p className="empty-state">There are no requests in this queue.</p>}
      {items.length > 0 && <div className="request-queue-list" aria-live="polite">{items.map(renderItem)}</div>}
      <div className="request-queue-load-more">
        {query.isFetchNextPageError && <p className="form-error" role="alert">More requests could not be loaded. Requests already shown remain available.</p>}
        {query.hasNextPage && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetching || (query.isError && !query.isFetchNextPageError)}
          >
            {query.isFetchingNextPage ? 'Loading more…' : 'Load more requests'}
          </button>
        )}
      </div>
    </div>
  );
}
