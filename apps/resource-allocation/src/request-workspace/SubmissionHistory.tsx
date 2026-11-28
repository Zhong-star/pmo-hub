import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { RefreshCwIcon } from '../../../shared-ui/src/Icons';
import { formatBusinessTimestamp } from '../timeAndHours';
import {
  getSubmission,
  getSubmissionCollection,
  getSubmissionLines,
  SUBMISSIONS_QUERY_ROOT,
  type SelectionItem,
  type SubmissionLine,
  type SubmissionSummary,
} from '../submissionApi';
import { hasSubmissionAccessError } from '../submissionOutbox';
import { rowsFromPages, useRequestSelectionQuery } from './shared';

interface SubmissionHistoryProps {
  localUserId: string;
  selectedSubmissionId: string | null;
  onSelectSubmission: (submissionId: string) => void;
  notice: string;
  onRetryLine: (submission: SubmissionSummary, line: SubmissionLine) => void;
  onAccessDenied: () => void;
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
    if (hasSubmissionAccessError(detailQuery.error) || hasSubmissionAccessError(linesQuery.error)) onAccessDenied();
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

export function SubmissionHistory({
  localUserId,
  selectedSubmissionId,
  onSelectSubmission,
  notice,
  onRetryLine,
  onAccessDenied,
}: SubmissionHistoryProps) {
  const groupsQuery = useRequestSelectionQuery(localUserId, 'groups');
  const profilesQuery = useRequestSelectionQuery(localUserId, 'resource-profiles');
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
  const submissions = useMemo(() => rowsFromPages<SubmissionSummary>(submissionsQuery.data), [submissionsQuery.data]);

  const accessLost = hasSubmissionAccessError(groupsQuery.error)
    || hasSubmissionAccessError(profilesQuery.error)
    || hasSubmissionAccessError(submissionsQuery.error);

  useEffect(() => {
    if (accessLost) onAccessDenied();
  }, [accessLost, onAccessDenied]);

  const effectiveSubmissionId = selectedSubmissionId && submissions.some((submission) => submission.id === selectedSubmissionId)
    ? selectedSubmissionId
    : submissions[0]?.id ?? null;

  return (
    <section className="submission-panel submission-history-panel" aria-labelledby="my-submissions-heading">
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

      {notice && <p className="inline-success" role="status">{notice}</p>}
      {submissionsQuery.isPending && <p role="status">Loading your submissions…</p>}
      {submissionsQuery.isError && !submissionsQuery.isFetchNextPageError && !hasSubmissionAccessError(submissionsQuery.error) && (
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
                onClick={() => onSelectSubmission(submission.id)}
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
              onRetryLine={onRetryLine}
              onAccessDenied={onAccessDenied}
              groups={groups}
              profiles={profiles}
            />
          )}
        </>
      )}
    </section>
  );
}
