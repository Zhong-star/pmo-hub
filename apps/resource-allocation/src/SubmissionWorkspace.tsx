import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFieldArray, useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { PlusIcon, RefreshCwIcon } from '../../shared-ui/src/Icons';
import { NOTIFICATIONS_QUERY_ROOT } from './notificationsApi';
import { REQUESTS_QUERY_ROOT } from './requestApi';
import { REQUEST_QUEUES_QUERY_ROOT } from './requestQueueApi';
import { useNavigationFormProtection } from './NavigationProtection';
import { businessDate, formatBusinessTimestamp, normalizeWeeklyHours } from './timeAndHours';
import {
  createSubmission,
  getSelectionCollection,
  getSubmission,
  getSubmissionCollection,
  getSubmissionLines,
  SELECTIONS_QUERY_ROOT,
  SUBMISSIONS_QUERY_ROOT,
  SubmissionRequestError,
  type CreateSubmissionInput,
  type RequestCategory,
  type SelectionItem,
  type SubmissionLine,
  type SubmissionSummary,
} from './submissionApi';

interface SubmissionWorkspaceProps {
  localUserId: string;
  onAccessDenied: () => void;
}

interface RequestLineDraft {
  groupId: string;
  resourceProfileId: string;
  startDate: string;
  endDate: string;
  weeklyHours: string;
  comment: string;
}

interface SubmissionFormValues {
  initiativeId: string;
  category: RequestCategory | '';
  lines: RequestLineDraft[];
}

