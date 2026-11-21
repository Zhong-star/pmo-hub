import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import type { ResourceAllocationRole } from './accessApi';
import { getQueueSelections, getRequestQueue, correctRequestReferences, referRequest, removeRequestAdministratively, REQUEST_QUEUES_QUERY_ROOT, RequestQueueRequestError, type RequestQueueCode, type RequestQueueItem, type QueueSelections } from './requestQueueApi';
import { SUBMISSIONS_QUERY_ROOT, type SelectionItem } from './submissionApi';

interface RequestQueuesProps {
  localUserId: string;
  role: ResourceAllocationRole;
  groupId: string | null;
  onAccessDenied: () => void;
}

interface ReferenceCorrectionValues {
  initiativeId: string;
  groupId: string;
  resourceProfileId: string;
  reason: string;
}

interface RemovalValues {
  reason: string;
}

const queueLabels: Record<RequestQueueCode, string> = {
  presentation: 'Presentation queue',
  'team-decision': 'Group decision queue',
};

function queuesFor(role: ResourceAllocationRole, groupId: string | null): RequestQueueCode[] {
  if (role === 'ALLOCATION_ADMIN') return groupId ? ['presentation', 'team-decision'] : ['presentation'];
  if (role === 'ALLOCATION_MODERATOR' || role === 'ALLOCATION_SUPERVISOR' || role === 'ALLOCATION_MANAGER') {
    return ['team-decision'];
  }
  return [];
}

function initialQueue(queues: RequestQueueCode[]): RequestQueueCode {
  const requested = new URLSearchParams(window.location.search).get('queue');
  if (requested && queues.includes(requested as RequestQueueCode)) return requested as RequestQueueCode;
  return queues[0] ?? 'team-decision';
}

function updateQueueLocation(queue: RequestQueueCode) {
  const params = new URLSearchParams(window.location.search);
  params.set('queue', queue);
  params.delete('requestId');
  const search = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(value));
}

function readValue(item: RequestQueueItem, key: keyof RequestQueueItem['requestedConditions']): string {
  const value = item.requestedConditions[key];
  return typeof value === 'string' ? value : '';
}

function optionLabel(item: SelectionItem): string {
  return item.code ? `${item.code} — ${item.name ?? ''}` : item.name ?? item.id;
}

function accessDenied(error: unknown): boolean {
  return error instanceof RequestQueueRequestError && (error.status === 401 || error.status === 403);
}

const pendingActionKeys = new Map<string, Promise<string>>();

