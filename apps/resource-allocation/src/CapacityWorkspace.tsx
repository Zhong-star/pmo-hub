import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { businessDate, formatBusinessTimestamp, formatCalendarDate } from './timeAndHours';
import { useNavigationFormProtection, useNavigationProtection } from './NavigationProtection';
import {
  CAPACITY_QUERY_ROOT,
  CapacityRequestError,
  createCapacity,
  getCapacities,
  getCapacityHistory,
  getCapacityOptions,
  removeCapacity,
  updateCapacity,
  type CapacityCreateInput,
  type CapacityEntry,
  type CapacityFilters,
  type CapacityHistoryEvent,
} from './capacityApi';
import './CapacityWorkspace.css';

interface CapacityWorkspaceProps {
  localUserId: string;
  canCorrectPast: boolean;
  onAccessDenied: () => void;
}

interface CapacityFormValues {
  groupId: string;
  resourceProfileId: string;
  classification: 'INTERNAL' | 'THIRD_PARTY';
  effectiveDate: string;
  fte: string;
  reason: string;
}

type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; capacity: CapacityEntry }
  | { mode: 'remove'; capacity: CapacityEntry }
  | null;

interface MutationAttempt {
  fingerprint: string;
  idempotencyKey: string;
}

function emptyFormValues(): CapacityFormValues {
  return {
    groupId: '',
    resourceProfileId: '',
    classification: 'INTERNAL',
    effectiveDate: businessDate(),
    fte: '',
    reason: '',
  };
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof CapacityRequestError && (error.status === 401 || error.status === 403);
}

function errorMessage(error: unknown, action: string): string {
  if (error instanceof CapacityRequestError && error.status === 412) {
    return 'This capacity entry changed in another session. Cancel and reopen it before trying again.';
  }
  if (error instanceof CapacityRequestError && error.status === null) {
    return `The ${action} could not be confirmed. Retry the same change to safely check its result.`;
  }
  return error instanceof CapacityRequestError ? error.message : `The ${action} could not be completed.`;
}

