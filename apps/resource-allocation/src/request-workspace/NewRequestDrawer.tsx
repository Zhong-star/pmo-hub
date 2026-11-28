import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useFieldArray, useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { PlusIcon, XIcon } from '../../../shared-ui/src/Icons';
import { NOTIFICATIONS_QUERY_ROOT } from '../notificationsApi';
import { REQUESTS_QUERY_ROOT } from '../requestApi';
import { REQUEST_QUEUES_QUERY_ROOT } from '../requestQueueApi';
import { useNavigationFormProtection, useNavigationProtection } from '../NavigationProtection';
import { businessDate, normalizeWeeklyHours } from '../timeAndHours';
import {
  createSubmission,
  SUBMISSIONS_QUERY_ROOT,
  SubmissionRequestError,
  type RequestCategory,
  type SelectionItem,
  type SubmissionReceipt,
} from '../submissionApi';
import { clearOutbox, hasSubmissionAccessError, readOutbox, saveOutbox, type StoredEnvelope } from '../submissionOutbox';
import { rowsFromPages, useRequestSelectionQuery } from './shared';

export interface RequestLineDraft {
  groupId: string;
  resourceProfileId: string;
  startDate: string;
  endDate: string;
  weeklyHours: string;
  comment: string;
}

export interface RetryLineDraft {
  key: string;
  initiativeId: string;
  category: RequestCategory;
  line: RequestLineDraft;
}