function getActionIdempotencyKey(identity: string): Promise<string> {
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

function actionIdentity(
  localUserId: string,
  requestId: string,
  version: number,
  operation: string,
  payload: Record<string, string | undefined>,
): string {
  const canonicalPayload = Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify([localUserId, requestId, version, operation, canonicalPayload]);
}

export function RequestQueues({ localUserId, role, groupId, onAccessDenied }: RequestQueuesProps) {
  const queues = useMemo(() => queuesFor(role, groupId), [role, groupId]);
  const [selectedQueue, setSelectedQueue] = useState<RequestQueueCode>(() => initialQueue(queues));
  const activeQueue = queues.includes(selectedQueue) ? selectedQueue : initialQueue(queues);
  const [openCorrectionId, setOpenCorrectionId] = useState<string | null>(null);
  const [openRemovalId, setOpenRemovalId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const locationQuery = new URLSearchParams(window.location.search);
  const selectedRequestId = locationQuery.has('queue') ? locationQuery.get('requestId') : null;

  const queueQuery = useInfiniteQuery({
    queryKey: [...REQUEST_QUEUES_QUERY_ROOT, localUserId, activeQueue],
    queryFn: ({ pageParam }) => getRequestQueue(localUserId, activeQueue, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    enabled: queues.includes(activeQueue),
    refetchInterval: () => document.visibilityState === 'visible' ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const selectionsQuery = useQuery<QueueSelections>({
    queryKey: [...REQUEST_QUEUES_QUERY_ROOT, localUserId, 'reference-selections'],
    queryFn: () => getQueueSelections(localUserId),
    enabled: role === 'ALLOCATION_ADMIN' && openCorrectionId !== null,
    retry: false,
  });

  const items = queueQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const focusedItem = selectedRequestId ? items.find((item) => item.id === selectedRequestId) : undefined;
  const {
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
    isSuccess,
  } = queueQuery;
  const deepLinkMissing = Boolean(
    selectedRequestId && queueQuery.isSuccess && !focusedItem && !queueQuery.isFetchingNextPage &&
    !queueQuery.hasNextPage && !queueQuery.isFetchNextPageError,
  );

  useEffect(() => {
    if (queueQuery.error && accessDenied(queueQuery.error)) onAccessDenied();
  }, [onAccessDenied, queueQuery.error]);

  useEffect(() => {
    if (selectionsQuery.error && accessDenied(selectionsQuery.error)) onAccessDenied();
  }, [onAccessDenied, selectionsQuery.error]);

  useEffect(() => {
    if (!selectedRequestId || !isSuccess || focusedItem || isFetchingNextPage || isFetchNextPageError) return;
    if (hasNextPage) {
      void fetchNextPage();
    }
  }, [fetchNextPage, focusedItem, hasNextPage, isFetchNextPageError, isFetchingNextPage, isSuccess, selectedRequestId]);

  useEffect(() => {
    if (!focusedItem || !selectedRequestId) return;
    const element = document.getElementById(`resource-request-${selectedRequestId}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element?.focus();
  }, [focusedItem, selectedRequestId]);

  async function invalidateRequestSurfaces() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: REQUEST_QUEUES_QUERY_ROOT }),
      queryClient.invalidateQueries({ queryKey: ['resource-allocation-requests'] }),
      queryClient.invalidateQueries({ queryKey: SUBMISSIONS_QUERY_ROOT }),
    ]);
  }

  async function requestActionKey(
    userId: string,
    requestId: string,
    version: number,
    operation: string,
    payload: Record<string, string | undefined>,
  ) {
    const identity = actionIdentity(userId, requestId, version, operation, payload);
    return getActionIdempotencyKey(identity);
  }

  async function performAction(requestId: string, action: () => Promise<unknown>) {
    setActionError(null);
    setPendingRequestId(requestId);
    try {
      await action();
      await invalidateRequestSurfaces();
      setOpenCorrectionId(null);
      setOpenRemovalId(null);
    } catch (error) {
      if (accessDenied(error)) onAccessDenied();
      if (error instanceof RequestQueueRequestError && error.status === 412) {
        setActionError('This request changed after you opened it. Review the current details before trying again.');
        void invalidateRequestSurfaces();
      } else if (!accessDenied(error)) {
        setActionError(error instanceof Error ? error.message : 'The request could not be updated. Try again.');
      }
    } finally {
      setPendingRequestId(null);
    }
  }

  if (queues.length === 0) return null;

  const requestedQueue = new URLSearchParams(window.location.search).get('queue');
  const linkQueue = requestedQueue && queues.includes(requestedQueue as RequestQueueCode)
    ? requestedQueue as RequestQueueCode
    : queues[0];
  const visibleItems = activeQueue === linkQueue ? items : [];

  return (
    <section className="request-queues-panel" aria-labelledby="request-queues-title">
      <header className="request-queues-heading">
        <div>
          <p className="eyebrow">Request work</p>
          <h2 id="request-queues-title">Request queues</h2>
          <p className="supporting-copy">Requests are shown only when your current role and group scope allow you to act on them.</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void queueQuery.refetch()} disabled={queueQuery.isFetching}>
          {queueQuery.isFetching ? 'Refreshing…' : 'Refresh queue'}
        </button>
      </header>

      <div className="request-queue-tabs" role="tablist" aria-label="Request queues">
        {queues.map((queue) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeQueue === queue}
            key={queue}
            onClick={() => {
              setActionError(null);
              setSelectedQueue(queue);
              updateQueueLocation(queue);
            }}
          >
            {queueLabels[queue]}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={queueLabels[activeQueue]} className="request-queue-content">
        {queueQuery.isPending && <p role="status" className="supporting-copy">Loading requests…</p>}

        {queueQuery.isError && !queueQuery.isFetchNextPageError && (
          <div className="form-error" role="alert">
            <p>{accessDenied(queueQuery.error) ? 'Your permission to view this queue changed. Protected request data has been cleared.' : 'The queue could not be refreshed. Loaded requests remain visible, but actions are paused until you refresh.'}</p>
            <button type="button" className="secondary-button" onClick={() => void queueQuery.refetch()} disabled={queueQuery.isFetching}>Try again</button>
          </div>
        )}

        {actionError && <p className="form-error" role="alert">{actionError}</p>}
        {deepLinkMissing && selectedRequestId && <p className="form-error" role="status">This request is not available in the current queue or your access has changed.</p>}

        {!queueQuery.isError && visibleItems.length === 0 && !queueQuery.isPending && (
          <p className="empty-state">There are no requests in this queue.</p>
        )}

        {visibleItems.length > 0 && (
          <div className="request-queue-list" aria-live="polite">
            {visibleItems.map((item) => (
              <RequestQueueCard
                key={item.id}
                item={item}
                queue={activeQueue}
                localUserId={localUserId}
                role={role}
                selections={selectionsQuery.data}
                selectionsLoading={selectionsQuery.isPending}
                selectionsError={selectionsQuery.error}
                actionsBlocked={queueQuery.isError && !queueQuery.isFetchNextPageError}
                openCorrection={openCorrectionId === item.id}
                openRemoval={openRemovalId === item.id}
                busy={pendingRequestId === item.id}
                highlighted={item.id === selectedRequestId}
                onCorrectionToggle={() => setOpenCorrectionId(openCorrectionId === item.id ? null : item.id)}
                onRemovalToggle={() => setOpenRemovalId(openRemovalId === item.id ? null : item.id)}
                onRefer={() => void performAction(item.id, async () => referRequest(
                  localUserId,
                  item.id,
                  item.version,
                  await requestActionKey(localUserId, item.id, item.version, 'referral', {}),
                ))}
                onCorrect={(correction) => performAction(item.id, async () => correctRequestReferences(
                  localUserId,
                  item.id,
                  item.version,
                  await requestActionKey(localUserId, item.id, item.version, 'reference-correction', correction),
                  correction,
                ))}
                onRemove={(reason) => {
                  if (!window.confirm('Remove this request from the active queue? The request history and audit will be retained.')) return Promise.resolve();
                  return performAction(item.id, async () => removeRequestAdministratively(
                    localUserId,
                    item.id,
                    item.version,
                    await requestActionKey(localUserId, item.id, item.version, 'administrative-removal', { reason }),
                    reason,
                  ));
                }}
              />
            ))}
          </div>
        )}

        <div className="request-queue-load-more">
          {queueQuery.isFetchNextPageError && <p className="form-error" role="alert">More requests could not be loaded. Requests already shown remain available.</p>}
          {queueQuery.hasNextPage && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void queueQuery.fetchNextPage()}
              disabled={queueQuery.isFetching || (queueQuery.isError && !queueQuery.isFetchNextPageError)}
            >
              {queueQuery.isFetchingNextPage ? 'Loading more…' : 'Load more requests'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

interface RequestQueueCardProps {
  item: RequestQueueItem;
  queue: RequestQueueCode;
  localUserId: string;
  role: ResourceAllocationRole;
  selections?: QueueSelections;
  selectionsLoading: boolean;
  selectionsError: unknown;
  actionsBlocked: boolean;
  openCorrection: boolean;
  openRemoval: boolean;
  busy: boolean;
  highlighted: boolean;
  onCorrectionToggle: () => void;
  onRemovalToggle: () => void;
  onRefer: () => void;
  onCorrect: (input: { initiativeId?: string; groupId?: string; resourceProfileId?: string; reason: string }) => Promise<void>;
  onRemove: (reason: string) => Promise<void>;
}

function RequestQueueCard({
  item,
  queue,
  role,
  selections,
  selectionsLoading,
  selectionsError,
  actionsBlocked,
  openCorrection,
  openRemoval,
  busy,
  highlighted,
  onCorrectionToggle,
  onRemovalToggle,
  onRefer,
  onCorrect,
  onRemove,
}: RequestQueueCardProps) {
  const responsible = Array.isArray(item.nextResponsible)
    ? item.nextResponsible.map((person) => `${person.displayName} (${person.role.replace('ALLOCATION_', '')})`).join(', ')
    : item.nextResponsible.role === 'ALLOCATION_ADMIN' ? 'Tech Resource Allocation Admin' : 'Assigned group';
  const conditions = item.requestedConditions;
  const actionDisabled = busy || actionsBlocked;

  return (
    <article id={`resource-request-${item.id}`} tabIndex={-1} className={`request-queue-card${highlighted ? ' request-queue-card-highlighted' : ''}`} aria-labelledby={`request-title-${item.id}`}>
      <div className="request-queue-card-heading">
        <div>
          <p className="eyebrow">{queue === 'presentation' ? 'Waiting for presentation' : 'Waiting for group decision'}</p>
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
        <div><dt>Received</dt><dd>{dateLabel(item.receivedAt)}</dd></div>
        {item.dueAt && <div><dt>Presentation deadline</dt><dd>{dateLabel(item.dueAt)}</dd></div>}
      </dl>

      {item.impediments?.includes('PRESENTATION_DEADLINE_PASSED') && (
        <p className="form-error request-queue-impediment" role="status">The 21-day presentation deadline has passed. Automatic removal is pending, so actions are unavailable.</p>
      )}
      {conditions.comment && <p className="request-queue-comment">{conditions.comment}</p>}

      {item.availableActions.includes('REFER') && (
        <div className="request-queue-actions">
          <button type="button" className="primary-button" onClick={onRefer} disabled={actionDisabled}>
            {busy ? 'Updating request…' : 'Refer to group decision'}
          </button>
          {role === 'ALLOCATION_ADMIN' && item.availableActions.includes('REFERENCE_CORRECTION') && (
            <button type="button" className="secondary-button" aria-expanded={openCorrection} onClick={onCorrectionToggle} disabled={actionDisabled}>
              Correct references
            </button>
          )}
          {role === 'ALLOCATION_ADMIN' && item.availableActions.includes('ADMINISTRATIVE_REMOVE') && (
            <button type="button" className="secondary-button" aria-expanded={openRemoval} onClick={onRemovalToggle} disabled={actionDisabled}>
              Remove request
            </button>
          )}
        </div>
      )}

      {openCorrection && selections && <ReferenceCorrectionForm item={item} selections={selections} disabled={actionDisabled} onSubmit={onCorrect} />}
      {openCorrection && selectionsLoading && <p className="supporting-copy" role="status">Loading active reference choices…</p>}
      {openCorrection && selectionsError != null && <p className="form-error" role="alert">Reference choices could not be loaded. Close this form and try again.</p>}
      {openRemoval && <AdministrativeRemovalForm disabled={actionDisabled} onSubmit={onRemove} />}
    </article>
  );
}

function ReferenceCorrectionForm({
  item,
  selections,
  disabled,
  onSubmit,
}: {
  item: RequestQueueItem;
  selections: QueueSelections;
  disabled: boolean;
  onSubmit: RequestQueueCardProps['onCorrect'];
}) {
  const { register, handleSubmit, control, formState: { errors } } = useForm<ReferenceCorrectionValues>({
    defaultValues: { initiativeId: '', groupId: '', resourceProfileId: '', reason: '' },
  });
  const selectedGroupId = useWatch({ control, name: 'groupId' });
  const currentGroupId = readValue(item, 'groupId');
  const effectiveGroupId = selectedGroupId || currentGroupId;
  const activeProfiles = selections.profiles.filter((profile) => profile.groupId === effectiveGroupId);

  return (
    <form className="request-queue-action-form" aria-label={`Correct references for request ${item.id}`} onSubmit={handleSubmit((values) => onSubmit({
      ...(values.initiativeId ? { initiativeId: values.initiativeId } : {}),
      ...(values.groupId ? { groupId: values.groupId } : {}),
      ...(values.resourceProfileId ? { resourceProfileId: values.resourceProfileId } : {}),
      reason: values.reason.trim(),
    }))}>
      <h4>Correct request references</h4>
      <p>Choose an active replacement when a reference needs correction. The presentation deadline stays unchanged.</p>
      <label className="form-field">
        <span>ITDM</span>
        <select {...register('initiativeId')} disabled={disabled}>
          <option value="">Keep current ITDM</option>
          {selections.initiatives.map((initiative) => <option key={initiative.id} value={initiative.id}>{optionLabel(initiative)}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>Group</span>
        <select {...register('groupId')} disabled={disabled}>
          <option value="">Keep current group</option>
          {selections.groups.map((group) => <option key={group.id} value={group.id}>{optionLabel(group)}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>Resource profile</span>
        <select {...register('resourceProfileId', {
          validate: (value) => Boolean(value || !selectedGroupId) || 'Choose a resource profile in the new group.',
        })} disabled={disabled}>
          <option value="">Keep current profile</option>
          {activeProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name ?? profile.id}</option>)}
        </select>
        {errors.resourceProfileId && <span className="field-error">{errors.resourceProfileId.message}</span>}
      </label>
      <label className="form-field request-queue-reason-field">
        <span>Reason</span>
        <textarea {...register('reason', { required: 'Provide a reason.', maxLength: { value: 2000, message: 'Use no more than 2,000 characters.' }, validate: (value) => Boolean(value.trim()) || 'Provide a reason.' })} maxLength={2000} disabled={disabled} />
        {errors.reason && <span className="field-error">{errors.reason.message}</span>}
      </label>
      <div className="form-actions">
        <button type="submit" className="primary-button" disabled={disabled}>Save reference correction</button>
      </div>
    </form>
  );
}

function AdministrativeRemovalForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: (reason: string) => Promise<void> }) {
  const { register, handleSubmit, formState: { errors } } = useForm<RemovalValues>({ defaultValues: { reason: '' } });
  return (
    <form className="request-queue-action-form" aria-label="Administrative request removal" onSubmit={handleSubmit((values) => onSubmit(values.reason.trim()))}>
      <h4>Remove request from the active queue</h4>
      <p>The requester will be notified. The request and its submission reference remain available in the audit.</p>
      <label className="form-field request-queue-reason-field">
        <span>Reason</span>
        <textarea {...register('reason', { required: 'Provide a reason.', maxLength: { value: 2000, message: 'Use no more than 2,000 characters.' }, validate: (value) => Boolean(value.trim()) || 'Provide a reason.' })} maxLength={2000} disabled={disabled} />
        {errors.reason && <span className="field-error">{errors.reason.message}</span>}
      </label>
      <div className="form-actions">
        <button type="submit" className="secondary-button" disabled={disabled}>Confirm removal</button>
      </div>
    </form>
  );
}
