import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRequestAudit, REQUESTS_QUERY_ROOT } from '../requestApi';
import { formatBusinessTimestamp } from '../timeAndHours';
import { hasAccessError } from './shared';

export function RequestAudit({
  localUserId,
  requestId,
  onClose,
  onAccessDenied,
}: {
  localUserId: string;
  requestId: string | null;
  onClose: () => void;
  onAccessDenied: () => void;
}) {
  const auditQuery = useQuery({
    queryKey: [...REQUESTS_QUERY_ROOT, localUserId, 'audit', requestId],
    queryFn: () => getRequestAudit(localUserId, requestId!),
    enabled: requestId !== null,
    retry: false,
  });

  useEffect(() => {
    if (hasAccessError(auditQuery.error)) onAccessDenied();
  }, [auditQuery.error, onAccessDenied]);

  if (!requestId) return null;

  return (
    <section className="request-audit" aria-labelledby="request-audit-title">
      <div className="request-detail-heading">
        <div>
          <p className="eyebrow">Immutable record</p>
          <h3 id="request-audit-title">Request audit</h3>
          <p>{requestId}</p>
        </div>
        <button type="button" className="secondary-button" onClick={onClose}>Close audit</button>
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
          <p><strong>When:</strong> {formatBusinessTimestamp(event.occurredAt)}</p>
          <p><strong>Reason:</strong> {event.reason}</p>
          <p><strong>Requester:</strong> {String(event.requesterSnapshot.displayName ?? 'Requester')}</p>
          <div className="request-audit-conditions">
            <strong>Saved request conditions</strong>
            <p>{String(event.requestSnapshot.requestedConditions && (event.requestSnapshot.requestedConditions as Record<string, unknown>).initiativeCode)} · {String(event.requestSnapshot.requestedConditions && (event.requestSnapshot.requestedConditions as Record<string, unknown>).groupName)} · {String(event.requestSnapshot.requestedConditions && (event.requestSnapshot.requestedConditions as Record<string, unknown>).resourceProfileName)}</p>
          </div>
        </article>
      ))}
    </section>
  );
}
