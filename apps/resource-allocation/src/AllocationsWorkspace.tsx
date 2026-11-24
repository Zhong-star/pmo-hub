import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigationFormProtection } from './NavigationProtection';
import { NOTIFICATIONS_QUERY_ROOT } from './notificationsApi';
import { REQUESTS_QUERY_ROOT } from './requestApi';
import { businessDate, formatBusinessTimestamp, formatCalendarDate } from './timeAndHours';
import {
  ALLOCATIONS_QUERY_ROOT,
  AllocationRequestError,
  changeAllocationState,
  getAllocation,
  getAllocationHistory,
  getAllocationLoad,
  getAllocations,
  isAllocationAction,
  type AllocationAction,
  type AllocationFilters,
  type AllocationRecord,
  type AllocationState,
} from './allocationApi';

interface AllocationsWorkspaceProps {
  localUserId: string;
  onAccessDenied: () => void;
}

interface AllocationFilterForm {
  initiativeId: string;
  personId: string;
  groupId: string;
  resourceProfileId: string;
  operationalState: AllocationState | '';
  periodStart: string;
  periodEnd: string;
}

interface AllocationActionForm {
  reason: string;
}

interface CommandAttempt {
  allocationId: string;
  action: AllocationAction;
  version: number;
  reason: string;
  idempotencyKey: string;
  correlationId: string;
}

const allocationStates: Array<{ value: AllocationState; label: string }> = [
  { value: 'NOT_STARTED', label: 'Not started' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'ALLOCATED_WITHOUT_ACTION', label: 'Allocated without action' },
  { value: 'DONE', label: 'Done' },
  { value: 'CANCELED', label: 'Canceled' },
];

const actionLabels: Record<AllocationAction, string> = {
  SUSPEND: 'Suspend',
  RESERVE: 'Reserve without action',
  RESUME: 'Resume',
  ACTIVATE: 'Activate',
  COMPLETE: 'Complete',
  CANCEL: 'Cancel',
};

const hoursByState: Array<{ state: AllocationState; label: string }> = [
  { state: 'NOT_STARTED', label: 'Not started' },
  { state: 'IN_PROGRESS', label: 'In progress' },
  { state: 'SUSPENDED', label: 'Suspended' },
  { state: 'ALLOCATED_WITHOUT_ACTION', label: 'Allocated without action' },
  { state: 'DONE', label: 'Done' },
  { state: 'CANCELED', label: 'Canceled' },
];

function emptyFilterForm(): AllocationFilterForm {
  return {
    initiativeId: '',
    personId: '',
    groupId: '',
    resourceProfileId: '',
    operationalState: '',
    periodStart: '',
    periodEnd: '',
  };
}

function formatDateRange(start: string, end: string): string {
  return `${formatCalendarDate(start)} – ${formatCalendarDate(end)}`;
}

function stateLabel(value: AllocationState): string {
  return allocationStates.find((state) => state.value === value)?.label ?? value;
}

