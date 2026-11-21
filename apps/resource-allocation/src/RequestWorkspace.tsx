import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { getSelectionCollection, type RequestCategory, type SelectionItem, SubmissionRequestError } from './submissionApi';
import {
  acceptRequest,
  getRequest,
  getRequestAudit,
  getRequestCollection,
  RequestApiError,
  REQUESTS_QUERY_ROOT,
  updateRequest,
  withdrawRequest,
  type RequestDecisionState,
  type RequestFilters,
  type ResourceRequestItem,
} from './requestApi';
import { DeniedRequestResponse } from './DeniedRequestResponse';

interface RequestWorkspaceProps {
  localUserId: string;
  onAccessDenied: () => void;
}

interface RequestFormValues {
  initiativeId: string;
  category: RequestCategory;
  groupId: string;
  resourceProfileId: string;
  startDate: string;
  endDate: string;
  weeklyHours: string;
  comment: string;
}

interface WithdrawalFormValues { reason: string; }

const categoryOptions: Array<{ value: RequestCategory; label: string }> = [
  { value: 'DEMAND_ANALYSIS', label: 'Demand Analysis' },
  { value: 'POC_BBP', label: 'POC/BBP' },
  { value: 'EXECUTION_PROJECT', label: 'Execution — Project' },
  { value: 'EXECUTION_FAST_TRACK', label: 'Execution — Fast track' },
  { value: 'EXECUTION_ENHANCEMENT', label: 'Execution — Enhancement' },
];

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

function rowsFromPages<T>(data: { pages: Array<{ items: T[] }> } | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

function querySelectedRequestId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.has('queue') ? null : params.get('requestId');
}

function querySelectedAuditId(): string | null {
  return new URLSearchParams(window.location.search).get('auditId');
}

