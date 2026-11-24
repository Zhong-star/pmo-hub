import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigationFormProtection } from './NavigationProtection';
import { NOTIFICATIONS_QUERY_ROOT } from './notificationsApi';
import { cancelRequest, contestRequest, getRequestHistory, RequestDecisionApiError, type RequestDecisionResult } from './requestDecisionApi';
import { REQUESTS_QUERY_ROOT, type ResourceRequestItem } from './requestApi';
import { REQUEST_QUEUES_QUERY_ROOT } from './requestQueueApi';
import { SUBMISSIONS_QUERY_ROOT } from './submissionApi';
import { formatBusinessTimestamp } from './timeAndHours';
import { enumLabel } from './labels';

interface DeniedRequestResponseProps {
  localUserId: string;
  item: ResourceRequestItem;
  readOnly?: boolean;
  disabled: boolean;
  onChanged: (item: RequestDecisionResult) => void;
  onAccessDenied: () => void;
}

interface ResponseValues { explanation: string; }
type ResponseAction = 'contest' | 'cancel';

function hasAccessError(error: unknown): boolean {
  return error instanceof RequestDecisionApiError && (error.status === 401 || error.status === 403);
}

function createIdempotencyKey(identity: string): string {
  const storageKey = `pmo-hub.resource-allocation.denial-response.${identity}`;
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
  } catch {
    // Continue with a key that remains stable for the current mount.
  }
  const key = window.crypto.randomUUID();
  try {
    window.sessionStorage.setItem(storageKey, key);
  } catch {
    // The action still has server-side conditional writes if storage is unavailable.
  }
  return key;
}

function actionKey(localUserId: string, item: ResourceRequestItem, action: ResponseAction, explanation: string): string {
  const canonical = JSON.stringify([localUserId, item.id, item.version, action, explanation.trim()]);
  return createIdempotencyKey(encodeURIComponent(canonical));
}