function formatFte(value: number): string {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

function isPast(value: string): boolean {
  return value < businessDate();
}

function capacitySnapshotLabel(value: CapacityHistoryEvent['before']): string {
  if (!value) return 'No capacity entry';
  return `${value.fte.toFixed(1)} FTE from ${formatCalendarDate(value.effectiveDate)}`;
}

function flattenPages<T>(data: { pages: Array<{ items: T[] }> } | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

function nextAttempt(current: MutationAttempt | null, command: unknown): MutationAttempt {
  const fingerprint = JSON.stringify(command);
  if (current?.fingerprint === fingerprint) return current;
  return { fingerprint, idempotencyKey: window.crypto.randomUUID() };
}

export function CapacityWorkspace({ localUserId, canCorrectPast, onAccessDenied }: CapacityWorkspaceProps) {
  const queryClient = useQueryClient();
  const { guardNavigation } = useNavigationProtection();
  const [filters, setFilters] = useState<CapacityFilters>({});
  const [editor, setEditor] = useState<EditorState>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [requestError, setRequestError] = useState('');
  const [attempt, setAttempt] = useState<MutationAttempt | null>(null);
  const groupFieldRef = useRef<HTMLSelectElement | null>(null);
  const today = businessDate();
  const filterKey = useMemo(() => JSON.stringify(filters), [filters]);
  const capacitiesQuery = useInfiniteQuery({
    queryKey: [...CAPACITY_QUERY_ROOT, localUserId, filterKey],
    queryFn: ({ pageParam }) => getCapacities(localUserId, filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    retry: false,
  });
  const optionsQuery = useQuery({
    queryKey: [...CAPACITY_QUERY_ROOT, localUserId, 'options'],
    queryFn: () => getCapacityOptions(localUserId),
    retry: false,
  });
  const historyQuery = useQuery({
    queryKey: [...CAPACITY_QUERY_ROOT, localUserId, 'history', historyId],
    queryFn: () => getCapacityHistory(localUserId, historyId!),
    enabled: historyId !== null,
    retry: false,
  });
  const form = useForm<CapacityFormValues>({ defaultValues: emptyFormValues(), mode: 'onSubmit', reValidateMode: 'onChange' });
  const { register, handleSubmit, reset, control, setError, clearErrors, formState } = form;
  const selectedGroupId = useWatch({ control, name: 'groupId' });
  const selectedGroup = optionsQuery.data?.groups.find((group) => group.id === selectedGroupId);
  const capacities = flattenPages(capacitiesQuery.data);
  const isCreating = editor?.mode === 'create';
  const isRemoving = editor?.mode === 'remove';
  const editingCapacity = editor && editor.mode !== 'create' ? editor.capacity : null;
  const formIsDirty = Boolean(editor && formState.isDirty);

  const createMutation = useMutation({ mutationFn: ({ input, idempotencyKey }: { input: CapacityCreateInput; idempotencyKey: string }) =>
    createCapacity(localUserId, input, idempotencyKey) });
  const updateMutation = useMutation({ mutationFn: ({ capacity, input, idempotencyKey }: { capacity: CapacityEntry; input: Parameters<typeof updateCapacity>[3]; idempotencyKey: string }) =>
    updateCapacity(localUserId, capacity.id, capacity.version, input, idempotencyKey) });
  const removeMutation = useMutation({ mutationFn: ({ capacity, reason, idempotencyKey }: { capacity: CapacityEntry; reason: string; idempotencyKey: string }) =>
    removeCapacity(localUserId, capacity.id, capacity.version, reason, idempotencyKey) });

  useNavigationFormProtection(
    'capacity entry',
    formIsDirty,
    formState.isSubmitting || createMutation.isPending || updateMutation.isPending || removeMutation.isPending,
  );

  useEffect(() => {
    if (editor?.mode === 'create') groupFieldRef.current?.focus();
  }, [editor]);

  useEffect(() => {
    if (isAccessDenied(capacitiesQuery.error) || isAccessDenied(optionsQuery.error) || isAccessDenied(historyQuery.error)) {
      onAccessDenied();
    }
  }, [capacitiesQuery.error, historyQuery.error, onAccessDenied, optionsQuery.error]);

  function clearFieldErrors() {
    clearErrors();
    setRequestError('');
  }

  function prepareForm(next: EditorState) {
    if (next?.mode === 'edit' || next?.mode === 'remove') {
      reset({
        groupId: next.capacity.group.id,
        resourceProfileId: next.capacity.resourceProfile.id,
        classification: next.capacity.classification,
        effectiveDate: next.capacity.effectiveDate,
        fte: String(next.capacity.fte),
        reason: '',
      });
    } else {
      reset(emptyFormValues());
    }
    clearErrors();
    setRequestError('');
    setAttempt(null);
  }

  function openEditor(next: EditorState) {
    guardNavigation(() => {
      setNotice('');
      prepareForm(next);
      setEditor(next);
    });
  }

  function closeEditor() {
    guardNavigation(() => {
      prepareForm(null);
      setEditor(null);
    });
  }

  function handleMutationError(error: unknown, action: string) {
    if (isAccessDenied(error)) {
      onAccessDenied();
      return;
    }
    setRequestError(errorMessage(error, action));
    if (error instanceof CapacityRequestError) {
      for (const fieldError of error.problem?.errors ?? []) {
        if (['groupId', 'resourceProfileId', 'classification', 'effectiveDate', 'fte', 'reason'].includes(fieldError.path)) {
          setError(fieldError.path as keyof CapacityFormValues, { type: 'server', message: fieldError.message });
        }
      }
    }
  }

  async function refreshCapacities() {
    await queryClient.invalidateQueries({ queryKey: [...CAPACITY_QUERY_ROOT, localUserId] });
  }

  async function submit(values: CapacityFormValues) {
    setNotice('');
    setRequestError('');
    clearErrors();
    if (editor?.mode === 'create') {
      const input: CapacityCreateInput = {
        groupId: values.groupId,
        resourceProfileId: values.resourceProfileId,
        classification: values.classification,
        effectiveDate: values.effectiveDate,
        fte: Number(values.fte.replace(',', '.')),
        reason: values.reason.trim(),
      };
      const keyed = nextAttempt(attempt, input);
      setAttempt(keyed);
      const idempotencyKey = keyed.idempotencyKey;
      try {
        await createMutation.mutateAsync({ input, idempotencyKey });
        setAttempt(null);
        reset(emptyFormValues());
        setEditor(null);
        setNotice('Capacity entry created.');
        await refreshCapacities();
      } catch (error) {
        handleMutationError(error, 'capacity entry');
      }
      return;
    }
    if (editor?.mode === 'edit') {
      const input = {
        effectiveDate: values.effectiveDate,
        fte: Number(values.fte.replace(',', '.')),
        reason: values.reason.trim(),
      };
      const command = { id: editor.capacity.id, version: editor.capacity.version, input };
      const keyed = nextAttempt(attempt, command);
      setAttempt(keyed);
      const idempotencyKey = keyed.idempotencyKey;
      try {
        await updateMutation.mutateAsync({ capacity: editor.capacity, input, idempotencyKey });
        setAttempt(null);
        reset(emptyFormValues());
        setEditor(null);
        setNotice('Capacity entry updated.');
        await refreshCapacities();
      } catch (error) {
        handleMutationError(error, 'capacity entry');
        if (error instanceof CapacityRequestError && error.status === 412) await refreshCapacities();
      }
    }
  }

  async function confirmRemoval() {
    if (editor?.mode !== 'remove') return;
    const reason = form.getValues('reason').trim();
    if (!reason) {
      setError('reason', { type: 'required', message: 'Enter a reason for removing this capacity entry.' });
      return;
    }
    setNotice('');
    setRequestError('');
    const command = { id: editor.capacity.id, version: editor.capacity.version, reason };
    const keyed = nextAttempt(attempt, command);
      setAttempt(keyed);
      const idempotencyKey = keyed.idempotencyKey;
    try {
      await removeMutation.mutateAsync({ capacity: editor.capacity, reason, idempotencyKey });
      setAttempt(null);
      setHistoryId(editor.capacity.id);
      reset(emptyFormValues());
      setEditor(null);
      setNotice('Capacity entry removed. Its audit history is still available below.');
      await refreshCapacities();
    } catch (error) {
      handleMutationError(error, 'capacity entry removal');
      if (error instanceof CapacityRequestError && error.status === 412) await refreshCapacities();
    }
  }

  function openHistory(capacity: CapacityEntry) {
    guardNavigation(() => {
      setHistoryId(capacity.id);
      setRequestError('');
    });
  }

  function openCreate() {
    openEditor({ mode: 'create' });
  }

  function loadMore() {
    void capacitiesQuery.fetchNextPage();
  }

  const profileFilterOptions = useMemo(() => {
    const options = new Map<string, { id: string; name: string; groupId: string; groupName: string; active: boolean }>();
    for (const group of optionsQuery.data?.groups ?? []) {
      for (const profile of group.resourceProfiles) options.set(profile.id, { ...profile, groupId: group.id, groupName: group.name });
    }
    for (const capacity of capacities) {
      if (!options.has(capacity.resourceProfile.id)) {
        options.set(capacity.resourceProfile.id, { ...capacity.resourceProfile, groupId: capacity.group.id, groupName: capacity.group.name });
      }
    }
    if (filters.resourceProfileId && !options.has(filters.resourceProfileId)) {
      options.set(filters.resourceProfileId, { id: filters.resourceProfileId, name: 'Selected profile', groupId: filters.groupId ?? '', groupName: 'current filter', active: false });
    }
    return [...options.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [capacities, filters.groupId, filters.resourceProfileId, optionsQuery.data]);

  const formBusy = formState.isSubmitting || createMutation.isPending || updateMutation.isPending || removeMutation.isPending;
  const groupRegister = register('groupId', { required: 'Choose a group.' });
  const profileRegister = register('resourceProfileId', { required: 'Choose an active resource profile.' });
  const dateRegister = register('effectiveDate', { required: 'Choose an effective date.' });
  const fteRegister = register('fte', {
    validate: (value) => (/^\d+(?:[.,]\d+)?$/.test(value.trim()) && Number.isFinite(Number(value.trim().replace(',', '.'))))
      || 'Enter a non-negative FTE value, such as 0, 0.5, or 2.',
  });
  const classificationRegister = register('classification', { required: 'Choose a classification.' });
  const reasonRegister = register('reason', {
    required: 'Enter a reason for this change.',
    validate: (value) => value.trim().length > 0 || 'Enter a reason for this change.',
    maxLength: { value: 2000, message: 'Reason must be 2,000 characters or fewer.' },
  });

  return (
    <section className="capacity-workspace" aria-labelledby="capacity-title">
      <div className="capacity-heading">
        <div>
          <p className="eyebrow">Team planning</p>
          <h2 id="capacity-title">Capacity</h2>
          <p className="capacity-intro">Maintain internal and third-party FTE capacity by group, resource profile, and effective date.</p>
        </div>
        {editor === null && <button className="primary-button" type="button" onClick={openCreate}>Add capacity</button>}
      </div>

      {notice && <p className="inline-success" role="status">{notice}</p>}

      <section className="capacity-filters" aria-label="Filter capacity entries">
        <label>
          <span>Group</span>
          <select
            value={filters.groupId ?? ''}
            onChange={(event) => setFilters((current) => ({ ...current, groupId: event.target.value || undefined }))}
          >
            <option value="">All authorized groups</option>
            {(optionsQuery.data?.groups ?? []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <label>
          <span>Resource profile</span>
          <select
            value={filters.resourceProfileId ?? ''}
            onChange={(event) => setFilters((current) => ({ ...current, resourceProfileId: event.target.value || undefined }))}
          >
            <option value="">All profiles</option>
            {profileFilterOptions
              .filter((profile) => !filters.groupId || profile.groupId === filters.groupId)
              .map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.groupName}{profile.active ? '' : ' (inactive)'}</option>)}
          </select>
        </label>
        <label>
          <span>Classification</span>
          <select
            value={filters.classification ?? ''}
            onChange={(event) => setFilters((current) => ({ ...current, classification: (event.target.value || undefined) as CapacityFilters['classification'] }))}
          >
            <option value="">Internal and third-party</option>
            <option value="INTERNAL">Internal</option>
            <option value="THIRD_PARTY">Third-party</option>
          </select>
        </label>
      </section>

      {editor && (
        <section className="capacity-editor" aria-labelledby="capacity-editor-title">
          <div className="capacity-editor-heading">
            <div>
              <p className="eyebrow">{isCreating ? 'New capacity entry' : isRemoving ? 'Remove capacity entry' : 'Edit capacity entry'}</p>
              <h3 id="capacity-editor-title">{isCreating ? 'Add FTE capacity' : `${editingCapacity?.resourceProfile.name ?? 'Capacity'} · ${editingCapacity?.classification === 'INTERNAL' ? 'Internal' : 'Third-party'}`}</h3>
            </div>
            <button className="text-button" type="button" onClick={closeEditor} disabled={formBusy}>Cancel</button>
          </div>

          {requestError && <p className="form-error" role="alert">{requestError}</p>}

          {isRemoving ? (
            <div className="capacity-remove-summary">
              <p><strong>{editingCapacity?.group.name}</strong> · {editingCapacity?.resourceProfile.name} · {formatFte(editingCapacity?.fte ?? 0)} FTE from {formatCalendarDate(editingCapacity?.effectiveDate ?? today)}</p>
              {editingCapacity?.resourceProfile.active === false && <p className="capacity-inactive-note">This resource profile is inactive. Existing capacity remains unchanged until you remove it.</p>}
              <label className="capacity-field capacity-reason-field">
                <span>Reason for removal <em>Required</em></span>
                <textarea {...reasonRegister} rows={3} maxLength={2000} aria-invalid={Boolean(formState.errors.reason)} aria-describedby={formState.errors.reason ? 'capacity-reason-error' : undefined} onChange={(event) => { void reasonRegister.onChange(event); clearFieldErrors(); }} />
                {formState.errors.reason && <small id="capacity-reason-error" className="field-error">{formState.errors.reason.message}</small>}
              </label>
              <div className="capacity-form-actions">
                <button className="danger-button" type="button" onClick={() => void confirmRemoval()} disabled={formBusy}>Remove capacity</button>
                <button className="secondary-button" type="button" onClick={closeEditor} disabled={formBusy}>Keep capacity</button>
              </div>
            </div>
          ) : (
            <form className="capacity-form" onSubmit={handleSubmit(submit)} noValidate>
              {isCreating ? (
                <div className="capacity-form-grid">
                  <label className="capacity-field">
                    <span>Group <em>Required</em></span>
                    <select {...groupRegister} ref={(element) => { groupRegister.ref(element); groupFieldRef.current = element; }} aria-invalid={Boolean(formState.errors.groupId)} onChange={(event) => { void groupRegister.onChange(event); form.setValue('resourceProfileId', '', { shouldDirty: true }); clearFieldErrors(); }}>
                      <option value="">Select a group</option>
                      {(optionsQuery.data?.groups ?? []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                    </select>
                    {formState.errors.groupId && <small className="field-error">{formState.errors.groupId.message}</small>}
                  </label>
                  <label className="capacity-field">
                    <span>Resource profile <em>Required</em></span>
                    <select {...profileRegister} disabled={!selectedGroupId || optionsQuery.isPending} aria-invalid={Boolean(formState.errors.resourceProfileId)} onChange={(event) => { void profileRegister.onChange(event); clearFieldErrors(); }}>
                      <option value="">Select a profile</option>
                      {(selectedGroup?.resourceProfiles ?? []).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select>
                    {formState.errors.resourceProfileId && <small className="field-error">{formState.errors.resourceProfileId.message}</small>}
                  </label>
                  <label className="capacity-field">
                    <span>Classification <em>Required</em></span>
                    <select {...classificationRegister} aria-invalid={Boolean(formState.errors.classification)} onChange={(event) => { void classificationRegister.onChange(event); clearFieldErrors(); }}>
                      <option value="INTERNAL">Internal</option>
                      <option value="THIRD_PARTY">Third-party</option>
                    </select>
                    {formState.errors.classification && <small className="field-error">{formState.errors.classification.message}</small>}
                  </label>
                  <label className="capacity-field">
                    <span>Effective from <em>Required</em></span>
                    <input {...dateRegister} type="date" min={canCorrectPast ? undefined : today} aria-invalid={Boolean(formState.errors.effectiveDate)} onChange={(event) => { void dateRegister.onChange(event); clearFieldErrors(); }} />
                    {formState.errors.effectiveDate && <small className="field-error">{formState.errors.effectiveDate.message}</small>}
                  </label>
                  <label className="capacity-field">
                    <span>Capacity <em>FTE</em></span>
                    <input {...fteRegister} type="text" inputMode="decimal" aria-describedby="capacity-fte-help" aria-invalid={Boolean(formState.errors.fte)} onChange={(event) => { void fteRegister.onChange(event); clearFieldErrors(); }} />
                    <small id="capacity-fte-help">1.0 FTE represents 40 hours per week. Zero is allowed; values round to one decimal place.</small>
                    {formState.errors.fte && <small className="field-error">{formState.errors.fte.message}</small>}
                  </label>
                  <label className="capacity-field capacity-reason-field">
                    <span>Reason <em>Required</em></span>
                    <textarea {...reasonRegister} rows={3} maxLength={2000} aria-invalid={Boolean(formState.errors.reason)} onChange={(event) => { void reasonRegister.onChange(event); clearFieldErrors(); }} />
                    {formState.errors.reason && <small className="field-error">{formState.errors.reason.message}</small>}
                  </label>
                </div>
              ) : (
                <>
                  <dl className="capacity-readonly-details">
                    <div><dt>Group</dt><dd>{editingCapacity?.group.name}</dd></div>
                    <div><dt>Resource profile</dt><dd>{editingCapacity?.resourceProfile.name}{editingCapacity?.resourceProfile.active === false && <span className="capacity-inactive-badge">Inactive</span>}</dd></div>
                    <div><dt>Classification</dt><dd>{editingCapacity?.classification === 'INTERNAL' ? 'Internal' : 'Third-party'}</dd></div>
                  </dl>
                  <div className="capacity-form-grid capacity-edit-fields">
                    <label className="capacity-field">
                      <span>Effective from <em>Required</em></span>
                      <input {...dateRegister} type="date" min={canCorrectPast ? undefined : today} aria-invalid={Boolean(formState.errors.effectiveDate)} onChange={(event) => { void dateRegister.onChange(event); clearFieldErrors(); }} />
                      {formState.errors.effectiveDate && <small className="field-error">{formState.errors.effectiveDate.message}</small>}
                    </label>
                    <label className="capacity-field">
                      <span>Capacity <em>FTE</em></span>
                      <input {...fteRegister} type="text" inputMode="decimal" aria-describedby="capacity-fte-help" aria-invalid={Boolean(formState.errors.fte)} onChange={(event) => { void fteRegister.onChange(event); clearFieldErrors(); }} />
                      <small id="capacity-fte-help">1.0 FTE represents 40 hours per week. Zero is allowed; values round to one decimal place.</small>
                      {formState.errors.fte && <small className="field-error">{formState.errors.fte.message}</small>}
                    </label>
                    <label className="capacity-field capacity-reason-field">
                      <span>Reason <em>Required</em></span>
                      <textarea {...reasonRegister} rows={3} maxLength={2000} aria-invalid={Boolean(formState.errors.reason)} onChange={(event) => { void reasonRegister.onChange(event); clearFieldErrors(); }} />
                      {formState.errors.reason && <small className="field-error">{formState.errors.reason.message}</small>}
                    </label>
                  </div>
                </>
              )}
              <div className="capacity-form-actions">
                <button className="primary-button" type="submit" disabled={formBusy || optionsQuery.isPending || (isCreating && optionsQuery.data?.groups.length === 0)}>
                  {formBusy ? 'Saving…' : isCreating ? 'Save capacity' : 'Save changes'}
                </button>
                {!isCreating && editingCapacity && <button className="danger-button" type="button" onClick={() => openEditor({ mode: 'remove', capacity: editingCapacity })} disabled={formBusy}>Remove</button>}
                <button className="secondary-button" type="button" onClick={closeEditor} disabled={formBusy}>Cancel</button>
              </div>
            </form>
          )}
        </section>
      )}

      <section className="capacity-list-panel" aria-labelledby="capacity-list-title">
        <div className="capacity-list-heading">
          <div>
            <h3 id="capacity-list-title">Effective capacity entries</h3>
            <p>Each value applies from its effective date until the next entry for the same group, profile, and classification.</p>
          </div>
          {editor === null && <button className="secondary-button" type="button" onClick={openCreate}>Add capacity</button>}
        </div>

        {capacitiesQuery.isPending && <p className="capacity-empty-state" role="status">Loading capacity entries…</p>}
        {capacitiesQuery.isError && !capacitiesQuery.isFetchNextPageError && !isAccessDenied(capacitiesQuery.error) && (
          <div className="form-error" role="alert">
            <p>{errorMessage(capacitiesQuery.error, 'capacity list')}</p>
            <button className="secondary-button" type="button" onClick={() => void capacitiesQuery.refetch()}>Try again</button>
          </div>
        )}
        {capacitiesQuery.isSuccess && capacities.length === 0 && <p className="capacity-empty-state" role="status">No capacity entries have been configured for these filters.</p>}
        {capacities.length > 0 && (
          <ul className="capacity-list">
            {capacities.map((capacity) => {
              const pastAndLocked = !canCorrectPast && isPast(capacity.effectiveDate);
              return (
                <li className="capacity-card" key={capacity.id}>
                  <div className="capacity-card-content">
                    <div className="capacity-card-title">
                      <div>
                        <span className="capacity-classification">{capacity.classification === 'INTERNAL' ? 'Internal' : 'Third-party'}</span>
                        <h4>{capacity.resourceProfile.name}</h4>
                        <p>{capacity.group.name}</p>
                      </div>
                      {capacity.resourceProfile.active
                        ? <span className="capacity-active-badge">Active profile</span>
                        : <span className="capacity-inactive-badge">Inactive profile</span>}
                    </div>
                    <dl className="capacity-card-details">
                      <div><dt>Effective from</dt><dd>{formatCalendarDate(capacity.effectiveDate)}</dd></div>
                      <div><dt>Capacity</dt><dd>{formatFte(capacity.fte)} FTE</dd></div>
                      <div><dt>Applies through</dt><dd>{capacity.effectiveUntil ? formatCalendarDate(capacity.effectiveUntil) : 'No later entry'}</dd></div>
                    </dl>
                    {pastAndLocked && <p className="capacity-inactive-note">Past capacity entries can only be corrected by an Admin.</p>}
                  </div>
                  <div className="capacity-card-actions" aria-label={`Actions for ${capacity.resourceProfile.name} ${capacity.classification === 'INTERNAL' ? 'internal' : 'third-party'} capacity from ${capacity.effectiveDate}`}>
                    <button className="text-button" type="button" onClick={() => openHistory(capacity)}>History</button>
                    <button className="text-button" type="button" onClick={() => openEditor({ mode: 'edit', capacity })} disabled={pastAndLocked}>Edit</button>
                    <button className="text-button capacity-remove-link" type="button" onClick={() => openEditor({ mode: 'remove', capacity })} disabled={pastAndLocked}>Remove</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {capacitiesQuery.isFetchNextPageError && <p className="form-error" role="alert">The next page could not be loaded. Existing entries remain available.</p>}
        {(capacitiesQuery.hasNextPage || capacitiesQuery.isFetchNextPageError) && (
          <button className="secondary-button capacity-load-more" type="button" onClick={loadMore} disabled={capacitiesQuery.isFetching || (capacitiesQuery.isError && !capacitiesQuery.isFetchNextPageError)}>
            {capacitiesQuery.isFetchNextPageError ? 'Retry loading more' : capacitiesQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </section>

      {historyId && (
        <CapacityHistoryPanel
          capacityId={historyId}
          query={historyQuery}
          onClose={() => setHistoryId(null)}
        />
      )}
    </section>
  );

}

function CapacityHistoryPanel({
  capacityId,
  query,
  onClose,
}: {
  capacityId: string;
  query: UseQueryResult<Awaited<ReturnType<typeof getCapacityHistory>>, Error>;
  onClose: () => void;
}) {
  const events = query.data?.items ?? [];
  return (
    <section className="capacity-history-panel" aria-labelledby="capacity-history-title">
      <div className="capacity-list-heading">
        <div>
          <p className="eyebrow">Audit history</p>
          <h3 id="capacity-history-title">Capacity changes</h3>
          <p>Entry reference {capacityId}</p>
        </div>
        <button className="text-button" type="button" onClick={onClose}>Close history</button>
      </div>
      {query.isPending && <p className="capacity-empty-state" role="status">Loading history…</p>}
      {query.isError && <p className="form-error" role="alert">{errorMessage(query.error, 'capacity history')}</p>}
      {query.isSuccess && events.length === 0 && <p className="capacity-empty-state" role="status">No changes have been recorded.</p>}
      {events.length > 0 && (
        <ol className="capacity-history-list">
          {events.map((event) => (
            <li key={event.id} className="capacity-history-event">
              <div className="capacity-history-event-heading">
                <strong>{event.action === 'CREATED' ? 'Created' : event.action === 'UPDATED' ? 'Updated' : 'Removed'}</strong>
                <time dateTime={event.occurredAt}>{formatBusinessTimestamp(event.occurredAt)}</time>
              </div>
              <p>By {event.actor.displayName}</p>
              <p>{event.reason}</p>
              <dl className="capacity-history-change">
                <div><dt>Before</dt><dd>{capacitySnapshotLabel(event.before)}</dd></div>
                <div><dt>After</dt><dd>{capacitySnapshotLabel(event.after)}</dd></div>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