interface StoredEnvelope {
  idempotencyKey: string;
  payload: CreateSubmissionInput;
  savedAt: string;
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

function outboxStorageKey(localUserId: string) {
  return `pmo-hub.resource-allocation.submission-outbox:${encodeURIComponent(localUserId)}`;
}

function readOutbox(localUserId: string): StoredEnvelope | null {
  try {
    const stored = window.localStorage.getItem(outboxStorageKey(localUserId));
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<StoredEnvelope>;
    if (typeof value.idempotencyKey !== 'string' || !value.payload || typeof value.savedAt !== 'string') return null;
    return value as StoredEnvelope;
  } catch {
    return null;
  }
}

function saveOutbox(localUserId: string, envelope: StoredEnvelope) {
  try {
    window.localStorage.setItem(outboxStorageKey(localUserId), JSON.stringify(envelope));
  } catch {
    // The form remains usable; the warning below explains whether receipt recovery is durable locally.
  }
}

function clearOutbox(localUserId: string) {
  try {
    window.localStorage.removeItem(outboxStorageKey(localUserId));
  } catch {
    // Clearing a browser-only recovery copy must not interrupt the server flow.
  }
}

function todayLocalDate() {
  return businessDate();
}

function createUuid() {
  return window.crypto.randomUUID();
}

function rowsFromPages<T>(data: { pages: Array<{ items: T[] }> } | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

function useSelectionQuery<C extends 'groups' | 'resource-profiles' | 'initiatives'>(localUserId: string, collection: C) {
  return useInfiniteQuery({
    queryKey: [...SELECTIONS_QUERY_ROOT, localUserId, collection],
    queryFn: ({ pageParam }) => getSelectionCollection(collection, localUserId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

function hasAccessError(error: unknown) {
  return error instanceof SubmissionRequestError && (error.status === 401 || error.status === 403);
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
            value={selectedProfileId}
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
                const startDate = getValues('startDate');
                if (!value) return true;
                if (value < todayLocalDate()) return 'End date must be today or later.';
                return !startDate || value >= startDate || 'End date cannot be before the start date.';
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

function submissionStatus(status: string) {
  if (status === 'SUCCEEDED') return 'Succeeded';
  if (status === 'FAILED') return 'Failed';
  return 'Pending';
}

function lineFailureMessage(problem: SubmissionLine['problem']): string {
  return problem?.message?.trim()
    || problem?.detail?.trim()
    || problem?.title?.trim()
    || 'This request line failed and can be corrected.';
}

function SubmissionResults({
  localUserId,
  submissionId,
  onRetryLine,
  onAccessDenied,
  groups,
  profiles,
}: {
  localUserId: string;
  submissionId: string;
  onRetryLine: (submission: SubmissionSummary, line: SubmissionLine) => void;
  onAccessDenied: () => void;
  groups: SelectionItem<'groups'>[];
  profiles: SelectionItem<'resource-profiles'>[];
}) {
  const detailQuery = useQuery({
    queryKey: [...SUBMISSIONS_QUERY_ROOT, localUserId, submissionId],
    queryFn: () => getSubmission(localUserId, submissionId),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const linesQuery = useQuery({
    queryKey: [...SUBMISSIONS_QUERY_ROOT, localUserId, submissionId, 'lines'],
    queryFn: () => getSubmissionLines(localUserId, submissionId),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const lines = linesQuery.data?.items ?? [];
  const count = lines.length;

  useEffect(() => {
    if (hasAccessError(detailQuery.error) || hasAccessError(linesQuery.error)) onAccessDenied();
  }, [detailQuery.error, linesQuery.error, onAccessDenied]);

  return (
    <section className="submission-results" aria-labelledby="submission-results-heading">
      <div className="submission-results-heading">
        <div>
          <h3 id="submission-results-heading">Submission results</h3>
          <p className="field-help">Submission ID: <code>{submissionId}</code></p>
        </div>
        <button
          type="button"
          className="secondary-button ui-inline-btn"
          onClick={() => { void detailQuery.refetch(); void linesQuery.refetch(); }}
          disabled={detailQuery.isFetching || linesQuery.isFetching}
        >
          <RefreshCwIcon size={15} />
          <span>Refresh results</span>
        </button>
      </div>

      {detailQuery.isPending && <p role="status">Loading submission details…</p>}
      {detailQuery.isError && (
        <div className="form-error" role="alert">
          <p>Submission details could not be loaded. Refresh to check the latest result.</p>
          <button type="button" className="text-button" onClick={() => void detailQuery.refetch()}>Try again</button>
        </div>
      )}
      {detailQuery.data && (
        <div className="submission-summary-strip">
          <span>Received {formatBusinessTimestamp(detailQuery.data.receivedAt)}</span>
          <span>{detailQuery.data.counts.succeeded} succeeded</span>
          <span>{detailQuery.data.counts.failed} failed</span>
          <span>{detailQuery.data.counts.received + detailQuery.data.counts.processing} pending</span>
        </div>
      )}
      {linesQuery.isPending && <p role="status">Loading line results…</p>}
      {linesQuery.isError && (
        <div className="form-error" role="alert">
          <p>Line results could not be loaded. Your submission remains saved. Try again.</p>
          <button type="button" className="text-button" onClick={() => void linesQuery.refetch()}>Try again</button>
        </div>
      )}
      {linesQuery.isSuccess && count === 0 && <p className="empty-state">No request lines are available yet.</p>}
      {linesQuery.isSuccess && count > 0 && (
        <div className="submission-line-results">
          {lines.map((line, index) => {
            const outcomeState = typeof line.requestOutcome === 'string'
              ? line.requestOutcome
              : line.requestOutcome?.decisionState
                ?? (line.requestOutcome?.status === 'REMOVED'
                  ? `Removed from operation${line.requestOutcome.action ? ` · ${line.requestOutcome.action.toLowerCase().replaceAll('_', ' ')}` : ''}`
                  : line.requestOutcome?.status);
            const outcomeConditions = typeof line.requestOutcome === 'object'
              ? line.requestOutcome.requestedConditions
              : undefined;
            const displayedHours = outcomeConditions?.weeklyHours ?? line.submittedConditions.weeklyHours;
            const groupName = groups.find((group) => group.id === line.submittedConditions.groupId)?.name
              ?? line.submittedConditions.groupId;
            const profileName = profiles.find((profile) => profile.id === line.submittedConditions.resourceProfileId)?.name
              ?? line.submittedConditions.resourceProfileId;
            return (
              <article className="submission-result-row" key={line.id}>
                <div className="submission-result-topline">
                  <h4>Request line {index + 1}</h4>
                  <span className={`status-badge status-badge-${line.status.toLowerCase()}`}>
                    {submissionStatus(line.status)}
                  </span>
                </div>
                <p className="submission-result-conditions">
                  <strong>{groupName}</strong> · {profileName} · {line.submittedConditions.startDate} to {line.submittedConditions.endDate}
                  · {displayedHours} hours per week
                </p>
                {line.submittedConditions.comment && <p className="submission-result-comment">{line.submittedConditions.comment}</p>}
                {line.status === 'SUCCEEDED' && line.requestId && <p className="submission-result-detail">Request created: <code>{line.requestId}</code></p>}
                {line.status === 'SUCCEEDED' && outcomeState && <p className="submission-result-detail">Current outcome: {outcomeState}</p>}
                {line.requestOutcome && typeof line.requestOutcome === 'object' && line.requestOutcome.status === 'REMOVED' && line.requestId && (
                  <>
                    {line.requestOutcome.reason && <p className="submission-result-detail">Removal reason: {line.requestOutcome.reason}</p>}
                    <p className="submission-result-detail"><a href={`/resource-allocation/?page=requests&auditId=${encodeURIComponent(line.requestId)}`}>Open retained audit record</a></p>
                  </>
                )}
                {line.status === 'FAILED' && (
                  <div className="submission-failure-detail">
                    <p>{lineFailureMessage(line.problem)}</p>
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={`Correct and retry failed line ${index + 1}`}
                      onClick={() => detailQuery.data && onRetryLine(detailQuery.data, line)}
                    >
                      Correct and retry failed line
                    </button>
                  </div>
                )}
                {(line.status === 'RECEIVED' || line.status === 'PROCESSING') && (
                  <p className="submission-result-detail" role="status">This line is still processing and cannot be edited yet.</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function SubmissionWorkspace({ localUserId, onAccessDenied }: SubmissionWorkspaceProps) {
  const queryClient = useQueryClient();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [notice, setNotice] = useState('');
  const [sendError, setSendError] = useState('');
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
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

  const groupsQuery = useSelectionQuery(localUserId, 'groups');
  const profilesQuery = useSelectionQuery(localUserId, 'resource-profiles');
  const initiativesQuery = useSelectionQuery(localUserId, 'initiatives');
  const submissionsQuery = useInfiniteQuery({
    queryKey: [...SUBMISSIONS_QUERY_ROOT, localUserId],
    queryFn: ({ pageParam }) => getSubmissionCollection(localUserId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const groups = useMemo(() => rowsFromPages<SelectionItem<'groups'>>(groupsQuery.data), [groupsQuery.data]);
  const profiles = useMemo(() => rowsFromPages<SelectionItem<'resource-profiles'>>(profilesQuery.data), [profilesQuery.data]);
  const initiatives = useMemo(() => rowsFromPages<SelectionItem<'initiatives'>>(initiativesQuery.data), [initiativesQuery.data]);
  const submissions = useMemo(() => rowsFromPages<SubmissionSummary>(submissionsQuery.data), [submissionsQuery.data]);

  const createMutation = useMutation({
    mutationFn: (envelope: StoredEnvelope) => createSubmission(localUserId, envelope.payload, envelope.idempotencyKey),
  });
  const guardSubmissionClose = useNavigationFormProtection('submission', isDirty || lineDirty, createMutation.isPending);

  const selectionAccessError = hasAccessError(groupsQuery.error)
    || hasAccessError(profilesQuery.error)
    || hasAccessError(initiativesQuery.error)
    || hasAccessError(submissionsQuery.error);

  useEffect(() => {
    if (selectionAccessError) {
      clearOutbox(localUserId);
      onAccessDenied();
    }
  }, [localUserId, onAccessDenied, selectionAccessError]);

  const effectiveSubmissionId = selectedSubmissionId && submissions.some((submission) => submission.id === selectedSubmissionId)
    ? selectedSubmissionId
    : submissions[0]?.id ?? null;

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
    setNotice('');
    setOutbox(envelope);
    saveOutbox(localUserId, envelope);
    try {
      const receipt = await createMutation.mutateAsync(envelope);
      clearOutbox(localUserId);
      setOutbox(null);
      setReviewMode(false);
      setNotice(`Submission ${receipt.id} was received. Line processing can continue after you close this page.`);
      setSelectedSubmissionId(receipt.id);
      reset(defaultValues);
      clearLineEditor();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...SUBMISSIONS_QUERY_ROOT, localUserId] }),
        queryClient.invalidateQueries({ queryKey: [...SUBMISSIONS_QUERY_ROOT, localUserId, receipt.id] }),
        queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_ROOT }),
        queryClient.invalidateQueries({ queryKey: REQUEST_QUEUES_QUERY_ROOT }),
        queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_ROOT }),
      ]);
    } catch (error) {
      if (hasAccessError(error)) {
        clearOutbox(localUserId);
        setOutbox(null);
        onAccessDenied();
        return;
      }
      if (error instanceof SubmissionRequestError && (error.status === 400 || error.status === 422)) {
        clearOutbox(localUserId);
        setOutbox(null);
        reportServerFieldErrors(error);
      }
      setSendError(requestErrorMessage(error));
    }
  }

  const onReview = handleSubmit(() => {
    if (linePending || lineSubmitting || fields.length === 0) return;
    setReviewMode(true);
    setSendError('');
    setNotice('');
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

  function retryFailedLine(_submission: SubmissionSummary, line: SubmissionLine) {
    const initiativeId = line.submittedConditions.initiativeId;
    const category = line.submittedConditions.category;
    if (outbox || line.status !== 'FAILED' || !initiativeId || !category) return;
    guardSubmissionClose(() => {
      setSendError('');
      setNotice('');
      setReviewMode(false);
      setValue('initiativeId', initiativeId, { shouldDirty: true, shouldValidate: true });
      setValue('category', category, { shouldDirty: true, shouldValidate: true });
      replace([]);
      setEditingIndex(null);
      lineForm.reset({
        groupId: line.submittedConditions.groupId,
        resourceProfileId: line.submittedConditions.resourceProfileId,
        startDate: line.submittedConditions.startDate,
        endDate: line.submittedConditions.endDate,
        weeklyHours: String(line.submittedConditions.weeklyHours),
        comment: line.submittedConditions.comment ?? '',
      }, { keepDefaultValues: true });
      document.getElementById('new-request-batch')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function recoverOutbox() {
    if (!outbox) return;
    await submitStoredEnvelope(outbox);
  }

  const allQueries = [groupsQuery, profilesQuery, initiativesQuery];
  const selectionLoading = allQueries.some((query) => query.isPending);
  const selectionFetching = allQueries.some((query) => query.isFetching);
  const selectionFetchingNextPage = allQueries.some((query) => query.isFetchingNextPage);
  const hasSelectionError = allQueries.some((query) => query.isError && !query.isFetchNextPageError && !hasAccessError(query.error));
  const hasSelectionNextPageError = allQueries.some((query) => query.isFetchNextPageError && !hasAccessError(query.error));
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

  return (
    <section className="submission-workspace" aria-label="Request submissions">
      <div id="new-request-batch" className="submission-panel" aria-labelledby="new-submission-heading">
        <div className="submission-panel-heading">
          <div>
            <h2 id="new-submission-heading">New request batch</h2>
            <p className="supporting-copy">Prepare up to 100 request lines, review the final hours, then send them together.</p>
          </div>
        </div>

        {notice && <p className="inline-success" role="status">{notice}</p>}
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
                      <span>{fields.length} of 100</span>
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
                <div className="submission-review-bar">
                  <div role="status">
                    <strong>{fields.length} request{fields.length === 1 ? '' : 's'} added</strong>
                    {linePending && <p className="field-help">Save or discard the current line before reviewing.</p>}
                  </div>
                  <button form="request-batch-review" type="submit" className="primary-button" disabled={isSubmitting || lineSubmitting || linePending || fields.length === 0}>
                    Review submission
                  </button>
                </div>
              </>
            ) : (
              <form className="submission-review" aria-labelledby="submission-review-heading" onSubmit={onSend} noValidate>
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
                <div className="form-actions submission-actions">
                  <button type="button" className="secondary-button" onClick={() => setReviewMode(false)} disabled={isSubmitting}>
                    Edit requests
                  </button>
                  <button type="submit" className="primary-button" disabled={isSubmitting}>
                    {isSubmitting ? 'Sending…' : `Send ${values.lines.length} request${values.lines.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>

      <section className="submission-panel" aria-labelledby="my-submissions-heading">
        <div className="submission-panel-heading">
          <div>
            <p className="eyebrow">Saved sends</p>
            <h2 id="my-submissions-heading">My submissions</h2>
            <p className="supporting-copy">Review line results and continue processing after closing this page.</p>
          </div>
          <button type="button" className="secondary-button" onClick={() => void submissionsQuery.refetch()} disabled={submissionsQuery.isFetching}>
            Refresh submissions
          </button>
        </div>

        {submissionsQuery.isPending && <p role="status">Loading your submissions…</p>}
        {submissionsQuery.isError && !submissionsQuery.isFetchNextPageError && !hasAccessError(submissionsQuery.error) && (
          <div className="form-error" role="alert">
            <p>Saved submissions could not be loaded. You can retry without losing the current form.</p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void submissionsQuery.refetch()}
                  disabled={submissionsQuery.isFetching}
                >
                  Try again
                </button>
          </div>
        )}
        {submissionsQuery.isSuccess && submissions.length === 0 && (
          <p className="empty-state">No request batches have been sent yet.</p>
        )}
        {submissions.length > 0 && (
          <>
            <div className="submission-list" aria-label="Saved submissions">
              {submissions.map((submission) => (
                <button
                  key={submission.id}
                  type="button"
                  className={`submission-list-item${effectiveSubmissionId === submission.id ? ' submission-list-item-selected' : ''}`}
                  aria-pressed={effectiveSubmissionId === submission.id}
                  onClick={() => setSelectedSubmissionId(submission.id)}
                >
                  <span className="submission-list-title">
                    <strong>Request batch</strong>
                    <small>{submission.id}</small>
                  </span>
                  <span>{formatBusinessTimestamp(submission.receivedAt)}</span>
                  <span>{submission.counts.succeeded} succeeded · {submission.counts.failed} failed</span>
                  <span>{submission.counts.received + submission.counts.processing} pending</span>
                </button>
              ))}
            </div>
            {submissionsQuery.hasNextPage && (
              <button
                type="button"
                className="secondary-button load-submissions-button"
                onClick={() => void submissionsQuery.fetchNextPage()}
                disabled={submissionsQuery.isFetching || (submissionsQuery.isError && !submissionsQuery.isFetchNextPageError)}
              >
                {submissionsQuery.isFetchingNextPage ? 'Loading…' : 'Load more submissions'}
              </button>
            )}
            {submissionsQuery.isFetchNextPageError && (
              <div className="form-error load-more-error" role="alert">
                <p>More saved submissions could not be loaded. Existing results are still available.</p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void submissionsQuery.fetchNextPage()}
                  disabled={submissionsQuery.isFetching || (submissionsQuery.isError && !submissionsQuery.isFetchNextPageError)}
                >
                  Try again
                </button>
              </div>
            )}
            {effectiveSubmissionId && (
              <SubmissionResults
                key={effectiveSubmissionId}
                localUserId={localUserId}
                submissionId={effectiveSubmissionId}
                onRetryLine={retryFailedLine}
                onAccessDenied={onAccessDenied}
                groups={groups}
                profiles={profiles}
              />
            )}
          </>
        )}
      </section>
    </section>
  );
}