function formatHours(value: number): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)} ${value === 1 ? 'hour' : 'hours'}/week`;
}

function filtersFromForm(values: AllocationFilterForm): AllocationFilters {
  return Object.fromEntries(Object.entries(values)
    .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])
    .filter(([, value]) => value !== '')) as AllocationFilters;
}

function rowsFromPages<T>(data: { pages: Array<{ items: T[] }> } | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

function accessDenied(error: unknown): boolean {
  return error instanceof AllocationRequestError && (error.status === 401 || error.status === 403);
}

function errorText(error: unknown): string {
  if (error instanceof AllocationRequestError && error.status === null) return 'The allocation change could not be confirmed.';
  return error instanceof AllocationRequestError ? error.message : 'The allocation could not be updated.';
}

function allocationTitle(allocation: AllocationRecord): string {
  return `${allocation.initiative.code} · ${allocation.initiative.name}`;
}

function createAttempt(
  allocation: AllocationRecord,
  action: AllocationAction,
  reason: string,
  etag: string | undefined,
): CommandAttempt | null {
  const match = etag?.match(/^"([1-9]\d*)"$/);
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version !== allocation.version) return null;
  return {
    allocationId: allocation.id,
    action,
    version,
    reason,
    idempotencyKey: window.crypto.randomUUID(),
    correlationId: window.crypto.randomUUID(),
  };
}

export function AllocationsWorkspace({ localUserId, onAccessDenied }: AllocationsWorkspaceProps) {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<AllocationFilters>({});
  const [loadDate, setLoadDate] = useState(() => businessDate());
  const [selectedAllocationId, setSelectedAllocationId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('allocationId'),
  );
  const [selectedAction, setSelectedAction] = useState<AllocationAction | null>(null);
  const [attempt, setAttempt] = useState<CommandAttempt | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [actionMessage, setActionMessage] = useState('');

  const filterForm = useForm<AllocationFilterForm>({ defaultValues: emptyFilterForm() });
  const actionForm = useForm<AllocationActionForm>({ defaultValues: { reason: '' }, mode: 'onSubmit', reValidateMode: 'onChange' });
  const { reset: resetActionForm } = actionForm;

  const filterKey = useMemo(() => JSON.stringify(filters), [filters]);
  const allocationQuery = useInfiniteQuery({
    queryKey: [...ALLOCATIONS_QUERY_ROOT, localUserId, filterKey],
    queryFn: ({ pageParam }) => getAllocations(localUserId, filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const allocations = rowsFromPages(allocationQuery.data);

  const loadQuery = useQuery({
    queryKey: [...ALLOCATIONS_QUERY_ROOT, localUserId, 'load', loadDate],
    queryFn: () => getAllocationLoad(localUserId, loadDate),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(loadDate),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const detailQuery = useQuery({
    queryKey: [...ALLOCATIONS_QUERY_ROOT, localUserId, selectedAllocationId],
    queryFn: () => getAllocation(localUserId, selectedAllocationId!),
    enabled: selectedAllocationId !== null,
    refetchInterval: selectedAllocationId ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const allocation = detailQuery.data?.allocation;
  const historyQuery = useQuery({
    queryKey: [...ALLOCATIONS_QUERY_ROOT, localUserId, selectedAllocationId, 'history'],
    queryFn: () => getAllocationHistory(localUserId, selectedAllocationId!),
    enabled: selectedAllocationId !== null,
    refetchInterval: selectedAllocationId ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const changeMutation = useMutation({
    mutationFn: (command: CommandAttempt) => changeAllocationState(
      localUserId,
      command.allocationId,
      command.action,
      command.version,
      command.reason,
      command.idempotencyKey,
      command.correlationId,
    ),
    onSuccess: async () => {
      setAttempt(null);
      setIsStale(false);
      setActionMessage('The allocation was updated.');
      setSelectedAction(null);
      actionForm.reset({ reason: '' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...ALLOCATIONS_QUERY_ROOT, localUserId] }),
        queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_ROOT }),
        queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_ROOT }),
      ]);
    },
    onError: (error) => {
      if (accessDenied(error)) {
        onAccessDenied();
        return;
      }
      setActionMessage('');
      setIsStale(error instanceof AllocationRequestError && error.status === 412);
    },
  });
  const guardActionClose = useNavigationFormProtection(
    'allocation action',
    actionForm.formState.isDirty,
    actionForm.formState.isSubmitting || changeMutation.isPending,
  );
  const { reset: resetChangeMutation } = changeMutation;
  const collectionRefreshFailed = allocationQuery.isError && !allocationQuery.isFetchNextPageError;
  const detailRefreshFailed = detailQuery.isError;
  const currentAllocationRefreshFailed = collectionRefreshFailed || detailRefreshFailed;
  const reasonField = actionForm.register('reason', {
    validate: (value) => value.trim().length > 0 || 'Enter a reason for this change.',
    maxLength: { value: 2000, message: 'Reason must be 2,000 characters or fewer.' },
  });

  useEffect(() => {
    if (detailQuery.error && accessDenied(detailQuery.error)) onAccessDenied();
    if (allocationQuery.error && accessDenied(allocationQuery.error)) onAccessDenied();
    if (loadQuery.error && accessDenied(loadQuery.error)) onAccessDenied();
    if (historyQuery.error && accessDenied(historyQuery.error)) onAccessDenied();
  }, [allocationQuery.error, detailQuery.error, historyQuery.error, loadQuery.error, onAccessDenied]);

  async function refreshAfterConflict() {
    const result = await detailQuery.refetch();
    if (result.isSuccess) {
      setAttempt(null);
      setIsStale(false);
      setActionMessage('Latest allocation details loaded. Review the current state and save your change again.');
      resetChangeMutation();
    }
  }

  function resetAllocationAction() {
    setSelectedAction(null);
    setAttempt(null);
    setIsStale(false);
    setActionMessage('');
    resetActionForm({ reason: '' });
    resetChangeMutation();
  }

  function startAction(action: AllocationAction) {
    if (currentAllocationRefreshFailed) return;
    guardActionClose(() => {
      resetAllocationAction();
      setSelectedAction(action);
    });
  }

  async function sendChange(command: CommandAttempt) {
    try {
      await changeMutation.mutateAsync(command);
    } catch {
      // The mutation callback exposes the error and preserves the attempt for retry.
    }
  }

  async function submitAction(values: AllocationActionForm) {
    if (!allocation || !selectedAction || !detailQuery.data || currentAllocationRefreshFailed) return;
    const command = attempt && attempt.allocationId === allocation.id && attempt.action === selectedAction && attempt.reason === values.reason.trim()
      ? attempt
      : createAttempt(allocation, selectedAction, values.reason.trim(), detailQuery.data.etag);
    if (!command) {
      setActionMessage('The latest allocation version is unavailable. Refresh the allocation before trying again.');
      return;
    }
    setAttempt(command);
    await sendChange(command);
  }

  function selectAllocation(nextId: string) {
    if (nextId === selectedAllocationId) return;
    guardActionClose(() => {
      resetAllocationAction();
      setSelectedAllocationId(nextId);
      const url = new URL(window.location.href);
      url.searchParams.set('page', 'allocations');
      url.searchParams.set('allocationId', nextId);
      window.history.replaceState(window.history.state, '', url);
    });
  }

  function closeDetails() {
    guardActionClose(() => {
      resetAllocationAction();
      setSelectedAllocationId(null);
      const url = new URL(window.location.href);
      url.searchParams.set('page', 'allocations');
      url.searchParams.delete('allocationId');
      window.history.replaceState(window.history.state, '', url);
    });
  }

  return (
    <section className="allocation-workspace" aria-labelledby="allocations-heading">
      <div className="allocation-workspace-heading">
        <div>
          <h2 id="allocations-heading">Allocations and capacity</h2>
          <p className="supporting-copy">Review commitments in your authorized scope, check weekly hours by state, and record an operational change.</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void allocationQuery.refetch()} disabled={allocationQuery.isFetching}>
          {allocationQuery.isFetching ? 'Refreshing…' : 'Refresh allocations'}
        </button>
      </div>

      <form className="allocation-filters" onSubmit={filterForm.handleSubmit((values) => setFilters(filtersFromForm(values)))}>
        <label>
          <span>Initiative ID</span>
          <input {...filterForm.register('initiativeId')} placeholder="Optional" />
        </label>
        <label>
          <span>Person ID</span>
          <input {...filterForm.register('personId')} placeholder="Optional" />
        </label>
        <label>
          <span>Group ID</span>
          <input {...filterForm.register('groupId')} placeholder="Optional" />
        </label>
        <label>
          <span>Resource profile ID</span>
          <input {...filterForm.register('resourceProfileId')} placeholder="Optional" />
        </label>
        <label>
          <span>Operational state</span>
          <select {...filterForm.register('operationalState')}>
            <option value="">All states</option>
            {allocationStates.map((state) => <option key={state.value} value={state.value}>{state.label}</option>)}
          </select>
        </label>
        <label>
          <span>Effective period from</span>
          <input type="date" {...filterForm.register('periodStart')} />
        </label>
        <label>
          <span>Effective period to</span>
          <input type="date" {...filterForm.register('periodEnd')} />
        </label>
        <div className="allocation-filter-actions">
          <button type="submit" className="primary-button">Filter</button>
          <button type="button" className="secondary-button" onClick={() => { filterForm.reset(emptyFilterForm()); setFilters({}); }}>Clear filters</button>
        </div>
      </form>

      <div className="allocation-capacity" aria-labelledby="allocation-capacity-heading">
        <div className="allocation-subheading">
          <div>
            <h3 id="allocation-capacity-heading">Weekly capacity by date</h3>
            <p>Weekly contracted hours for active allocations overlapping the selected São Paulo date.</p>
          </div>
          <label>
            <span>Capacity date</span>
            <input type="date" value={loadDate} onChange={(event) => setLoadDate(event.target.value)} />
          </label>
        </div>
        {loadQuery.isPending && <p className="allocation-loading" role="status">Loading capacity…</p>}
        {loadQuery.isError && !accessDenied(loadQuery.error) && (
          <div className="form-error" role="alert">
            <p>{errorText(loadQuery.error)}</p>
            <button type="button" className="text-button" onClick={() => void loadQuery.refetch()}>Try again</button>
          </div>
        )}
        {loadQuery.isSuccess && loadQuery.data.items.length === 0 && (
          <p className="allocation-empty">No active allocation hours were found for {formatCalendarDate(loadDate)}.</p>
        )}
        {loadQuery.isSuccess && loadQuery.data.items.length > 0 && (
          <div className="allocation-capacity-table-wrap">
            <table className="allocation-capacity-table">
              <caption className="sr-only">Weekly allocation hours by person and operational state on {formatCalendarDate(loadDate)}</caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  {hoursByState.map(({ state, label }) => <th scope="col" key={state}>{label}</th>)}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {loadQuery.data.items.map((item) => (
                  <tr key={item.person.personId}>
                    <th scope="row">{item.person.displayName}</th>
                    {hoursByState.map(({ state }) => (
                      <td key={state}>
                        {item.weeklyHoursByState[state]
                          ? formatHours(item.weeklyHoursByState[state] ?? 0)
                          : <><span className="capacity-empty" aria-hidden="true">—</span><span className="sr-only">{formatHours(0)}</span></>}
                      </td>
                    ))}
                    <td><strong>{formatHours(item.totalWeeklyHours)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="allocation-list-area" aria-labelledby="allocation-list-heading">
        <div className="allocation-subheading">
          <div>
            <h3 id="allocation-list-heading">Allocation list</h3>
            <p>The API applies your access scope and includes allocations that overlap either date limit.</p>
          </div>
          {allocations.length > 0 && <span className="allocation-count">{allocations.length} loaded</span>}
        </div>
        {allocationQuery.isPending && <p className="allocation-loading" role="status">Loading allocations…</p>}
        {allocationQuery.isError && !allocationQuery.isFetchNextPageError && !accessDenied(allocationQuery.error) && (
          <div className="form-error" role="alert">
            <p>{errorText(allocationQuery.error)}</p>
            <button type="button" className="text-button" onClick={() => void allocationQuery.refetch()} disabled={allocationQuery.isFetching}>Try again</button>
          </div>
        )}
        {allocationQuery.isSuccess && allocations.length === 0 && (
          <p className="allocation-empty">No allocations match these filters in your authorized scope.</p>
        )}
        {allocations.length > 0 && (
          <ul className="allocation-list">
            {allocations.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`allocation-list-item${selectedAllocationId === item.id ? ' allocation-list-item-selected' : ''}`}
                  aria-pressed={selectedAllocationId === item.id}
                  aria-label={`View allocation ${item.initiative.code}`}
                  onClick={() => selectAllocation(item.id)}
                >
                  <span className="allocation-list-main">
                    <strong>{allocationTitle(item)}</strong>
                    <small>{item.person.displayName} · {item.group.name} · {item.resourceProfile.name}</small>
                  </span>
                  <span className="allocation-list-period">{formatDateRange(item.startDate, item.endDate)}</span>
                  <span className={`allocation-state allocation-state-${item.state.toLowerCase().replaceAll('_', '-')}`}>{stateLabel(item.state)}</span>
                  <span>{formatHours(item.weeklyHours)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {allocationQuery.isFetchNextPageError && (
          <div className="form-error allocation-page-error" role="alert">
            <p>More allocations could not be loaded. The allocations already shown are still available.</p>
            <button
              type="button"
              className="text-button"
              onClick={() => void allocationQuery.fetchNextPage()}
              disabled={allocationQuery.isFetching || (allocationQuery.isError && !allocationQuery.isFetchNextPageError)}
            >
              Try loading more again
            </button>
          </div>
        )}
        {allocationQuery.hasNextPage && (
          <button
            type="button"
            className="secondary-button allocation-load-more"
            onClick={() => void allocationQuery.fetchNextPage()}
            disabled={allocationQuery.isFetching || (allocationQuery.isError && !allocationQuery.isFetchNextPageError)}
          >
            {allocationQuery.isFetchingNextPage ? 'Loading more…' : 'Load more allocations'}
          </button>
        )}
      </div>

      {selectedAllocationId && (
        <section className="allocation-detail" aria-label="Allocation details" aria-live="polite">
          {detailQuery.isPending && <p className="allocation-loading" role="status">Loading allocation details…</p>}
          {detailQuery.isError && !accessDenied(detailQuery.error) && (
            <div className="form-error" role="alert">
              <p>{errorText(detailQuery.error)}</p>
              <button type="button" className="text-button" onClick={() => void detailQuery.refetch()}>Reload details</button>
            </div>
          )}
          {allocation && (
            <>
              <div className="allocation-detail-heading">
                <div>
                  <p className="eyebrow">Allocation details</p>
                  <h3>{allocationTitle(allocation)}</h3>
                  <p>{allocation.person.displayName} · {allocation.group.name}</p>
                </div>
                <button type="button" className="text-button" onClick={closeDetails}>Close details</button>
              </div>
              <dl className="allocation-metadata">
                <div><dt>State</dt><dd>{stateLabel(allocation.state)}</dd></div>
                <div><dt>Resource profile</dt><dd>{allocation.resourceProfile.name}</dd></div>
                <div><dt>Effective period</dt><dd>{formatDateRange(allocation.startDate, allocation.endDate)}</dd></div>
                <div><dt>Approved period</dt><dd>{formatDateRange(allocation.approvedPeriod.startDate, allocation.approvedPeriod.endDate)}</dd></div>
                <div><dt>Weekly hours</dt><dd>{formatHours(allocation.weeklyHours)}</dd></div>
                <div><dt>Version</dt><dd>Version {allocation.version}</dd></div>
              </dl>

              {actionMessage && <p className="allocation-action-message" role="status">{actionMessage}</p>}
              {currentAllocationRefreshFailed && (
                <p className="allocation-action-message" role="status">Actions are paused until the current allocation refreshes successfully.</p>
              )}
              {allocation.availableActions.some(isAllocationAction) && (
                <div className="allocation-actions" aria-label="Available allocation actions">
                  <h4>Available actions</h4>
                  <div className="allocation-action-buttons">
                    {allocation.availableActions.filter(isAllocationAction).map((action) => (
                      <button key={action} type="button" className="secondary-button" onClick={() => startAction(action)} disabled={currentAllocationRefreshFailed}>
                        {actionLabels[action]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {selectedAction && (
                <form className="allocation-action-form" onSubmit={actionForm.handleSubmit(submitAction)}>
                  <h4>{actionLabels[selectedAction]} allocation</h4>
                  <p>Record a reason in the allocation history.</p>
                  <label className="allocation-reason-field">
                    <span>Reason</span>
                    <textarea
                      {...reasonField}
                      onChange={(event) => {
                        if (attempt && attempt.reason !== event.target.value.trim()) {
                          setAttempt(null);
                          setIsStale(false);
                          resetChangeMutation();
                        }
                        void reasonField.onChange(event);
                      }}
                      aria-invalid={Boolean(actionForm.formState.errors.reason)}
                      aria-describedby={actionForm.formState.errors.reason ? 'allocation-reason-error' : undefined}
                    />
                    {actionForm.formState.errors.reason && (
                      <span id="allocation-reason-error" className="field-error" role="alert">{actionForm.formState.errors.reason.message}</span>
                    )}
                  </label>
                  {changeMutation.isError && isStale && (
                    <div className="allocation-stale" role="alert">
                      <p>This allocation changed after you opened it. Your reason is saved. Refresh the current version before trying again.</p>
                      <button type="button" className="text-button" onClick={() => void refreshAfterConflict()} disabled={detailQuery.isFetching}>
                        {detailQuery.isFetching ? 'Refreshing…' : 'Refresh allocation'}
                      </button>
                    </div>
                  )}
                  {changeMutation.isError && !isStale && (
                    <div className="form-error" role="alert">
                      <p>{errorText(changeMutation.error)} Your reason is still available.</p>
                      {attempt && (
                        <button type="button" className="text-button" onClick={actionForm.handleSubmit(() => sendChange(attempt))} disabled={actionForm.formState.isSubmitting || currentAllocationRefreshFailed}>
                          Retry change
                        </button>
                      )}
                    </div>
                  )}
                  <div className="allocation-form-actions">
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={actionForm.formState.isSubmitting || isStale || currentAllocationRefreshFailed || !allocation.availableActions.includes(selectedAction)}
                    >
                      {actionForm.formState.isSubmitting ? 'Saving…' : 'Save change'}
                    </button>
                      <button type="button" className="secondary-button" onClick={() => guardActionClose(resetAllocationAction)}>
                      Close
                    </button>
                  </div>
                </form>
              )}

              <div className="allocation-history">
                <h4>History</h4>
                {historyQuery.isPending && <p className="allocation-loading" role="status">Loading history…</p>}
                {historyQuery.isError && !accessDenied(historyQuery.error) && <p className="allocation-history-note">History could not be loaded.</p>}
                {historyQuery.isSuccess && historyQuery.data.items.length === 0 && <p className="allocation-history-note">No manual changes have been recorded.</p>}
                {historyQuery.data?.items.length ? (
                  <ol className="allocation-history-list">
                    {historyQuery.data.items.map((event) => (
                      <li key={event.id}>
                        <strong>{event.action.replaceAll('_', ' ').toLowerCase()}</strong>
                        <span>{formatBusinessTimestamp(event.occurredAt)}</span>
                        {event.reason && <p>{event.reason}</p>}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            </>
          )}
        </section>
      )}
    </section>
  );
}