export function DeniedRequestResponse({ localUserId, item, readOnly = false, disabled, onChanged, onAccessDenied }: DeniedRequestResponseProps) {
  const queryClient = useQueryClient();
  const changedProposal = item.decisionState === 'APPROVED_WITH_CHANGES';
  const requiresRevalidation = item.decisionState === 'REQUIRES_REVALIDATION';
  const canContest = item.availableActions?.includes('CONTEST') === true;
  const canCancel = item.availableActions?.includes('CANCEL') === true;
  const canContestChangedProposal = changedProposal && canContest;
  const canContestDenial = item.decisionState === 'DENIED' && canContest;
  const canCancelDenial = item.decisionState === 'DENIED' && canCancel;
  const canCancelRevalidation = requiresRevalidation && canCancel;
  const showResponseActions = !readOnly && (canContestChangedProposal || canContestDenial || canCancelDenial || canCancelRevalidation);
  const needsHistory = readOnly || (!changedProposal && !requiresRevalidation);
  const [activeAction, setActiveAction] = useState<ResponseAction | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const form = useForm<ResponseValues>({ defaultValues: { explanation: '' }, mode: 'onSubmit', reValidateMode: 'onChange' });
  const guardResponseClose = useNavigationFormProtection('denied request response', form.formState.isDirty, form.formState.isSubmitting);
  const historyQuery = useQuery({
    queryKey: [...REQUESTS_QUERY_ROOT, localUserId, 'history', item.id],
    queryFn: () => getRequestHistory(localUserId, item.id),
    enabled: needsHistory,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const denialEvent = historyQuery.data?.latestDenial
    ?? [...(historyQuery.data?.items ?? [])].reverse().find((event) => event.action === 'DENIED');
  const latestResponse = historyQuery.data?.latestResponse;
  const responseEvents = latestResponse
    ? [latestResponse]
    : historyQuery.data?.items.filter((event) =>
      event.action === 'CONTESTED' || event.action === 'DENIAL_CANCELLED' || event.action === 'DENIAL_AUTO_CANCELLED') ?? [];
  const actionDisabled = disabled || (needsHistory && historyQuery.isError);

  function closeAction() {
    guardResponseClose(() => {
      form.reset({ explanation: '' });
      setErrorMessage('');
      setActiveAction(null);
    });
  }

  async function submit(values: ResponseValues) {
    if (!activeAction || disabled) return;
    const explanation = values.explanation.trim();
    setErrorMessage('');
    try {
      const key = actionKey(localUserId, item, activeAction, explanation);
      const updated = activeAction === 'contest'
        ? await contestRequest(localUserId, item.id, item.version, key, explanation)
        : await cancelRequest(localUserId, item.id, item.version, key, explanation);
      onChanged(updated);
      setActiveAction(null);
      form.reset({ explanation: '' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...REQUESTS_QUERY_ROOT, localUserId, 'history', item.id] }),
        queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_ROOT }),
        queryClient.invalidateQueries({ queryKey: REQUEST_QUEUES_QUERY_ROOT }),
        queryClient.invalidateQueries({ queryKey: SUBMISSIONS_QUERY_ROOT }),
        queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_ROOT }),
      ]);
    } catch (error) {
      if (hasAccessError(error)) {
        onAccessDenied();
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : 'The response could not be saved. Your explanation is still available.');
      if (error instanceof RequestDecisionApiError && error.status === 412) {
        setErrorMessage('This request changed while you were responding. Your explanation is preserved; reload the latest request before trying again.');
        void queryClient.invalidateQueries({ queryKey: [...REQUESTS_QUERY_ROOT, localUserId, 'detail', item.id] });
      }
    }
  }

  return (
    <section className="request-denial-response" aria-labelledby={`denial-response-title-${item.id}`}>
      <h4 id={`denial-response-title-${item.id}`}>{readOnly ? 'Request history' : requiresRevalidation ? 'Revalidation response' : changedProposal ? 'Respond to proposed conditions' : 'Decision history'}</h4>
      {needsHistory && historyQuery.isPending && <p role="status">Loading decision history…</p>}
      {needsHistory && historyQuery.isError && (
        <div className="form-error" role="alert">
          <p>The decision history could not be loaded. Protected details are not shown.</p>
          <button type="button" className="secondary-button" onClick={() => void historyQuery.refetch()} disabled={historyQuery.isFetching}>Try again</button>
        </div>
      )}
      {readOnly && historyQuery.data?.items.map((event) => (
        <article className="request-denial-response-event" key={event.id}>
          <p><strong>{enumLabel(event.action)}:</strong> {event.reason ?? 'No reason was recorded.'}</p>
          <p><strong>By:</strong> {String(event.actorSnapshot.displayName ?? 'System')}</p>
          <p><strong>When:</strong> {formatBusinessTimestamp(event.occurredAt)}</p>
        </article>
      ))}
      {!readOnly && needsHistory && denialEvent && (
        <article className="request-denial-explanation">
          <p><strong>Denied by:</strong> {String(denialEvent.actorSnapshot.displayName ?? 'Decision maker')}</p>
          <p><strong>When:</strong> {formatBusinessTimestamp(denialEvent.occurredAt)}</p>
          <p><strong>Explanation:</strong> {denialEvent.reason ?? 'No explanation was recorded.'}</p>
        </article>
      )}
      {!readOnly && needsHistory && responseEvents.map((event) => (
        <article className="request-denial-response-event" key={event.id}>
          <p><strong>{enumLabel(event.action)}:</strong> {event.reason ?? 'No reason was recorded.'}</p>
          <p><strong>When:</strong> {formatBusinessTimestamp(event.occurredAt)}</p>
        </article>
      ))}

      {showResponseActions && (
        <>
          <p className="field-help">{requiresRevalidation
            ? 'You may cancel this request while the eligibility issue is reviewed. Revalidation does not expire automatically.'
            : changedProposal
              ? 'You may contest these changed conditions within the response window. Your explanation will start a Pre N3 review; no allocation exists yet.'
              : 'You may contest this denial to start a Pre N3 review, or cancel the request. Respond within 14 days.'}</p>
          {!activeAction && (
            <div className="form-actions request-actions">
              {(canContestChangedProposal || canContestDenial) && (
                <button type="button" className="primary-button" disabled={actionDisabled} onClick={() => { setErrorMessage(''); setActiveAction('contest'); }}>
                  {changedProposal ? 'Contest proposed changes' : 'Contest denial'}
                </button>
              )}
              {(canCancelDenial || canCancelRevalidation) && (
                <button type="button" className="secondary-button" disabled={actionDisabled} onClick={() => { setErrorMessage(''); setActiveAction('cancel'); }}>
                  Cancel request
                </button>
              )}
            </div>
          )}
          {activeAction && (
            <form className="request-response-form" onSubmit={form.handleSubmit(submit)}>
              <h5>{activeAction === 'contest' ? changedProposal ? 'Contest these proposed conditions' : 'Contest this denial' : 'Cancel this request'}</h5>
              <p>{activeAction === 'contest'
                ? 'Your explanation will move the request to Pre N3 for Admin review.'
                : requiresRevalidation
                  ? 'Cancellation is final. Your reason remains in the request history.'
                  : 'Cancellation is final. The denial and your reason remain in the request history.'}</p>
              <label className="form-field">
                <span>{activeAction === 'contest' ? 'Reason for contesting' : 'Reason for cancellation'}</span>
                <textarea
                  maxLength={2000}
                  aria-invalid={Boolean(form.formState.errors.explanation)}
                  {...form.register('explanation', {
                    required: 'Enter an explanation before continuing.',
                    validate: (value) => value.trim().length > 0 || 'Enter an explanation before continuing.',
                  })}
                />
                <span className="field-help">Required · up to 2,000 characters.</span>
                {form.formState.errors.explanation?.message && <span className="field-error">{form.formState.errors.explanation.message}</span>}
              </label>
              {errorMessage && <div className="form-error" role="alert"><p>{errorMessage}</p></div>}
              <div className="form-actions request-actions">
                <button type="button" className="secondary-button" onClick={closeAction} disabled={form.formState.isSubmitting}>Keep request</button>
                <button type="submit" className="primary-button" disabled={actionDisabled || form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? 'Saving…' : activeAction === 'contest' ? 'Submit contest' : 'Confirm cancellation'}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