interface NewRequestDrawerProps {
  open: boolean;
  localUserId: string;
  retryDraft: RetryLineDraft | null;
  onRetryDraftConsumed: () => void;
  onClose: () => void;
  onSubmitted: (receipt: SubmissionReceipt) => void;
  onOutboxChange: (hasOutbox: boolean) => void;
  onAccessDenied: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

interface SubmissionFormValues {
  initiativeId: string;
  category: RequestCategory | '';
  lines: RequestLineDraft[];
}

const categoryOptions: Array<{ value: RequestCategory; label: string }> = [
  { value: 'DEMAND_ANALYSIS', label: 'Demand Analysis' },
  { value: 'POC_BBP', label: 'POC/BBP' },
  { value: 'EXECUTION_PROJECT', label: 'Execution — Project' },
  { value: 'EXECUTION_FAST_TRACK', label: 'Execution — Fast track' },
  { value: 'EXECUTION_ENHANCEMENT', label: 'Execution — Enhancement' },
];

const blankLine = (): RequestLineDraft => ({
  groupId: '',
  resourceProfileId: '',
  startDate: '',
  endDate: '',
  weeklyHours: '',
  comment: '',
});

const defaultValues: SubmissionFormValues = { initiativeId: '', category: '', lines: [] };

function todayLocalDate() {
  return businessDate();
}

function createUuid() {
  return window.crypto.randomUUID();
}

function requestErrorMessage(error: unknown) {
  if (error instanceof SubmissionRequestError) {
    if (error.status === 400 || error.status === 422) {
      return error.message || 'The batch could not be accepted. Review the fields and try again.';
    }
    if (error.status === 409) {
      return 'This send key already has a different result. Keep this batch unchanged and refresh My submissions before trying again.';
    }
  }
  return 'The receipt could not be confirmed. Keep this page open or recover the same submission after reloading.';
}

function LineEditor({
  form,
  index,
  groups,
  profiles,
  disabled,
  children,
}: {
  form: UseFormReturn<RequestLineDraft>;
  index: number;
  groups: SelectionItem<'groups'>[];
  profiles: SelectionItem<'resource-profiles'>[];
  disabled: boolean;
  children: React.ReactNode;
}) {
  const { control, register, setValue, getValues, formState: { errors: rowErrors } } = form;
  const [selectedGroupId, selectedProfileId, startDate] = useWatch({
    control,
    name: ['groupId', 'resourceProfileId', 'startDate'],
  });
  const eligibleProfiles = profiles.filter((profile) => profile.groupId === selectedGroupId);

  return (
    <fieldset className="submission-line-card" disabled={disabled}>
      <legend>Request line {index + 1}</legend>
      <div className="submission-line-grid">
        <label className="form-field submission-line-full-field">
          <span>Group</span>
          <select
            aria-label={`Group for line ${index + 1}`}
            {...register('groupId', {
              required: 'Choose a group.',
              onChange: () => setValue('resourceProfileId', '', { shouldDirty: true, shouldValidate: true }),
            })}
            aria-invalid={Boolean(rowErrors?.groupId)}
            value={selectedGroupId ?? ''}
          >
            <option value="">Choose a group</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          {rowErrors?.groupId?.message && <span className="field-error">{rowErrors.groupId.message}</span>}
        </label>

        <label className="form-field submission-line-full-field">
          <span>Resource profile</span>
          <select
            aria-label={`Resource profile for line ${index + 1}`}
            {...register('resourceProfileId', {
              required: 'Choose a resource profile.',
              validate: (value) => !value || eligibleProfiles.some((profile) => profile.id === value)
                || 'Choose a profile in the selected group.',
            })}
            aria-invalid={Boolean(rowErrors?.resourceProfileId)}
            disabled={!selectedGroupId}
            value={selectedProfileId ?? ''}
          >
            <option value="">Choose a resource profile</option>
            {eligibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
          {rowErrors?.resourceProfileId?.message && <span className="field-error">{rowErrors.resourceProfileId.message}</span>}
        </label>

        <label className="form-field">
          <span>Start date</span>
          <input
            type="date"
            aria-label={`Start date for line ${index + 1}`}
            min={todayLocalDate()}
            {...register('startDate', {
              required: 'Choose a start date.',
              validate: (value) => !value || value >= todayLocalDate() || 'Start date must be today or later.',
            })}
            aria-invalid={Boolean(rowErrors?.startDate)}
          />
          {rowErrors?.startDate?.message && <span className="field-error">{rowErrors.startDate.message}</span>}
        </label>

        <label className="form-field">
          <span>End date</span>
          <input
            type="date"
            aria-label={`End date for line ${index + 1}`}
            min={startDate || todayLocalDate()}
            {...register('endDate', {
              required: 'Choose an end date.',
              validate: (value) => {
                const startDateValue = getValues('startDate');
                if (!value) return true;
                if (value < todayLocalDate()) return 'End date must be today or later.';
                return !startDateValue || value >= startDateValue || 'End date cannot be before the start date.';
              },
            })}
            aria-invalid={Boolean(rowErrors?.endDate)}
          />
          {rowErrors?.endDate?.message && <span className="field-error">{rowErrors.endDate.message}</span>}
        </label>

        <label className="form-field submission-line-full-field">
          <span>Weekly hours</span>
          <input
            type="text"
            inputMode="decimal"
            aria-label={`Weekly hours for line ${index + 1}`}
            placeholder="e.g. 20 or 20,5"
            {...register('weeklyHours', {
              required: 'Enter weekly hours.',
              validate: (value) => normalizeWeeklyHours(value).error ?? true,
            })}
            aria-invalid={Boolean(rowErrors?.weeklyHours)}
          />
          <span className="field-help">More than 0 and up to 40 hours. One decimal place is used after rounding.</span>
          {rowErrors?.weeklyHours?.message && <span className="field-error">{rowErrors.weeklyHours.message}</span>}
        </label>

        <label className="form-field submission-line-full-field">
          <span>Comment <span className="optional-label">(optional)</span></span>
          <textarea
            aria-label={`Comment for line ${index + 1}`}
            rows={3}
            maxLength={2000}
            {...register('comment', {
              maxLength: { value: 2000, message: 'Comments may contain up to 2,000 characters.' },
            })}
            aria-invalid={Boolean(rowErrors?.comment)}
          />
          <span className="field-help">Up to 2,000 characters.</span>
          {rowErrors?.comment?.message && <span className="field-error">{rowErrors.comment.message}</span>}
        </label>
      </div>
      {children}
    </fieldset>
  );
}

function NewRequestDrawerContent({
  localUserId,
  retryDraft,
  onRetryDraftConsumed,
  onClose,
  onSubmitted,
  onOutboxChange,
  onAccessDenied,
  returnFocusRef,
}: Omit<NewRequestDrawerProps, 'open'>) {
  const queryClient = useQueryClient();
  const { notice: navigationNotice } = useNavigationProtection();
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mouseDownOnBackdropRef = useRef(false);
  const appliedRetryKeyRef = useRef<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [sendError, setSendError] = useState('');
  const [outbox, setOutbox] = useState<StoredEnvelope | null>(() => readOutbox(localUserId));

  const form = useForm<SubmissionFormValues>({
    defaultValues,
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const { control, register, setValue, getValues, handleSubmit, reset, setError, formState: { errors, isSubmitting, isDirty } } = form;
  const values = useWatch({ control }) as SubmissionFormValues;
  const { fields, append, remove, replace, update } = useFieldArray({ control, name: 'lines' });

  const lineForm = useForm<RequestLineDraft>({ defaultValues: blankLine() });
  const { isDirty: lineDirty, isSubmitting: lineSubmitting } = lineForm.formState;
  const linePending = lineDirty || editingIndex !== null;

  function clearLineEditor() {
    lineForm.reset(blankLine());
    setEditingIndex(null);
  }

  const groupsQuery = useRequestSelectionQuery(localUserId, 'groups');
  const profilesQuery = useRequestSelectionQuery(localUserId, 'resource-profiles');
  const initiativesQuery = useRequestSelectionQuery(localUserId, 'initiatives');

  const groups = useMemo(() => rowsFromPages<SelectionItem<'groups'>>(groupsQuery.data), [groupsQuery.data]);
  const profiles = useMemo(() => rowsFromPages<SelectionItem<'resource-profiles'>>(profilesQuery.data), [profilesQuery.data]);
  const initiatives = useMemo(() => rowsFromPages<SelectionItem<'initiatives'>>(initiativesQuery.data), [initiativesQuery.data]);

  const createMutation = useMutation({
    mutationFn: (envelope: StoredEnvelope) => createSubmission(localUserId, envelope.payload, envelope.idempotencyKey),
  });
  const guardSubmissionClose = useNavigationFormProtection('submission', isDirty || lineDirty, createMutation.isPending);

  const selectionAccessError = hasSubmissionAccessError(groupsQuery.error)
    || hasSubmissionAccessError(profilesQuery.error)
    || hasSubmissionAccessError(initiativesQuery.error);

  useEffect(() => {
    if (selectionAccessError) {
      clearOutbox(localUserId);
      onOutboxChange(false);
      onAccessDenied();
    }
  }, [localUserId, onAccessDenied, onOutboxChange, selectionAccessError]);

  useEffect(() => {
    const targetToRestore = returnFocusRef.current;
    closeButtonRef.current?.focus();
    return () => {
      if (targetToRestore?.isConnected) {
        targetToRestore.focus();
      }
    };
  }, [returnFocusRef]);

  useEffect(() => {
    if (!retryDraft || appliedRetryKeyRef.current === retryDraft.key || outbox) return;
    appliedRetryKeyRef.current = retryDraft.key;
    setSendError('');
    setReviewMode(false);
    setValue('initiativeId', retryDraft.initiativeId, { shouldDirty: true, shouldValidate: true });
    setValue('category', retryDraft.category, { shouldDirty: true, shouldValidate: true });
    replace([]);
    setEditingIndex(null);
    lineForm.reset(retryDraft.line, { keepDefaultValues: true });
    onRetryDraftConsumed();
  }, [lineForm, onRetryDraftConsumed, outbox, replace, retryDraft, setValue]);

  function handleRequestClose() {
    guardSubmissionClose(() => onClose());
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleRequestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const container = drawerRef.current;
    if (!container) return;
    const focusable = [...container.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]',
    )].filter((element) => element.tabIndex >= 0
      && !element.matches(':disabled, input[type="hidden"]')
      && !element.closest('[hidden], [inert]')
      && getComputedStyle(element).visibility === 'visible'
      && getComputedStyle(element).display !== 'none');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const isOutside = !container.contains(document.activeElement);
    if (event.shiftKey && (document.activeElement === first || isOutside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || isOutside)) {
      event.preventDefault();
      first.focus();
    }
  }

  function reportServerFieldErrors(error: unknown) {
    if (!(error instanceof SubmissionRequestError)) return;
    for (const fieldError of error.problem?.errors ?? []) {
      const path = fieldError.path?.split('.').at(-1);
      if (path === 'initiativeId' || path === 'category') {
        setError(path, { type: 'server', message: fieldError.message ?? 'Review this field.' });
      }
    }
  }

  async function submitStoredEnvelope(envelope: StoredEnvelope) {
    setSendError('');
    setOutbox(envelope);
    onOutboxChange(true);
    saveOutbox(localUserId, envelope);
    try {
      const receipt = await createMutation.mutateAsync(envelope);
      clearOutbox(localUserId);
      setOutbox(null);
      onOutboxChange(false);
      setReviewMode(false);
      reset(defaultValues);
      clearLineEditor();
      onSubmitted(receipt);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: [...SUBMISSIONS_QUERY_ROOT, localUserId] }),
        queryClient.invalidateQueries({ queryKey: [...SUBMISSIONS_QUERY_ROOT, localUserId, receipt.id] }),
        queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_ROOT }),
        queryClient.invalidateQueries({ queryKey: REQUEST_QUEUES_QUERY_ROOT }),
        queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_ROOT }),
      ]);
    } catch (error) {
      if (hasSubmissionAccessError(error)) {
        clearOutbox(localUserId);
        setOutbox(null);
        onOutboxChange(false);
        onAccessDenied();
        return;
      }
      if (error instanceof SubmissionRequestError && (error.status === 400 || error.status === 422)) {
        clearOutbox(localUserId);
        setOutbox(null);
        onOutboxChange(false);
        reportServerFieldErrors(error);
      }
      setSendError(requestErrorMessage(error));
    }
  }

  const onReview = handleSubmit(() => {
    if (linePending || lineSubmitting || fields.length === 0) return;
    setReviewMode(true);
    setSendError('');
  });

  const onSend = handleSubmit(async (submittedValues) => {
    if (outbox) return;
    if (submittedValues.lines.length < 1 || submittedValues.lines.length > 100) return;
    const normalizedLines = submittedValues.lines.map((line) => ({
      attemptKey: createUuid(),
      groupId: line.groupId,
      resourceProfileId: line.resourceProfileId,
      startDate: line.startDate,
      endDate: line.endDate,
      weeklyHours: normalizeWeeklyHours(line.weeklyHours).value ?? 0,
      ...(line.comment.trim() ? { comment: line.comment.trim() } : {}),
    }));
    if (!submittedValues.category) return;
    const envelope: StoredEnvelope = {
      idempotencyKey: createUuid(),
      payload: { initiativeId: submittedValues.initiativeId, category: submittedValues.category, lines: normalizedLines },
      savedAt: new Date().toISOString(),
    };
    await submitStoredEnvelope(envelope);
  });

  const saveLine = lineForm.handleSubmit((line) => {
    if (editingIndex !== null) {
      update(editingIndex, line);
    } else if (fields.length < 100) {
      append(line, { shouldFocus: false });
    }
    clearLineEditor();
    requestAnimationFrame(() => lineForm.setFocus('groupId'));
  });

  async function recoverOutbox() {
    if (!outbox) return;
    await submitStoredEnvelope(outbox);
  }

  const allQueries = [groupsQuery, profilesQuery, initiativesQuery];
  const selectionLoading = allQueries.some((query) => query.isPending);
  const selectionFetching = allQueries.some((query) => query.isFetching);
  const selectionFetchingNextPage = allQueries.some((query) => query.isFetchingNextPage);
  const hasSelectionError = allQueries.some((query) => query.isError && !query.isFetchNextPageError && !hasSubmissionAccessError(query.error));
  const hasSelectionNextPageError = allQueries.some((query) => query.isFetchNextPageError && !hasSubmissionAccessError(query.error));
  const selectionLoadMore = allQueries.some((query) => query.hasNextPage || query.isFetchNextPageError);

  function loadMoreSelections() {
    for (const query of allQueries) {
      if ((query.hasNextPage || query.isFetchNextPageError) && !query.isFetching && !(query.isError && !query.isFetchNextPageError)) {
        void query.fetchNextPage();
      }
    }
  }

  const selectedInitiative = initiatives.find((initiative) => initiative.id === values.initiativeId);
  const selectedCategoryLabel = categoryOptions.find((option) => option.value === values.category)?.label;
  const totalWeeklyHours = fields.reduce((sum, field) => sum + (normalizeWeeklyHours(field.weeklyHours).value ?? 0), 0);

  return createPortal(
    <div
      className="request-drawer-backdrop"
      onMouseDown={(event) => {
        mouseDownOnBackdropRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const shouldClose = mouseDownOnBackdropRef.current && event.target === event.currentTarget;
        mouseDownOnBackdropRef.current = false;
        if (shouldClose) handleRequestClose();
      }}
    >
      <section
        ref={drawerRef}
        id="new-request-batch"
        className="request-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-submission-heading"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="request-drawer__header">
          <div className="request-drawer__title">
            <h2 id="new-submission-heading">New request batch</h2>
            <p className="supporting-copy">Prepare up to 100 request lines, review the final hours, then send them together.</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="request-drawer__close"
            aria-label="Close new request drawer"
            onClick={handleRequestClose}
            disabled={createMutation.isPending}
          >
            <XIcon size={18} />
          </button>
        </header>

        <div className="request-drawer__body">
          {navigationNotice && <p className="supporting-copy" role="status">{navigationNotice}</p>}
          {sendError && <p className="form-error" role="alert">{sendError}</p>}

          {outbox && (
            <div className="unknown-receipt" role="alert">
              <div>
                <h3>Receipt not confirmed</h3>
                <p>The server may have received this batch. Its saved copy is locked until the same send can be recovered safely.</p>
                <p>{outbox.payload.lines.length} request line{outbox.payload.lines.length === 1 ? '' : 's'} · key <code>{outbox.idempotencyKey}</code></p>
              </div>
              <button type="button" className="primary-button" onClick={() => void recoverOutbox()} disabled={isSubmitting || createMutation.isPending}>
                {isSubmitting || createMutation.isPending ? 'Checking receipt…' : 'Recover unconfirmed submission'}
              </button>
            </div>
          )}

          {selectionLoading && <p role="status">Loading active initiatives, groups, and resource profiles…</p>}
          {hasSelectionError && (
            <div className="form-error" role="alert">
              <p>Request options could not be loaded. Your submission history remains available.</p>
              <button
                type="button"
                className="text-button"
                onClick={() => allQueries.forEach((query) => void query.refetch())}
                disabled={selectionFetching}
              >
                Try again
              </button>
            </div>
          )}
          {selectionLoadMore && !outbox && (
            <div className="selection-pagination">
              <button
                type="button"
                className="text-button selection-load-more"
                onClick={loadMoreSelections}
                disabled={selectionFetching || hasSelectionError}
              >
                {selectionFetchingNextPage ? 'Loading more selection options…' : 'Load more selection options'}
              </button>
              {hasSelectionNextPageError && (
                <div className="form-error load-more-error" role="alert">
                  <p>More request options could not be loaded. Options already shown remain available.</p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={loadMoreSelections}
                    disabled={selectionFetching || hasSelectionError}
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
          )}

          {!outbox && !selectionLoading && (
            <div className="submission-form">
              {!reviewMode ? (
                <>
                  <form id="request-batch-review" className="submission-global-fields" onSubmit={onReview} noValidate>
                    <label className="form-field">
                      <span>Initiative (ITDM)</span>
                      <select
                        aria-label="Initiative"
                        {...register('initiativeId', { required: 'Choose an initiative.' })}
                        aria-invalid={Boolean(errors.initiativeId)}
                        value={values.initiativeId ?? ''}
                      >
                        <option value="">Choose an initiative</option>
                        {initiatives.map((initiative) => (
                          <option key={initiative.id} value={initiative.id}>{initiative.code} — {initiative.name}</option>
                        ))}
                      </select>
                      {errors.initiativeId?.message && <span className="field-error">{errors.initiativeId.message}</span>}
                    </label>
                    <label className="form-field">
                      <span>Category</span>
                      <select
                        aria-label="Category"
                        {...register('category', { required: 'Choose a category.' })}
                        aria-invalid={Boolean(errors.category)}
                        value={values.category ?? ''}
                      >
                        <option value="">Choose a category</option>
                        {categoryOptions.map((category) => <option value={category.value} key={category.value}>{category.label}</option>)}
                      </select>
                      {errors.category?.message && <span className="field-error">{errors.category.message}</span>}
                    </label>
                  </form>

                  <div className="submission-composer">
                    <form className="submission-line-form" aria-label="Request line editor" onSubmit={saveLine} noValidate>
                      <LineEditor
                        form={lineForm}
                        index={editingIndex ?? fields.length}
                        groups={groups}
                        profiles={profiles}
                        disabled={editingIndex === null && fields.length >= 100}
                      >
                        <div className="submission-editor-actions">
                          {linePending && (
                            <button type="button" className="secondary-button" onClick={clearLineEditor} disabled={lineSubmitting}>
                              {editingIndex === null ? 'Discard draft' : 'Cancel'}
                            </button>
                          )}
                          <button type="submit" className="primary-button ui-inline-btn" disabled={lineSubmitting || (editingIndex === null && fields.length >= 100)}>
                            {editingIndex === null && <PlusIcon size={15} />}
                            <span>{editingIndex === null ? 'Add request line' : 'Save changes'}</span>
                          </button>
                        </div>
                      </LineEditor>
                    </form>
                    <section className="submission-composer-list" aria-labelledby="request-lines-heading">
                      <div className="submission-lines-heading">
                        <h3 id="request-lines-heading">Request lines</h3>
                        <div className="submission-cart-meta">
                          <span>{fields.length} of 100</span>
                          {fields.length > 0 && (
                            <span className="status-badge status-badge-info tabular-cell">{totalWeeklyHours.toFixed(1)} h/wk total</span>
                          )}
                        </div>
                      </div>
                      {fields.length === 0 && <p className="empty-state">Added requests will appear here.</p>}
                      {fields.map((field, index) => (
                        <article className="submission-result-row" key={field.id} aria-label={`Request line ${index + 1}`}>
                          <div className="submission-result-topline">
                            <h4>{profiles.find((profile) => profile.id === field.resourceProfileId)?.name ?? field.resourceProfileId}</h4>
                            <div className="submission-card-actions">
                              <button
                                type="button"
                                className="text-button"
                                disabled={linePending || lineSubmitting}
                                onClick={() => {
                                  setEditingIndex(index);
                                  lineForm.reset(getValues('lines')[index]);
                                  requestAnimationFrame(() => lineForm.setFocus('groupId'));
                                }}
                              >
                                Edit line {index + 1}
                              </button>
                              <button
                                type="button"
                                className="text-button"
                                disabled={linePending || lineSubmitting}
                                onClick={() => remove(index)}
                              >
                                Remove line {index + 1}
                              </button>
                            </div>
                          </div>
                          <p className="submission-result-conditions">
                            {groups.find((group) => group.id === field.groupId)?.name ?? field.groupId}
                            {' · '}{field.startDate} to {field.endDate}
                            {' · '}{normalizeWeeklyHours(field.weeklyHours).value?.toFixed(1)} hours per week
                          </p>
                          {field.comment.trim() && <p className="submission-result-comment">{field.comment.trim()}</p>}
                        </article>
                      ))}
                    </section>
                  </div>
                </>
              ) : (
                <form id="request-batch-send" className="submission-review" aria-labelledby="submission-review-heading" onSubmit={onSend} noValidate>
                  <div>
                    <p className="eyebrow">Final check</p>
                    <h3 id="submission-review-heading">Review your requests</h3>
                    <p>{selectedInitiative?.code} — {selectedInitiative?.name} · {selectedCategoryLabel}</p>
                  </div>
                  <div className="table-scroll">
                    <table className="admin-table submission-review-table">
                      <thead><tr><th>Line</th><th>Group and profile</th><th>Period</th><th>Weekly hours</th><th>Comment</th></tr></thead>
                      <tbody>
                        {values.lines.map((line, index) => {
                          const group = groups.find((option) => option.id === line.groupId);
                          const profile = profiles.find((option) => option.id === line.resourceProfileId);
                          const weeklyHours = normalizeWeeklyHours(line.weeklyHours).value;
                          return (
                            <tr key={`${line.groupId}:${line.startDate}:${index}`}>
                              <td>{index + 1}</td>
                              <td>{group?.name} · {profile?.name}</td>
                              <td>{line.startDate} to {line.endDate}</td>
                              <td>{weeklyHours?.toFixed(1)} hours per week</td>
                              <td>{line.comment.trim() || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="field-help">The displayed hours are the values that will be saved. Successful lines will not be resent when you correct a failed line.</p>
                </form>
              )}
            </div>
          )}
        </div>

        {!outbox && !selectionLoading && (
          <footer className="request-drawer__footer">
            {!reviewMode ? (
              <>
                <div role="status">
                  <strong>{fields.length} request{fields.length === 1 ? '' : 's'} added</strong>
                  {linePending && <p className="field-help">Save or discard the current line before reviewing.</p>}
                </div>
                <div className="request-drawer__footer-actions">
                  <button type="button" className="secondary-button" onClick={handleRequestClose} disabled={isSubmitting || createMutation.isPending}>
                    Close
                  </button>
                  <button form="request-batch-review" type="submit" className="primary-button" disabled={isSubmitting || lineSubmitting || linePending || fields.length === 0}>
                    Review submission
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="field-help">
                  {values.lines.length} request{values.lines.length === 1 ? '' : 's'} ready to send
                </div>
                <div className="request-drawer__footer-actions">
                  <button type="button" className="secondary-button" onClick={() => setReviewMode(false)} disabled={isSubmitting || createMutation.isPending}>
                    Edit requests
                  </button>
                  <button form="request-batch-send" type="submit" className="primary-button" disabled={isSubmitting || createMutation.isPending}>
                    {isSubmitting || createMutation.isPending ? 'Sending…' : `Send ${values.lines.length} request${values.lines.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              </>
            )}
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}

export function NewRequestDrawer({ open, ...props }: NewRequestDrawerProps) {
  if (!open) return null;
  return <NewRequestDrawerContent {...props} />;
}
