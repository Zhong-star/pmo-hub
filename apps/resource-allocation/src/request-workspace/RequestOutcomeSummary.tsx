import { type RequestDecisionState, type ResourceRequestItem } from '../requestApi';
import { formatBusinessTimestamp } from '../timeAndHours';
import { requestResponsibleLabel, revalidationImpedimentLabel, revalidationOriginLabel } from '../revalidation';
import { enumLabel } from '../labels';

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

export function RequestMetadata({ item, confirmationLabel }: { item: ResourceRequestItem; confirmationLabel: string | null }) {
  return (
    <div className="request-metadata">
      <span><strong>Decision</strong>{decisionStates.find((state) => state.value === item.decisionState)?.label ?? item.decisionState}</span>
      <span><strong>Submitted</strong>{formatBusinessTimestamp(item.receivedAt)}</span>
      <span><strong>Waiting expiry</strong>{formatBusinessTimestamp(item.expirationDueAt)}</span>
      {item.decisionState === 'APPROVED_WITH_CHANGES' && item.dueAt && <span><strong>Response deadline (São Paulo)</strong>{formatBusinessTimestamp(item.dueAt)}</span>}
      {confirmationLabel && <span><strong>Confirmation</strong>{confirmationLabel}</span>}
      <span><strong>Version</strong>{item.version}</span>
    </div>
  );
}

export function RequestRevalidationStatus({ item }: { item: ResourceRequestItem }) {
  if (item.decisionState !== 'REQUIRES_REVALIDATION') return null;
  return (
    <section className="request-detail-outcome request-proposal-status" aria-label="Revalidation status">
      <h4>Requires revalidation</h4>
      <p>This request requires revalidation. The previous proposal cannot be accepted. A decision maker must review eligible conditions before a new decision is issued.</p>
      {item.revalidation && (
        <>
          <p><strong>Origin:</strong> {revalidationOriginLabel(item.revalidation.originState)}</p>
          {item.revalidation.impediments.length > 0 && (
            <div>
              <strong>Current blockers:</strong>
              <ul>{item.revalidation.impediments.map((impediment) => <li key={impediment}>{revalidationImpedimentLabel(impediment)}</li>)}</ul>
            </div>
          )}
          <p><strong>Next responsible:</strong> {requestResponsibleLabel(item.revalidation.nextResponsible)}</p>
        </>
      )}
    </section>
  );
}

export function RequestOutcomeDetails({ item }: { item: ResourceRequestItem }) {
  const conditions = item.requestedConditions;
  return (
    <>
      <section className="request-detail-outcome" aria-label="Requested conditions">
        <h4>Requested conditions</h4>
        <dl className="request-queue-details">
          <div><dt>Group</dt><dd>{conditions.groupName ?? 'Group unavailable'}</dd></div>
          <div><dt>Resource profile</dt><dd>{conditions.resourceProfileName ?? 'Profile unavailable'}</dd></div>
          <div><dt>Period</dt><dd>{conditions.startDate ?? '—'} to {conditions.endDate ?? '—'}</dd></div>
          <div><dt>Weekly hours</dt><dd>{conditions.weeklyHours ?? '—'} hours per week</dd></div>
        </dl>
      </section>

      {item.approvedConditions && (
        <section className="request-detail-outcome" aria-label={item.decisionState === 'APPROVED_WITH_CHANGES'
          ? 'Proposed conditions'
          : item.decisionState === 'REQUIRES_REVALIDATION' ? 'Previous proposal' : 'Approved conditions'}>
          <h4>{item.decisionState === 'APPROVED_WITH_CHANGES'
            ? 'Proposed conditions'
            : item.decisionState === 'REQUIRES_REVALIDATION' ? 'Previous proposal' : 'Approved conditions'}</h4>
          <dl className="request-queue-details">
            <div><dt>{item.decisionState === 'REQUIRES_REVALIDATION' ? 'Proposed person' : 'Approved person'}</dt><dd>{item.approvedConditions.personName}</dd></div>
            <div><dt>{item.decisionState === 'REQUIRES_REVALIDATION' ? 'Proposed resource profile' : 'Approved resource profile'}</dt><dd>{item.approvedConditions.resourceProfileName}</dd></div>
            <div><dt>Group</dt><dd>{item.approvedConditions.groupName}</dd></div>
            <div><dt>Period</dt><dd>{item.approvedConditions.startDate} to {item.approvedConditions.endDate}</dd></div>
            <div><dt>Weekly hours</dt><dd>{item.approvedConditions.weeklyHours} hours per week</dd></div>
          </dl>
          {item.approvedConditions.explanation && <p className="request-queue-comment">Approval explanation: {item.approvedConditions.explanation}</p>}
        </section>
      )}

      {item.allocation && (
        <section className="request-detail-outcome" aria-label="Approved allocation">
          <h4>Approved allocation</h4>
          <dl className="request-queue-details">
            <div><dt>Allocated person</dt><dd>{item.allocation.person.displayName}</dd></div>
            <div><dt>Resource profile</dt><dd>{item.allocation.resourceProfile.name}</dd></div>
            <div><dt>Group</dt><dd>{item.allocation.group.name}</dd></div>
            <div><dt>Period</dt><dd>{item.allocation.startDate} to {item.allocation.endDate}</dd></div>
            <div><dt>Weekly hours</dt><dd>{item.allocation.weeklyHours} hours per week</dd></div>
            <div><dt>Allocation state</dt><dd>{enumLabel(item.allocation.state)}</dd></div>
            <div><dt>Approved</dt><dd>{formatBusinessTimestamp(item.allocation.approvedAt)}</dd></div>
          </dl>
        </section>
      )}
    </>
  );
}
