import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { RequestApiError, REQUESTS_QUERY_ROOT, updateRequest, withdrawRequest, type RequestAuditEvent, type ResourceRequestItem } from '../requestApi';
import { type RequestCategory } from '../submissionApi';
import { normalizeWeeklyHours } from '../timeAndHours';
import { invalidateRequestSurfaces } from '../requestSurfaces';
import { useNavigationFormProtection } from '../NavigationProtection';
import { formValues, hasAccessError, issueMutationError, rowsFromPages, useRequestSelectionQuery, type RequestFormValues } from './shared';

interface WithdrawalFormValues { reason: string; }

const categoryOptions: Array<{ value: RequestCategory; label: string }> = [
  { value: 'DEMAND_ANALYSIS', label: 'Demand Analysis' },
  { value: 'POC_BBP', label: 'POC/BBP' },
  { value: 'EXECUTION_PROJECT', label: 'Execution — Project' },
  { value: 'EXECUTION_FAST_TRACK', label: 'Execution — Fast track' },
  { value: 'EXECUTION_ENHANCEMENT', label: 'Execution — Enhancement' },
];

function createUuid() {
  return window.crypto.randomUUID();
}

export function RequestEditWithdrawal({
  localUserId,
  item,
  formVersion,
  formVersionChanged,
  canEdit: canEditCurrentRequest,
  listRefreshFailed,
  onVersionChange,
  onNotice,
  onAccessDenied,
  onRefreshLatest,
  onReloadLatest,
  onWithdrawn,
}: {
  localUserId: string;
  item: ResourceRequestItem;
  formVersion: number | null;
  formVersionChanged: boolean;
  canEdit: boolean;
  listRefreshFailed: boolean;
  onVersionChange: (version: number) => void;
  onNotice: (notice: string) => void;
  onAccessDenied: () => void;
  onRefreshLatest: () => void;
  onReloadLatest: () => Promise<ResourceRequestItem | undefined>;
  onWithdrawn: (event: RequestAuditEvent) => void;
}) {
  const queryClient = useQueryClient();
  const [editError, setEditError] = useState('');
  const [withdrawalOpen, setWithdrawalOpen] = useState(false);
  const [withdrawalError, setWithdrawalError] = useState('');
  const [withdrawalAttempt, setWithdrawalAttempt] = useState<{ requestId: string; version: number; reason: string; key: string } | null>(null);
  const withdrawButtonRef = useRef<HTMLButtonElement>(null);
  const modalWasOpen = useRef(false);
  const editForm = useForm<RequestFormValues>({
    defaultValues: formValues(item),
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const withdrawalForm = useForm<WithdrawalFormValues>({ defaultValues: { reason: '' }, mode: 'onSubmit', reValidateMode: 'onChange' });
  const values = useWatch({ control: editForm.control }) as RequestFormValues;
  const groupsQuery = useRequestSelectionQuery(localUserId, 'groups');
  const profilesQuery = useRequestSelectionQuery(localUserId, 'resource-profiles');
  const initiativesQuery = useRequestSelectionQuery(localUserId, 'initiatives');
  const groups = useMemo(() => rowsFromPages(groupsQuery.data), [groupsQuery.data]);
  const profiles = useMemo(() => rowsFromPages(profilesQuery.data), [profilesQuery.data]);
  const initiatives = useMemo(() => rowsFromPages(initiativesQuery.data), [initiativesQuery.data]);
  const selectedGroupId = values?.groupId ?? '';
  const groupProfiles = profiles.filter((profile) => profile.groupId === selectedGroupId);

  const updateMutation = useMutation({
    mutationFn: (input: { requestId: string; version: number; patch: Parameters<typeof updateRequest>[3] }) =>
      updateRequest(localUserId, input.requestId, input.version, input.patch),
  });
  const withdrawMutation = useMutation({
    mutationFn: (input: { requestId: string; version: number; reason: string; idempotencyKey: string }) =>
      withdrawRequest(localUserId, input.requestId, input.version, input.reason, input.idempotencyKey),
  });
  const guardWithdrawalClose = useNavigationFormProtection(
    'request withdrawal',
    withdrawalForm.formState.isDirty,
    withdrawalForm.formState.isSubmitting || withdrawMutation.isPending,
  );
  useNavigationFormProtection('request edit', editForm.formState.isDirty, editForm.formState.isSubmitting || updateMutation.isPending);

  const canEdit = canEditCurrentRequest && formVersion !== null && !formVersionChanged;

  function closeWithdrawal() {
    guardWithdrawalClose(() => {
      withdrawalForm.reset({ reason: '' });
      setWithdrawalError('');
      setWithdrawalOpen(false);
    });
  }

  useEffect(() => {
    if (modalWasOpen.current && !withdrawalOpen) withdrawButtonRef.current?.focus();
    modalWasOpen.current = withdrawalOpen;
  }, [withdrawalOpen]);

  async function onEdit(valuesToSave: RequestFormValues) {
    if (!canEdit || formVersion === null) return;
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
    const original = item.requestedConditions;
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
      const updated = await updateMutation.mutateAsync({ requestId: item.id, version: formVersion, patch });
      const updatedDetail: ResourceRequestItem = { ...item, ...updated };
      queryClient.setQueryData<ResourceRequestItem>([...REQUESTS_QUERY_ROOT, localUserId, 'detail', item.id], updatedDetail);
      editForm.reset(formValues(updatedDetail));
      onVersionChange(updated.version);
      onNotice('Your request was updated. The original submission and expiry dates were preserved.');
      await invalidateRequestSurfaces(queryClient, { localUserId, requestId: item.id });
    } catch (error) {
      if (hasAccessError(error)) {
        onAccessDenied();
        return;
      }
      setEditError(issueMutationError(error));
      if (error instanceof RequestApiError && error.status === 412) {
        setEditError('This request changed while you were editing. Your text is preserved; reload the latest version before saving again.');
        onRefreshLatest();
      }
    }
  }

  async function onWithdraw(valuesToSave: WithdrawalFormValues) {
    if (!canEdit || formVersion === null) return;
    setWithdrawalError('');
    const previousAttempt = withdrawalAttempt;
    const idempotencyKey = previousAttempt
      && previousAttempt.requestId === item.id
      && previousAttempt.version === formVersion
      && previousAttempt.reason === valuesToSave.reason
      ? previousAttempt.key
      : createUuid();
    setWithdrawalAttempt({ requestId: item.id, version: formVersion, reason: valuesToSave.reason, key: idempotencyKey });
    try {
      const event = await withdrawMutation.mutateAsync({ requestId: item.id, version: formVersion, reason: valuesToSave.reason, idempotencyKey });
      setWithdrawalAttempt(null);
      setWithdrawalOpen(false);
      withdrawalForm.reset({ reason: '' });
      onWithdrawn(event);
      onNotice('Your request was withdrawn. Its operational details were removed and its audit record was retained.');
      await invalidateRequestSurfaces(queryClient, { localUserId, requestId: item.id });
    } catch (error) {
      if (hasAccessError(error)) {
        onAccessDenied();
        return;
      }
      setWithdrawalError(issueMutationError(error));
      if (error instanceof RequestApiError && error.status === 412) {
        setWithdrawalError('This request changed while the confirmation was open. Your reason is preserved; reload the latest version before withdrawing.');
        onRefreshLatest();
      }
    }
  }

  async function reloadLatestRequest() {
    const latest = await onReloadLatest();
    if (latest) {
      editForm.reset(formValues(latest));
      setEditError('');
      setWithdrawalError('');
    }
  }

  return (
    <>
      {formVersionChanged && (
        <div className="form-error" role="alert">
          <p>A newer version is available. Your form values are preserved; reload the latest version before editing or withdrawing.</p>
          <button type="button" className="secondary-button" onClick={() => void reloadLatestRequest()} disabled={editForm.formState.isSubmitting}>Load current request</button>
        </div>
      )}
      {listRefreshFailed && <p className="field-help">Actions are paused until your request list refreshes successfully.</p>}
      <form className="request-edit-form" onSubmit={editForm.handleSubmit(onEdit)}>
        <div className="request-form-grid">
          <label className="form-field">
            <span>ITDM</span>
            <select value={values?.initiativeId ?? ''} disabled={!canEdit || editForm.formState.isSubmitting} {...editForm.register('initiativeId', { required: 'Select an ITDM.' })}>
              <option value="">Select an ITDM</option>
              {initiatives.map((initiative) => <option key={initiative.id} value={initiative.id}>{initiative.code} · {initiative.name}</option>)}
            </select>
            {editForm.formState.errors.initiativeId?.message && <span className="field-error">{editForm.formState.errors.initiativeId.message}</span>}
          </label>
          <label className="form-field">
            <span>Category</span>
            <select value={values?.category ?? 'EXECUTION_PROJECT'} disabled={!canEdit || editForm.formState.isSubmitting} {...editForm.register('category', { required: 'Select a category.' })}>
              {categoryOptions.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span>Group</span>
            <select value={values?.groupId ?? ''} disabled={!canEdit || editForm.formState.isSubmitting} {...editForm.register('groupId', { required: 'Select a group.' })}>
              <option value="">Select a group</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
            {editForm.formState.errors.groupId?.message && <span className="field-error">{editForm.formState.errors.groupId.message}</span>}
          </label>
          <label className="form-field">
            <span>Resource profile</span>
            <select value={values?.resourceProfileId ?? ''} disabled={!canEdit || editForm.formState.isSubmitting} {...editForm.register('resourceProfileId', { required: 'Select a resource profile.' })}>
              <option value="">Select a resource profile</option>
              {groupProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            {editForm.formState.errors.resourceProfileId?.message && <span className="field-error">{editForm.formState.errors.resourceProfileId.message}</span>}
          </label>
          <label className="form-field">
            <span>Start date</span>
            <input type="date" disabled={!canEdit || editForm.formState.isSubmitting} {...editForm.register('startDate', { required: 'Enter a start date.' })} />
            {editForm.formState.errors.startDate?.message && <span className="field-error">{editForm.formState.errors.startDate.message}</span>}
          </label>
          <label className="form-field">
            <span>End date</span>
            <input type="date" disabled={!canEdit || editForm.formState.isSubmitting} {...editForm.register('endDate', { required: 'Enter an end date.' })} />
            {editForm.formState.errors.endDate?.message && <span className="field-error">{editForm.formState.errors.endDate.message}</span>}
          </label>
          <label className="form-field">
            <span>Weekly hours</span>
            <input
              inputMode="decimal"
              disabled={!canEdit || editForm.formState.isSubmitting}
              aria-invalid={Boolean(editForm.formState.errors.weeklyHours)}
              {...editForm.register('weeklyHours', { required: 'Enter weekly hours.', validate: (raw) => normalizeWeeklyHours(raw).error ?? true })}
            />
            <span className="field-help">More than 0 and up to 40 hours. One decimal place is used after rounding.</span>
            {editForm.formState.errors.weeklyHours?.message && <span className="field-error">{editForm.formState.errors.weeklyHours.message}</span>}
          </label>
          <label className="form-field request-comment-field">
            <span>Comment <span className="optional-label">(optional)</span></span>
            <textarea maxLength={2000} disabled={!canEdit || editForm.formState.isSubmitting} {...editForm.register('comment')} />
            <span className="field-help">Up to 2,000 characters.</span>
          </label>
        </div>
        {editError && <div className="form-error" role="alert"><p>{editError}</p></div>}
        <div className="form-actions request-actions">
          <button type="submit" className="primary-button" disabled={!canEdit || editForm.formState.isSubmitting}>
            {editForm.formState.isSubmitting ? 'Saving…' : 'Save request changes'}
          </button>
          <button ref={withdrawButtonRef} type="button" className="secondary-button" disabled={!canEdit || withdrawalForm.formState.isSubmitting} onClick={() => { setWithdrawalError(''); setWithdrawalOpen(true); }}>
            Withdraw request
          </button>
        </div>
      </form>

      {withdrawalOpen && (
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
                if (!withdrawalForm.formState.isSubmitting) closeWithdrawal();
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
            <form onSubmit={withdrawalForm.handleSubmit(onWithdraw)}>
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
                <button type="button" className="secondary-button" onClick={closeWithdrawal} disabled={withdrawalForm.formState.isSubmitting}>Keep request</button>
                <button type="submit" className="primary-button" disabled={!canEdit || withdrawalForm.formState.isSubmitting}>
                  {withdrawalForm.formState.isSubmitting ? 'Withdrawing…' : 'Confirm withdrawal'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
