import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  ChevronDownIcon,
  PlusIcon,
  SlidersIcon,
  XIcon,
} from '../../../shared-ui/src/Icons';
import { REQUESTS_QUERY_ROOT, getRequestCollection, type RequestDecisionState, type RequestFilters, type RequestScope, type ResourceRequestCollection } from '../requestApi';
import type { ResourceAllocationRole } from '../accessApi';
import { useRequestSelectionQuery, rowsFromPages, hasAccessError } from './shared';

const decisionStates: Array<{ value: RequestDecisionState; label: string }> = [
  { value: 'WAITING_FOR_PRESENTATION', label: 'Waiting for presentation' },
  { value: 'PENDING_TEAM_DECISION', label: 'Pending team decision' },
  { value: 'APPROVED_WITH_CHANGES', label: 'Approved with changes' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'DENIED', label: 'Denied' },
  { value: 'PRE_N3', label: 'Pre N3' },
  { value: 'ESCALATION', label: 'Escalation' },
  { value: 'REQUIRES_REVALIDATION', label: 'Requires revalidation' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

function decisionStatusBadgeClass(state: RequestDecisionState): string {
  if (state === 'APPROVED') return 'status-badge status-badge-active';
  if (state === 'DENIED') return 'status-badge status-badge-failed';
  if (state === 'PRE_N3' || state === 'ESCALATION' || state === 'REQUIRES_REVALIDATION') return 'status-badge status-badge-processing';
  if (state === 'WAITING_FOR_PRESENTATION' || state === 'PENDING_TEAM_DECISION' || state === 'APPROVED_WITH_CHANGES') return 'status-badge status-badge-info';
  return 'status-badge';
}

interface RequestCollectionProps {
  localUserId: string;
  role: ResourceAllocationRole;
  selectedRequestId: string | null;
  notice: string;
  newRequestButtonRef: RefObject<HTMLButtonElement | null>;
  onOpenNewRequest: () => void;
  onOpenRequest: (item: ResourceRequestCollection['items'][number]) => void;
  onClearSelection: () => void;
  onAccessDenied: () => void;
  onRefreshStateChange: (failed: boolean) => void;
}

export function RequestCollection({
  localUserId,
  role,
  selectedRequestId,
  notice,
  newRequestButtonRef,
  onOpenNewRequest,
  onOpenRequest,
  onClearSelection,
  onAccessDenied,
  onRefreshStateChange,
}: RequestCollectionProps) {
  const [filters, setFilters] = useState<RequestFilters>({});
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [requestScope, setRequestScope] = useState<RequestScope>('mine');
  const canSwitchRequestScope = role !== 'ALLOCATION_USER';
  const effectiveRequestScope = canSwitchRequestScope ? requestScope : 'mine';
  const requestsQuery = useInfiniteQuery({
    queryKey: [...REQUESTS_QUERY_ROOT, localUserId, effectiveRequestScope, filters],
    queryFn: ({ pageParam }) => getRequestCollection(localUserId, filters, pageParam, effectiveRequestScope),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const requests = useMemo(() => rowsFromPages<ResourceRequestCollection['items'][number]>(requestsQuery.data), [requestsQuery.data]);
  const groupsQuery = useRequestSelectionQuery(localUserId, 'groups');
  const profilesQuery = useRequestSelectionQuery(localUserId, 'resource-profiles');
  const initiativesQuery = useRequestSelectionQuery(localUserId, 'initiatives');
  const groups = useMemo(() => rowsFromPages(groupsQuery.data), [groupsQuery.data]);
  const profiles = useMemo(() => rowsFromPages(profilesQuery.data), [profilesQuery.data]);
  const initiatives = useMemo(() => rowsFromPages(initiativesQuery.data), [initiativesQuery.data]);
  const scopeTitle = effectiveRequestScope === 'visible'
    ? role === 'ALLOCATION_ADMIN' ? 'All requests' : 'Requests in my scope'
    : 'My requests';
  const refreshFailed = requestsQuery.isError && !requestsQuery.isFetchNextPageError;
  const activeFilterCount = [
    filters.initiativeId,
    filters.decisionState,
    filters.groupId,
    filters.resourceProfileId,
  ].filter(Boolean).length;

  useEffect(() => {
    onRefreshStateChange(refreshFailed);
  }, [onRefreshStateChange, refreshFailed]);

  useEffect(() => {
    const accessLost = hasAccessError(requestsQuery.error)
      || hasAccessError(groupsQuery.error)
      || hasAccessError(profilesQuery.error)
      || hasAccessError(initiativesQuery.error);
    if (accessLost) onAccessDenied();
  }, [groupsQuery.error, initiativesQuery.error, onAccessDenied, profilesQuery.error, requestsQuery.error]);

  function setFilter(name: keyof RequestFilters, value: string) {
    setFilters((current) => ({ ...current, [name]: value || undefined }));
  }

  return (
    <div className="request-panel">
      <div className="request-panel-heading">
        <div>
          <h2 id="my-requests-title">{scopeTitle}</h2>
          <p>{effectiveRequestScope === 'visible'
            ? 'Consult operational requests in the groups currently visible to your role. Other requesters’ records are read-only.'
            : 'Review your requests, update a request that is waiting for presentation, or withdraw it with a reason.'}</p>
        </div>

        <div className="request-panel-heading__actions">
          {canSwitchRequestScope && (
            <label className="form-field request-scope-control">
              <span>Request view</span>
              <select aria-label="Request view" value={requestScope} onChange={(event) => {
                setRequestScope(event.target.value as RequestScope);
                onClearSelection();
              }}>
                <option value="mine">My requests</option>
                <option value="visible">{role === 'ALLOCATION_ADMIN' ? 'All requests' : 'Requests in my scope'}</option>
              </select>
            </label>
          )}
          <button
            ref={newRequestButtonRef}
            type="button"
            className="primary-button ui-inline-btn request-new-button"
            onClick={onOpenNewRequest}
          >
            <PlusIcon size={15} />
            <span>New request</span>
          </button>
        </div>
      </div>

      {notice && <p className="inline-success" role="status">{notice}</p>}

      <div className="collection-surface">
        <div className="collection-toolbar">
          <div className="collection-toolbar__bar">
            <span className="collection-toolbar__title">
              <SlidersIcon size={15} />
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="collection-filter-badge" aria-label={`${activeFilterCount} active filters`}>
                  {activeFilterCount}
                </span>
              )}
            </span>
            <div className="collection-toolbar__actions">
              {activeFilterCount > 0 && (
                <button type="button" className="collection-toolbar__clear" onClick={() => setFilters({})}>
                  <XIcon size={13} />
                  <span>Clear filters</span>
                </button>
              )}
              <button
                type="button"
                className="collection-toolbar__toggle"
                aria-expanded={filtersOpen}
                aria-controls="request-filter-controls"
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <span>{filtersOpen ? 'Hide filters' : 'Show filters'}</span>
                <ChevronDownIcon size={14} />
              </button>
            </div>
          </div>

          <div
            id="request-filter-controls"
            className="request-filters collection-toolbar__controls"
            aria-label="Filter requests"
            hidden={!filtersOpen}
          >
            <label className="collection-filter-field">
              <span>ITDM</span>
              <select value={filters.initiativeId ?? ''} onChange={(event) => setFilter('initiativeId', event.target.value)}>
                <option value="">All ITDMs</option>
                {initiatives.map((initiative) => <option key={initiative.id} value={initiative.id}>{initiative.code} · {initiative.name}</option>)}
              </select>
            </label>
            <label className="collection-filter-field">
              <span>Decision</span>
              <select value={filters.decisionState ?? ''} onChange={(event) => setFilter('decisionState', event.target.value)}>
                <option value="">All decisions</option>
                {decisionStates.map((state) => <option key={state.value} value={state.value}>{state.label}</option>)}
              </select>
            </label>
            <label className="collection-filter-field">
              <span>Group</span>
              <select value={filters.groupId ?? ''} onChange={(event) => setFilter('groupId', event.target.value)}>
                <option value="">All groups</option>
                {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </label>
            <label className="collection-filter-field">
              <span>Resource profile</span>
              <select value={filters.resourceProfileId ?? ''} onChange={(event) => setFilter('resourceProfileId', event.target.value)}>
                <option value="">All profiles</option>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </label>
          </div>
        </div>

        {requestsQuery.isPending && <p className="collection-surface__body-note" role="status">Loading {effectiveRequestScope === 'mine' ? 'your' : 'visible'} requests…</p>}
        {refreshFailed && (
          <div className="form-error collection-surface__error" role="alert">
            <p>The request list could not be refreshed. Loaded requests and form values are still available; actions that need the current version are paused.</p>
            <button type="button" className="secondary-button" onClick={() => void requestsQuery.refetch()} disabled={requestsQuery.isFetching}>Try again</button>
          </div>
        )}
        {!requestsQuery.isPending && requests.length === 0 && !requestsQuery.isError && (
          <p className="collection-surface__empty">No operational requests match these filters.</p>
        )}
        {requests.length > 0 && (
          <>
            <div className="collection-list-header request-list-header" aria-hidden="true">
              <span>Initiative</span>
              <span>Group &amp; profile</span>
              <span>Period</span>
              <span>Decision</span>
            </div>
            <div className="request-list request-list--flush" aria-label={scopeTitle}>
              {requests.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`request-list-item${selectedRequestId === item.id ? ' request-list-item-selected' : ''}`}
                  aria-pressed={selectedRequestId === item.id}
                  onClick={() => onOpenRequest(item)}
                >
                  <span className="request-list-heading"><strong>{item.requestedConditions.initiativeCode} · {item.requestedConditions.initiativeName}</strong><small>{item.id}</small></span>
                  <span>{item.requestedConditions.groupName} · {item.requestedConditions.resourceProfileName}</span>
                  <span className="tabular-cell">{item.requestedConditions.startDate} to {item.requestedConditions.endDate}</span>
                  <span className={decisionStatusBadgeClass(item.decisionState)}>{decisionStates.find((state) => state.value === item.decisionState)?.label ?? item.decisionState}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {requestsQuery.hasNextPage && (
        <button
          type="button"
          className="secondary-button request-load-more"
          onClick={() => void requestsQuery.fetchNextPage()}
          disabled={requestsQuery.isFetching || (requestsQuery.isError && !requestsQuery.isFetchNextPageError)}
        >
          {requestsQuery.isFetchingNextPage ? 'Loading…' : 'Load more requests'}
        </button>
      )}
      {requestsQuery.isFetchNextPageError && (
        <div className="form-error request-load-more-error" role="alert">
          <p>More requests could not be loaded. Previously loaded requests remain available.</p>
          <button
            type="button"
            className="text-button"
            onClick={() => void requestsQuery.fetchNextPage()}
            disabled={requestsQuery.isFetching || (requestsQuery.isError && !requestsQuery.isFetchNextPageError)}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