function updateRequestUrl(requestId: string | null) {
  const url = new URL(window.location.href);
  if (requestId) {
    url.searchParams.delete('queue');
    url.searchParams.set('requestId', requestId);
  }
  else url.searchParams.delete('requestId');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function updateAuditUrl(requestId: string | null) {
  const url = new URL(window.location.href);
  if (requestId) url.searchParams.set('auditId', requestId);
  else url.searchParams.delete('auditId');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function createUuid() {
  return window.crypto.randomUUID();
}

const pendingAcceptanceKeys = new Map<string, Promise<string>>();

async function acceptanceIdempotencyKey(localUserId: string, requestId: string, version: number): Promise<string> {
  const identity = JSON.stringify([localUserId, requestId, version, 'acceptance']);
  const pending = pendingAcceptanceKeys.get(identity);
  if (pending) return pending;

  const keyPromise = (async () => {
    let slot = identity;
    try {
      const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
      slot = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      // Keep retries stable for this page session if Web Crypto is unavailable.
    }

    const storageKey = `pmo-hub.resource-allocation.acceptance.${slot}`;
    try {
      const existing = window.sessionStorage.getItem(storageKey);
      if (existing) return existing;
    } catch {
      // Some embedded browsers disable storage; use the in-memory cache below.
    }

    const idempotencyKey = createUuid();
    try {
      window.sessionStorage.setItem(storageKey, idempotencyKey);
    } catch {
      // The in-memory promise cache still keeps retries stable for this page.
    }
    return idempotencyKey;
  })();

  pendingAcceptanceKeys.set(identity, keyPromise);
  return keyPromise;
}

function normalizeWeeklyHours(raw: string): { value: number | null; error?: string } {
  const value = raw.trim();
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(value);
  if (!match) return { value: null, error: 'Enter a positive number using a decimal point or comma.' };
  const whole = BigInt(match[1]);
  const fraction = match[2] ?? '';
  if (whole > 40n || (whole === 40n && /[1-9]/.test(fraction))) return { value: null, error: 'Weekly hours cannot exceed 40 hours.' };
  const tenths = Number(whole) * 10 + Number(fraction[0] ?? '0') + (Number(fraction[1] ?? '0') >= 5 ? 1 : 0);
  if (tenths === 0) return { value: null, error: 'Hours must round to at least 0.1 hours.' };
  return { value: tenths / 10 };
}

function formValues(item: ResourceRequestItem): RequestFormValues {
  return {
    initiativeId: item.requestedConditions.initiativeId,
    category: item.requestedConditions.category,
    groupId: item.requestedConditions.groupId,
    resourceProfileId: item.requestedConditions.resourceProfileId,
    startDate: item.requestedConditions.startDate,
    endDate: item.requestedConditions.endDate,
    weeklyHours: String(item.requestedConditions.weeklyHours),
    comment: item.requestedConditions.comment ?? '',
  };
}

function hasAccessError(error: unknown): boolean {
  return (error instanceof RequestApiError || error instanceof SubmissionRequestError)
    && (error.status === 401 || error.status === 403);
}

function issueMutationError(error: unknown): string {
  if (error instanceof RequestApiError) return error.message;
  return 'The request could not be saved. Your form values are still available.';
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(value));
}

function useSelectionQuery(localUserId: string, collection: 'groups' | 'resource-profiles' | 'initiatives') {
  return useInfiniteQuery({
    queryKey: ['resource-allocation-selections', localUserId, collection],
    queryFn: ({ pageParam }) => getSelectionCollection(collection, localUserId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function RequestWorkspace({ localUserId, onAccessDenied }: RequestWorkspaceProps) {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<RequestFilters>({});
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(() => querySelectedRequestId());
  const [auditRequestId, setAuditRequestId] = useState<string | null>(() => querySelectedAuditId());
  const [withdrawalOpen, setWithdrawalOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [formVersion, setFormVersion] = useState<number | null>(null);
  const [editError, setEditError] = useState('');
  const [withdrawalError, setWithdrawalError] = useState('');
  const [acceptError, setAcceptError] = useState('');
  const [withdrawalAttempt, setWithdrawalAttempt] = useState<{ requestId: string; version: number; reason: string; key: string } | null>(null);
  const lastFormRequestId = useRef<string | null>(null);
  const withdrawButtonRef = useRef<HTMLButtonElement>(null);
  const modalWasOpen = useRef(false);

  const editForm = useForm<RequestFormValues>({ defaultValues: { initiativeId: '', category: 'EXECUTION_PROJECT', groupId: '', resourceProfileId: '', startDate: '', endDate: '', weeklyHours: '', comment: '' }, mode: 'onSubmit', reValidateMode: 'onChange' });
  const withdrawalForm = useForm<WithdrawalFormValues>({ defaultValues: { reason: '' }, mode: 'onSubmit', reValidateMode: 'onChange' });
  const { handleSubmit: handleWithdrawalSubmit } = withdrawalForm;
  const values = useWatch({ control: editForm.control }) as RequestFormValues;
  const requestsQuery = useInfiniteQuery({
    queryKey: [...REQUESTS_QUERY_ROOT, localUserId, filters],
    queryFn: ({ pageParam }) => getRequestCollection(localUserId, filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const requests = useMemo(() => rowsFromPages<ResourceRequestItem>(requestsQuery.data), [requestsQuery.data]);
  const selectedRequest = useQuery({
    queryKey: [...REQUESTS_QUERY_ROOT, localUserId, 'detail', selectedRequestId],
    queryFn: () => getRequest(localUserId, selectedRequestId!),
    enabled: selectedRequestId !== null,
    refetchInterval: selectedRequestId ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const auditQuery = useQuery({
    queryKey: [...REQUESTS_QUERY_ROOT, localUserId, 'audit', auditRequestId],
    queryFn: () => getRequestAudit(localUserId, auditRequestId!),
    enabled: auditRequestId !== null,
    retry: false,
  });

  const groupsQuery = useSelectionQuery(localUserId, 'groups');
  const profilesQuery = useSelectionQuery(localUserId, 'resource-profiles');
  const initiativesQuery = useSelectionQuery(localUserId, 'initiatives');
  const groups = useMemo(() => rowsFromPages<SelectionItem>(groupsQuery.data), [groupsQuery.data]);
  const profiles = useMemo(() => rowsFromPages<SelectionItem>(profilesQuery.data), [profilesQuery.data]);
  const initiatives = useMemo(() => rowsFromPages<SelectionItem>(initiativesQuery.data), [initiativesQuery.data]);
  const selectedGroupId = values?.groupId ?? '';
  const groupProfiles = profiles.filter((profile) => profile.groupId === selectedGroupId);
  const isDetailNotFound = selectedRequest.error instanceof RequestApiError && selectedRequest.error.status === 404;
  const currentItem = isDetailNotFound ? undefined : selectedRequest.data;
  const formVersionChanged = currentItem !== undefined && formVersion !== null && currentItem.version !== formVersion;
  const canAcceptProposal = currentItem?.decisionState === 'APPROVED_WITH_CHANGES'
    && currentItem.availableActions?.includes('ACCEPT') === true
    && currentItem.dueAt !== null
    && currentItem.dueAt !== undefined;
  const acceptDisabled = !canAcceptProposal
    || formVersion === null
    || formVersionChanged
    || selectedRequest.isFetching
    || selectedRequest.isError
    || requestsQuery.isError;
  const canEdit = currentItem?.decisionState === 'WAITING_FOR_PRESENTATION'
    && !selectedRequest.isFetching
    && !selectedRequest.isError
    && !requestsQuery.isError
    && !formVersionChanged;

  const updateMutation = useMutation({
    mutationFn: (input: { requestId: string; version: number; patch: Parameters<typeof updateRequest>[3] }) =>
      updateRequest(localUserId, input.requestId, input.version, input.patch),
  });
  const withdrawMutation = useMutation({
    mutationFn: (input: { requestId: string; version: number; reason: string; idempotencyKey: string }) =>
      withdrawRequest(localUserId, input.requestId, input.version, input.reason, input.idempotencyKey),
  });
  const acceptMutation = useMutation({
    mutationFn: (input: { requestId: string; version: number; idempotencyKey: string }) =>
      acceptRequest(localUserId, input.requestId, input.version, input.idempotencyKey),
  });

  useEffect(() => {
    function onPopState() {
      setSelectedRequestId(querySelectedRequestId());
      setAuditRequestId(querySelectedAuditId());
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (modalWasOpen.current && !withdrawalOpen) withdrawButtonRef.current?.focus();
    modalWasOpen.current = withdrawalOpen;
  }, [withdrawalOpen]);

  useEffect(() => {
    const accessLost = hasAccessError(requestsQuery.error)
      || hasAccessError(selectedRequest.error)
      || hasAccessError(auditQuery.error)
      || hasAccessError(groupsQuery.error)
      || hasAccessError(profilesQuery.error)
      || hasAccessError(initiativesQuery.error);
    if (accessLost) {
      queryClient.removeQueries({ queryKey: REQUESTS_QUERY_ROOT });
      onAccessDenied();
    }
  }, [auditQuery.error, groupsQuery.error, initiativesQuery.error, onAccessDenied, profilesQuery.error, queryClient, requestsQuery.error, selectedRequest.error]);

  useEffect(() => {
    if (!currentItem || lastFormRequestId.current === currentItem.id) return;
    editForm.reset(formValues(currentItem));
    setFormVersion(currentItem.version);
    setEditError('');
    lastFormRequestId.current = currentItem.id;
  }, [currentItem, editForm]);

  useEffect(() => {
    if (selectedRequestId === null) lastFormRequestId.current = null;
  }, [selectedRequestId]);

  useEffect(() => {
    if (selectedRequest.isError && isDetailNotFound) updateRequestUrl(null);
  }, [isDetailNotFound, selectedRequest.isError]);

  function openRequest(requestId: string) {
    setSelectedRequestId(requestId);
    setAuditRequestId(null);
    setNotice('');
    setAcceptError('');
    updateRequestUrl(requestId);
    updateAuditUrl(null);
  }

  function closeRequest() {
    setSelectedRequestId(null);
    setFormVersion(null);
    setAcceptError('');
    lastFormRequestId.current = null;
    updateRequestUrl(null);
  }

  async function invalidateRequestSurfaces(requestId: string, preserveDetail = false) {
    await queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_ROOT });
    await queryClient.invalidateQueries({ queryKey: ['resource-allocation-submissions', localUserId] });
    await queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'resource-allocation-notifications',
    });
    if (!preserveDetail) {
      await queryClient.removeQueries({ queryKey: [...REQUESTS_QUERY_ROOT, localUserId, 'detail', requestId] });
    }
  }

  async function onEdit(valuesToSave: RequestFormValues) {
    if (!currentItem || formVersion === null || !canEdit) return;
    setEditError('');
    const hours = normalizeWeeklyHours(valuesToSave.weeklyHours);
    if (hours.value === null) {
      editForm.setError('weeklyHours', { type: 'validate', message: hours.error });
      return;
    }
    const candidate = {
      initiativeId: valuesToSave.initiativeId,
      category: valuesToSave.category,
      groupId: valuesToSave.groupId,
      resourceProfileId: valuesToSave.resourceProfileId,
      startDate: valuesToSave.startDate,
      endDate: valuesToSave.endDate,
      weeklyHours: hours.value,
      comment: valuesToSave.comment,
    };
    const original = currentItem.requestedConditions;
    const patch: Parameters<typeof updateRequest>[3] = {};
    if (candidate.initiativeId !== original.initiativeId) patch.initiativeId = candidate.initiativeId;
    if (candidate.category !== original.category) patch.category = candidate.category;
    if (candidate.groupId !== original.groupId) patch.groupId = candidate.groupId;
    if (candidate.resourceProfileId !== original.resourceProfileId) patch.resourceProfileId = candidate.resourceProfileId;
    if (candidate.startDate !== original.startDate) patch.startDate = candidate.startDate;
    if (candidate.endDate !== original.endDate) patch.endDate = candidate.endDate;
    if (candidate.weeklyHours !== original.weeklyHours) patch.weeklyHours = candidate.weeklyHours;
    if (candidate.comment !== (original.comment ?? '')) patch.comment = candidate.comment;
    if (Object.keys(patch).length === 0) {
      setEditError('Make at least one change before saving.');
      return;
    }
    try {
      const updated = await updateMutation.mutateAsync({ requestId: currentItem.id, version: formVersion, patch });
      queryClient.setQueryData([...REQUESTS_QUERY_ROOT, localUserId, 'detail', currentItem.id], updated);
      editForm.reset(formValues(updated));
      setFormVersion(updated.version);
      setNotice('Your request was updated. The original submission and expiry dates were preserved.');
      await invalidateRequestSurfaces(currentItem.id);
    } catch (error) {
      if (hasAccessError(error)) {
        onAccessDenied();
        return;
      }
      setEditError(issueMutationError(error));
      if (error instanceof RequestApiError && error.status === 412) {
        setEditError('This request changed while you were editing. Your text is preserved; reload the latest version before saving again.');
        void selectedRequest.refetch();
      }
    }
  }

  async function onWithdraw(valuesToSave: WithdrawalFormValues) {
    if (!currentItem || formVersion === null || !canEdit) return;
    setWithdrawalError('');
    const previousAttempt = withdrawalAttempt;
    const idempotencyKey = previousAttempt
      && previousAttempt.requestId === currentItem.id
      && previousAttempt.version === formVersion
      && previousAttempt.reason === valuesToSave.reason
      ? previousAttempt.key
      : createUuid();
    setWithdrawalAttempt({ requestId: currentItem.id, version: formVersion, reason: valuesToSave.reason, key: idempotencyKey });
    try {
      const event = await withdrawMutation.mutateAsync({ requestId: currentItem.id, version: formVersion, reason: valuesToSave.reason, idempotencyKey });
      setWithdrawalAttempt(null);
      setAuditRequestId(event.requestId);
      setSelectedRequestId(null);
      setFormVersion(null);
      updateRequestUrl(null);
      updateAuditUrl(event.requestId);
      setWithdrawalOpen(false);
      withdrawalForm.reset({ reason: '' });
      setNotice('Your request was withdrawn. Its operational details were removed and its audit record was retained.');
      await invalidateRequestSurfaces(currentItem.id);
    } catch (error) {
      if (hasAccessError(error)) {
        onAccessDenied();
        return;
      }
      setWithdrawalError(issueMutationError(error));
      if (error instanceof RequestApiError && error.status === 412) {
        setWithdrawalError('This request changed while the confirmation was open. Your reason is preserved; reload the latest version before withdrawing.');
        void selectedRequest.refetch();
      }
    }
  }

  async function onAcceptProposal() {
    if (!currentItem || !canAcceptProposal || acceptDisabled || acceptMutation.isPending) return;
    setAcceptError('');
    const idempotencyKey = await acceptanceIdempotencyKey(localUserId, currentItem.id, currentItem.version);
    try {
      const accepted = await acceptMutation.mutateAsync({
        requestId: currentItem.id,
        version: currentItem.version,
        idempotencyKey,
      });
      setFormVersion(accepted.version);
      setNotice(accepted.confirmationSource === 'SYSTEM_DEADLINE'
        ? 'The proposal was automatically confirmed when the 72-hour response deadline was reached.'
        : accepted.confirmationSource === 'REQUESTER_ACCEPTANCE'
          ? 'You accepted the proposed conditions.'
          : 'The request status was updated.');
      await invalidateRequestSurfaces(currentItem.id, true);
    } catch (error) {
      if (hasAccessError(error)) {
        onAccessDenied();
        return;
      }
      if (error instanceof RequestApiError && error.status === 412) {
        setAcceptError('This proposal changed before it could be accepted. Your view is preserved; reload the latest request before acting again.');
        void selectedRequest.refetch();
        return;
      }
      if (error instanceof RequestApiError && error.status === 422 && error.problem?.code === 'INVALID_REQUEST_TRANSITION') {
        const latest = await selectedRequest.refetch();
        if (latest.isError || !latest.data
          || (latest.data.decisionState === 'APPROVED_WITH_CHANGES' && latest.data.availableActions?.includes('ACCEPT'))) {
          setAcceptError(issueMutationError(error));
        } else {
          setAcceptError('');
          setNotice('This proposal is no longer awaiting acceptance. The current request status has been loaded.');
        }
        await invalidateRequestSurfaces(currentItem.id, true);
        return;
      }
      setAcceptError(issueMutationError(error));
    }
  }

  async function reloadLatestRequest() {
    const result = await selectedRequest.refetch();
    if (result.data) {
      editForm.reset(formValues(result.data));
      setFormVersion(result.data.version);
      setEditError('');
      setWithdrawalError('');
      setAcceptError('');
    }
  }

  function setFilter(name: keyof RequestFilters, value: string) {
    setFilters((current) => ({ ...current, [name]: value || undefined }));
  }

  const selectedListItem = requests.find((item) => item.id === selectedRequestId);
  const currentConditions = currentItem?.requestedConditions;
  const confirmationLabel = currentItem?.confirmationSource === 'SYSTEM_DEADLINE'
    ? 'Automatically confirmed at deadline'
    : currentItem?.confirmationSource === 'REQUESTER_ACCEPTANCE' ? 'Accepted by requester' : null;
  const submitWithdrawal = handleWithdrawalSubmit(onWithdraw);

  return (
    <section className="request-workspace" aria-labelledby="my-requests-title">
      <div className="request-panel">
        <div className="request-panel-heading">
          <div>
            <p className="eyebrow">Your operational requests</p>
            <h2 id="my-requests-title">My requests</h2>
            <p>Review your requests, update a request that is waiting for presentation, or withdraw it with a reason.</p>
          </div>
        </div>

        {notice && <p className="inline-success" role="status">{notice}</p>}

        <div className="request-filters" aria-label="Filter requests">
          <label className="form-field">
            <span>ITDM</span>
            <select value={filters.initiativeId ?? ''} onChange={(event) => setFilter('initiativeId', event.target.value)}>
              <option value="">All ITDMs</option>
              {initiatives.map((initiative) => <option key={initiative.id} value={initiative.id}>{initiative.code} · {initiative.name}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span>Decision</span>
            <select value={filters.decisionState ?? ''} onChange={(event) => setFilter('decisionState', event.target.value)}>
              <option value="">All decisions</option>
              {decisionStates.map((state) => <option key={state.value} value={state.value}>{state.label}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span>Group</span>
            <select value={filters.groupId ?? ''} onChange={(event) => setFilter('groupId', event.target.value)}>
              <option value="">All groups</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span>Resource profile</span>
            <select value={filters.resourceProfileId ?? ''} onChange={(event) => setFilter('resourceProfileId', event.target.value)}>
              <option value="">All profiles</option>
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          </label>
        </div>

        {requestsQuery.isPending && <p className="supporting-copy" role="status">Loading your requests…</p>}
        {requestsQuery.isError && !requestsQuery.isFetchNextPageError && (
          <div className="form-error" role="alert">
            <p>Your requests could not be refreshed. Loaded requests and form values are still available; actions that need the current version are paused.</p>
            <button type="button" className="secondary-button" onClick={() => void requestsQuery.refetch()} disabled={requestsQuery.isFetching}>Try again</button>
          </div>
        )}
        {!requestsQuery.isPending && requests.length === 0 && !requestsQuery.isError && <p className="empty-state">No operational requests match these filters.</p>}
        {requests.length > 0 && (
          <div className="request-list" aria-label="Your requests">
            {requests.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`request-list-item${selectedRequestId === item.id ? ' request-list-item-selected' : ''}`}
                aria-pressed={selectedRequestId === item.id}
                onClick={() => openRequest(item.id)}
              >
                <span className="request-list-heading"><strong>{item.requestedConditions.initiativeCode} · {item.requestedConditions.initiativeName}</strong><small>{item.id}</small></span>
                <span>{item.requestedConditions.groupName} · {item.requestedConditions.resourceProfileName}</span>
                <span>{item.requestedConditions.startDate} to {item.requestedConditions.endDate}</span>
                <span className="status-badge">{decisionStates.find((state) => state.value === item.decisionState)?.label ?? item.decisionState}</span>
              </button>
            ))}
          </div>
        )}
        {requestsQuery.hasNextPage && (
          <button
            type="button"
            className="secondary-button request-load-more"
            onClick={() => void requestsQuery.fetchNextPage()}
            disabled={requestsQuery.isFetchingNextPage || (requestsQuery.isError && !requestsQuery.isFetchNextPageError)}
          >
            {requestsQuery.isFetchingNextPage ? 'Loading…' : 'Load more requests'}
          </button>
        )}
        {requestsQuery.isFetchNextPageError && (
          <div className="form-error request-load-more-error" role="alert">
            <p>More requests could not be loaded. Previously loaded requests remain available.</p>
            <button type="button" className="text-button" onClick={() => void requestsQuery.fetchNextPage()}>Try again</button>
          </div>
        )}

        {selectedRequestId && (
          <section className="request-detail" aria-labelledby="request-detail-title">
            <div className="request-detail-heading">
              <div>
                <p className="eyebrow">Request detail</p>
                <h3 id="request-detail-title">{currentConditions?.initiativeCode ?? selectedListItem?.requestedConditions.initiativeCode ?? 'Selected request'}</h3>
                <p>{selectedRequestId}</p>
              </div>
              <button type="button" className="secondary-button" onClick={closeRequest}>Close detail</button>
            </div>
            {selectedRequest.isPending && <p role="status">Loading request detail…</p>}
            {selectedRequest.isError && !isDetailNotFound && (
              <div className="form-error" role="alert">
                <p>The latest request detail could not be loaded. Your unsaved text remains here and changes are paused.</p>
                <button type="button" className="secondary-button" onClick={() => void selectedRequest.refetch()} disabled={selectedRequest.isFetching}>Try again</button>
              </div>
            )}
            {isDetailNotFound && <p className="empty-state">This request is no longer available as an operational request.</p>}
            {currentItem && (
              <>
                <div className="request-metadata">
                  <span><strong>Decision</strong>{decisionStates.find((state) => state.value === currentItem.decisionState)?.label ?? currentItem.decisionState}</span>
                  <span><strong>Submitted</strong>{formatTimestamp(currentItem.receivedAt)}</span>
                  <span><strong>Waiting expiry</strong>{formatTimestamp(currentItem.expirationDueAt)}</span>
                  {currentItem.decisionState === 'APPROVED_WITH_CHANGES' && currentItem.dueAt && (
                    <span><strong>Response deadline (São Paulo)</strong>{formatTimestamp(currentItem.dueAt)}</span>
                  )}
                  {confirmationLabel && <span><strong>Confirmation</strong>{confirmationLabel}</span>}
                  <span><strong>Version</strong>{currentItem.version}</span>
                </div>
                {currentItem.decisionState === 'APPROVED_WITH_CHANGES' && (
                  <section className="request-detail-outcome request-proposal-status" aria-label="Proposal response">
                    <h4>Respond to proposed conditions</h4>
                    <p>No allocation exists until you accept the proposal or the 72-hour response window ends.</p>
                    {acceptError && <p className="form-error" role="alert">{acceptError}</p>}
                    {canAcceptProposal ? (
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void onAcceptProposal()}
                        disabled={acceptDisabled || acceptMutation.isPending}
                      >
                        {acceptMutation.isPending ? 'Accepting proposal…' : 'Accept proposed conditions'}
                      </button>
                    ) : (
                      <p className="request-proposal-pending" role="status">Acceptance is unavailable. The system confirms eligible proposals automatically when the 72-hour response deadline is reached.</p>
                    )}
                  </section>
                )}
                {currentItem.decisionState === 'REQUIRES_REVALIDATION' && (
                  <section className="request-detail-outcome request-proposal-status" aria-label="Revalidation status">
                    <h4>Requires revalidation</h4>
                    <p>This request requires revalidation. The previous proposal cannot be accepted. A decision maker must review eligible conditions before a new decision is issued.</p>
                  </section>
                )}
                {(currentItem.decisionState === 'DENIED' || currentItem.decisionState === 'PRE_N3' || currentItem.decisionState === 'CANCELLED') && (
                  <DeniedRequestResponse
                    localUserId={localUserId}
                    item={currentItem}
                    disabled={selectedRequest.isFetching || requestsQuery.isError || formVersionChanged}
                    onChanged={(updated) => {
                      queryClient.setQueryData([...REQUESTS_QUERY_ROOT, localUserId, 'detail', updated.id], updated);
                      setFormVersion(updated.version);
                      void invalidateRequestSurfaces(updated.id);
                    }}
                    onAccessDenied={onAccessDenied}
                  />
                )}
                <section className="request-detail-outcome" aria-label="Requested conditions">
                  <h4>Requested conditions</h4>
                  <dl className="request-queue-details">
                    <div><dt>Group</dt><dd>{currentConditions?.groupName ?? 'Group unavailable'}</dd></div>
                    <div><dt>Resource profile</dt><dd>{currentConditions?.resourceProfileName ?? 'Profile unavailable'}</dd></div>
                    <div><dt>Period</dt><dd>{currentConditions?.startDate ?? '—'} to {currentConditions?.endDate ?? '—'}</dd></div>
                    <div><dt>Weekly hours</dt><dd>{currentConditions?.weeklyHours ?? '—'} hours per week</dd></div>
                  </dl>
                </section>
                {currentItem.approvedConditions && (
                  <section
                    className="request-detail-outcome"
                    aria-label={currentItem.decisionState === 'APPROVED_WITH_CHANGES' ? 'Proposed conditions' : 'Approved conditions'}
                  >
                    <h4>{currentItem.decisionState === 'APPROVED_WITH_CHANGES' ? 'Proposed conditions' : 'Approved conditions'}</h4>
                    <dl className="request-queue-details">
                      <div><dt>Approved person</dt><dd>{currentItem.approvedConditions.personName}</dd></div>
                      <div><dt>Approved resource profile</dt><dd>{currentItem.approvedConditions.resourceProfileName}</dd></div>
                      <div><dt>Group</dt><dd>{currentItem.approvedConditions.groupName}</dd></div>
                      <div><dt>Period</dt><dd>{currentItem.approvedConditions.startDate} to {currentItem.approvedConditions.endDate}</dd></div>
                      <div><dt>Weekly hours</dt><dd>{currentItem.approvedConditions.weeklyHours} hours per week</dd></div>
                    </dl>
                    {currentItem.approvedConditions.explanation && <p className="request-queue-comment">Approval explanation: {currentItem.approvedConditions.explanation}</p>}
                  </section>
                )}
                {currentItem.allocation && (
                  <section className="request-detail-outcome" aria-label="Approved allocation">
                    <h4>Approved allocation</h4>
                    <dl className="request-queue-details">
                      <div><dt>Allocated person</dt><dd>{currentItem.allocation.person.displayName}</dd></div>
                      <div><dt>Resource profile</dt><dd>{currentItem.allocation.resourceProfile.name}</dd></div>
                      <div><dt>Group</dt><dd>{currentItem.allocation.group.name}</dd></div>
                      <div><dt>Period</dt><dd>{currentItem.allocation.startDate} to {currentItem.allocation.endDate}</dd></div>
                      <div><dt>Weekly hours</dt><dd>{currentItem.allocation.weeklyHours} hours per week</dd></div>
                      <div><dt>Allocation state</dt><dd>{currentItem.allocation.state.replaceAll('_', ' ')}</dd></div>
                      <div><dt>Approved</dt><dd>{formatTimestamp(currentItem.allocation.approvedAt)}</dd></div>
                    </dl>
                  </section>
                )}
                {currentItem.decisionState !== 'WAITING_FOR_PRESENTATION' && (
                  <p className="field-help request-readonly-message">This request can no longer be edited or withdrawn because it has left the presentation-waiting stage.</p>
                )}
                {formVersionChanged && (
                  <div className="form-error" role="alert">
                    <p>A newer version is available. Your form values are preserved; reload the latest version before editing or withdrawing.</p>
                    <button type="button" className="secondary-button" onClick={() => void reloadLatestRequest()} disabled={selectedRequest.isFetching}>Load current request</button>
                  </div>
                )}
                {requestsQuery.isError && !requestsQuery.isFetchNextPageError && <p className="field-help">Actions are paused until your request list refreshes successfully.</p>}
                <form className="request-edit-form" onSubmit={editForm.handleSubmit(onEdit)}>
                  <div className="request-form-grid">
                    <label className="form-field">
                      <span>ITDM</span>
                      <select value={values?.initiativeId ?? ''} disabled={!canEdit || updateMutation.isPending} {...editForm.register('initiativeId', { required: 'Select an ITDM.' })}>
                        <option value="">Select an ITDM</option>
                        {initiatives.map((initiative) => <option key={initiative.id} value={initiative.id}>{initiative.code} · {initiative.name}</option>)}
                      </select>
                      {editForm.formState.errors.initiativeId?.message && <span className="field-error">{editForm.formState.errors.initiativeId.message}</span>}
                    </label>
                    <label className="form-field">
                      <span>Category</span>
                      <select value={values?.category ?? 'EXECUTION_PROJECT'} disabled={!canEdit || updateMutation.isPending} {...editForm.register('category', { required: 'Select a category.' })}>
                        {categoryOptions.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                      </select>
                    </label>
                    <label className="form-field">
                      <span>Group</span>
                      <select value={values?.groupId ?? ''} disabled={!canEdit || updateMutation.isPending} {...editForm.register('groupId', { required: 'Select a group.' })}>
                        <option value="">Select a group</option>
                        {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                      </select>
                      {editForm.formState.errors.groupId?.message && <span className="field-error">{editForm.formState.errors.groupId.message}</span>}
                    </label>
                    <label className="form-field">
                      <span>Resource profile</span>
                      <select value={values?.resourceProfileId ?? ''} disabled={!canEdit || updateMutation.isPending} {...editForm.register('resourceProfileId', { required: 'Select a resource profile.' })}>
                        <option value="">Select a resource profile</option>
                        {groupProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                      </select>
                      {editForm.formState.errors.resourceProfileId?.message && <span className="field-error">{editForm.formState.errors.resourceProfileId.message}</span>}
                    </label>
                    <label className="form-field">
                      <span>Start date</span>
                      <input type="date" disabled={!canEdit || updateMutation.isPending} {...editForm.register('startDate', { required: 'Enter a start date.' })} />
                      {editForm.formState.errors.startDate?.message && <span className="field-error">{editForm.formState.errors.startDate.message}</span>}
                    </label>
                    <label className="form-field">
                      <span>End date</span>
                      <input type="date" disabled={!canEdit || updateMutation.isPending} {...editForm.register('endDate', { required: 'Enter an end date.' })} />
                      {editForm.formState.errors.endDate?.message && <span className="field-error">{editForm.formState.errors.endDate.message}</span>}
                    </label>
                    <label className="form-field">
                      <span>Weekly hours</span>
                      <input
                        inputMode="decimal"
                        disabled={!canEdit || updateMutation.isPending}
                        aria-invalid={Boolean(editForm.formState.errors.weeklyHours)}
                        {...editForm.register('weeklyHours', { required: 'Enter weekly hours.', validate: (raw) => normalizeWeeklyHours(raw).error ?? true })}
                      />
                      <span className="field-help">More than 0 and up to 40 hours. One decimal place is used after rounding.</span>
                      {editForm.formState.errors.weeklyHours?.message && <span className="field-error">{editForm.formState.errors.weeklyHours.message}</span>}
                    </label>
                    <label className="form-field request-comment-field">
                      <span>Comment <span className="optional-label">(optional)</span></span>
                      <textarea maxLength={2000} disabled={!canEdit || updateMutation.isPending} {...editForm.register('comment')} />
                      <span className="field-help">Up to 2,000 characters.</span>
                    </label>
                  </div>
                  {editError && <div className="form-error" role="alert"><p>{editError}</p></div>}
                  <div className="form-actions request-actions">
                    <button type="submit" className="primary-button" disabled={!canEdit || updateMutation.isPending}>
                      {updateMutation.isPending ? 'Saving…' : 'Save request changes'}
                    </button>
                    <button ref={withdrawButtonRef} type="button" className="secondary-button" disabled={!canEdit || withdrawMutation.isPending} onClick={() => { setWithdrawalError(''); setWithdrawalOpen(true); }}>
                      Withdraw request
                    </button>
                  </div>
                </form>
              </>
            )}
          </section>
        )}

        {auditRequestId && (
          <section className="request-audit" aria-labelledby="request-audit-title">
            <div className="request-detail-heading">
              <div>
                <p className="eyebrow">Immutable record</p>
                <h3 id="request-audit-title">Request audit</h3>
                <p>{auditRequestId}</p>
              </div>
              <button type="button" className="secondary-button" onClick={() => { setAuditRequestId(null); updateAuditUrl(null); }}>Close audit</button>
            </div>
            {auditQuery.isPending && <p role="status">Loading audit record…</p>}
            {auditQuery.isError && (
              <div className="form-error" role="alert">
                <p>The audit record could not be loaded. Protected details are not shown.</p>
                <button type="button" className="secondary-button" onClick={() => void auditQuery.refetch()} disabled={auditQuery.isFetching}>Try again</button>
              </div>
            )}
            {auditQuery.data?.events.map((event) => (
              <article className="request-audit-event" key={event.id}>
                <h4>{event.action === 'WITHDRAWN' ? 'Withdrawn by requester' : event.action}</h4>
                <p><strong>When:</strong> {formatTimestamp(event.occurredAt)}</p>
                <p><strong>Reason:</strong> {event.reason}</p>
                <p><strong>Requester:</strong> {String(event.requesterSnapshot.displayName ?? 'Requester')}</p>
                <div className="request-audit-conditions">
                  <strong>Saved request conditions</strong>
                  <p>{String(event.requestSnapshot.requestedConditions && (event.requestSnapshot.requestedConditions as Record<string, unknown>).initiativeCode)} · {String(event.requestSnapshot.requestedConditions && (event.requestSnapshot.requestedConditions as Record<string, unknown>).groupName)} · {String(event.requestSnapshot.requestedConditions && (event.requestSnapshot.requestedConditions as Record<string, unknown>).resourceProfileName)}</p>
                </div>
              </article>
            ))}
          </section>
        )}
      </div>

      {withdrawalOpen && currentItem && (
        <div className="request-modal-backdrop">
          <section
            className="request-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="withdraw-title"
            aria-describedby="withdraw-description"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                if (!withdrawMutation.isPending) setWithdrawalOpen(false);
                return;
              }
              if (event.key !== 'Tab') return;
              const focusable = event.currentTarget.querySelectorAll<HTMLElement>('textarea:not([disabled]), button:not([disabled])');
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <h3 id="withdraw-title">Withdraw this request?</h3>
            <p id="withdraw-description">This removes the request from operational lists. Its conditions, requester, reason, and time are retained in the audit record.</p>
            <form onSubmit={submitWithdrawal}>
              <label className="form-field">
                <span>Reason for withdrawal</span>
                <textarea
                  autoFocus
                  maxLength={2000}
                  aria-invalid={Boolean(withdrawalForm.formState.errors.reason)}
                  {...withdrawalForm.register('reason', { required: 'Enter a reason before confirming.', validate: (value) => value.trim().length > 0 || 'Enter a reason before confirming.' })}
                />
                <span className="field-help">Required · up to 2,000 characters.</span>
                {withdrawalForm.formState.errors.reason?.message && <span className="field-error">{withdrawalForm.formState.errors.reason.message}</span>}
              </label>
              {withdrawalError && <div className="form-error" role="alert"><p>{withdrawalError}</p></div>}
              <div className="form-actions request-actions">
                <button type="button" className="secondary-button" onClick={() => setWithdrawalOpen(false)} disabled={withdrawMutation.isPending}>Keep request</button>
                <button type="submit" className="primary-button" disabled={!canEdit || withdrawMutation.isPending}>
                  {withdrawMutation.isPending ? 'Withdrawing…' : 'Confirm withdrawal'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
