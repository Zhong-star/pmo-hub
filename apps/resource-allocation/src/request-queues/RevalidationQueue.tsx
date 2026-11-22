import { useState } from 'react';
import { approveRequest, correctRequestReferences, referRequest, removeRequestAdministratively } from '../requestQueueApi';
import { denyRequest } from '../requestDecisionApi';
import { DenialAction } from '../DenialAction';
import { revalidationImpedimentLabel, revalidationOriginLabel } from '../revalidation';
import { ApprovalForm, ReferenceCorrectionForm, type ApprovalDecision, type ReferenceCorrectionValues } from './forms';
import { RequestAdministrativeRemoval, RequestReferralActions } from './ReferralRemovalActions';
import { readRequestValue, RequestQueueCard, RequestQueueFilterPanel, RequestQueueResults, useQueueAccessGuard, useQueueActionRunner, useQueueDeepLink, useQueueSelections, useRequestQueueQuery, type QueueFilterValues, type QueueVerticalProps } from './shared';

type RevalidationAction = 'approval' | 'denial' | 'correction' | 'removal';

function initialFilters(): QueueFilterValues {
  const params = new URLSearchParams(window.location.search);
  return {
    ...(params.get('groupId') ? { groupId: params.get('groupId')! } : {}),
    ...(params.get('initiativeId') ? { initiativeId: params.get('initiativeId')! } : {}),
    ...(params.get('resourceProfileId') ? { resourceProfileId: params.get('resourceProfileId')! } : {}),
  };
}

function updateLocation(filters: QueueFilterValues) {
  const params = new URLSearchParams(window.location.search);
  params.set('queue', 'revalidation');
  params.delete('decisionState');
  for (const name of ['groupId', 'initiativeId', 'resourceProfileId'] as const) {
    if (filters[name]) params.set(name, filters[name]!);
    else params.delete(name);
  }
  const search = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
}

export function RevalidationQueue(props: QueueVerticalProps) {
  const { localUserId, personId, role, selectedRequestId, onAccessDenied } = props;
  const [filters, setFilters] = useState<QueueFilterValues>(initialFilters);
  const [openApprovalId, setOpenApprovalId] = useState<string | null>(null);
  const [openDenialId, setOpenDenialId] = useState<string | null>(null);
  const [openCorrectionId, setOpenCorrectionId] = useState<string | null>(null);
  const [openRemovalId, setOpenRemovalId] = useState<string | null>(null);
  const query = useRequestQueueQuery(localUserId, 'revalidation', filters);
  const { items, missing } = useQueueDeepLink(query, selectedRequestId);
  useQueueAccessGuard(query, onAccessDenied);
  const runner = useQueueActionRunner(localUserId, onAccessDenied);
  const activeFormRequestId = openApprovalId ?? openCorrectionId;
  const activeItem = activeFormRequestId ? items.find((item) => item.id === activeFormRequestId) : undefined;
  const groupId = activeItem ? readRequestValue(activeItem, 'groupId') : null;
  const selections = useQueueSelections(localUserId, true, groupId, openApprovalId ?? undefined, onAccessDenied);
  const actionsBlocked = query.isError && !query.isFetchNextPageError;

  function persistFilters(next: QueueFilterValues) {
    setFilters(next);
    updateLocation(next);
  }

  function toggle(itemId: string, action: RevalidationAction) {
    runner.setActionError(null);
    if (action === 'correction') {
      setOpenApprovalId(null);
      setOpenDenialId(null);
      setOpenRemovalId(null);
      setOpenCorrectionId((current) => current === itemId ? null : itemId);
    } else if (action === 'denial') {
      setOpenCorrectionId(null);
      setOpenApprovalId(null);
      setOpenRemovalId(null);
      setOpenDenialId((current) => current === itemId ? null : itemId);
    } else if (action === 'approval') {
      setOpenCorrectionId(null);
      setOpenDenialId(null);
      setOpenRemovalId(null);
      setOpenApprovalId((current) => current === itemId ? null : itemId);
    } else {
      setOpenCorrectionId(null);
      setOpenDenialId(null);
      setOpenApprovalId(null);
      setOpenRemovalId((current) => current === itemId ? null : itemId);
    }
  }

  function closeForms() {
    setOpenApprovalId(null);
    setOpenDenialId(null);
    setOpenCorrectionId(null);
    setOpenRemovalId(null);
  }

  async function run(item: (typeof items)[number], actionName: string, payload: Record<string, unknown>, action: (key: string) => Promise<unknown>) {
    if (await runner.performAction(item, actionName, payload, action)) closeForms();
  }

  return (
    <RequestQueueResults
      query={query}
      items={items}
      label="Revalidation queue"
      selectedRequestId={selectedRequestId}
      deepLinkMissing={missing}
      actionError={runner.actionError}
      renderItem={(item) => {
        const busy = runner.pendingRequestIds.has(item.id);
        const disabled = busy || actionsBlocked;
        return (
          <RequestQueueCard key={item.id} item={item} queueLabel="Eligibility revalidation" highlighted={item.id === selectedRequestId}>
            <p className="request-revalidation-origin"><strong>Origin:</strong> {revalidationOriginLabel(item.originState ?? undefined)}</p>
            {(item.impediments?.length ?? 0) > 0 && (
              <div className="form-error request-exception-impediments" role="status">
                <p>Review these conditions before final approval:</p>
                <ul>{item.impediments?.map((impediment) => <li key={impediment}>{revalidationImpedimentLabel(impediment)}</li>)}</ul>
              </div>
            )}
            {item.approvedConditions && (
              <section className="request-detail-outcome request-revalidation-previous-proposal" aria-label="Previous proposal">
                <h4>Previous proposal</h4>
                <dl className="request-queue-details">
                  <div><dt>Proposed person</dt><dd>{item.approvedConditions.personName}</dd></div>
                  <div><dt>Proposed resource profile</dt><dd>{item.approvedConditions.resourceProfileName}</dd></div>
                  <div><dt>Period</dt><dd>{item.approvedConditions.startDate} to {item.approvedConditions.endDate}</dd></div>
                  <div><dt>Weekly hours</dt><dd>{item.approvedConditions.weeklyHours} hours per week</dd></div>
                </dl>
                {item.approvedConditions.explanation && <p><strong>Previous decision explanation:</strong> {item.approvedConditions.explanation}</p>}
              </section>
            )}
            <RequestReferralActions
              item={item}
              personId={personId}
              role={role}
              busy={busy}
              disabled={disabled}
              openRemoval={openRemovalId === item.id}
              onRemovalToggle={() => toggle(item.id, 'removal')}
              onRefer={() => void run(item, 'referral', {}, (key) => referRequest(localUserId, item.id, item.version, key))}
            />
            {item.availableActions.includes('REFERENCE_CORRECTION') && (
              <div className="request-queue-actions">
                <button type="button" className="secondary-button" aria-expanded={openCorrectionId === item.id} onClick={() => toggle(item.id, 'correction')} disabled={disabled}>Correct references</button>
              </div>
            )}
            {item.availableActions.includes('DENY') && (
              <DenialAction item={item} disabled={disabled} open={openDenialId === item.id} onToggle={() => toggle(item.id, 'denial')} onSubmit={(explanation) => run(item, 'denial', { explanation }, (key) => denyRequest(localUserId, item.id, item.version, key, explanation))} />
            )}
            {item.availableActions.includes('APPROVE') && (
              <div className="request-queue-actions">
                <button type="button" className="primary-button" aria-expanded={openApprovalId === item.id} onClick={() => toggle(item.id, 'approval')} disabled={disabled}>{busy ? 'Approving request…' : 'Approve request'}</button>
              </div>
            )}
            {openCorrectionId === item.id && selections.data && <ReferenceCorrectionForm item={item} selections={selections.data} disabled={disabled} onSubmit={(correction: ReferenceCorrectionValues) => run(item, 'reference-correction', { ...correction }, (key) => correctRequestReferences(localUserId, item.id, item.version, key, correction))} />}
            {openCorrectionId === item.id && selections.isPending && <p className="supporting-copy" role="status">Loading active reference choices…</p>}
            {openCorrectionId === item.id && selections.error != null && <p className="form-error" role="alert">Reference choices could not be loaded. Close this form and try again.</p>}
            {openRemovalId === item.id && <RequestAdministrativeRemoval disabled={disabled} onSubmit={(reason) => run(item, 'administrative-removal', { reason }, (key) => removeRequestAdministratively(localUserId, item.id, item.version, key, reason))} />}
            {openApprovalId === item.id && selections.data && <ApprovalForm item={item} selections={selections.data} disabled={disabled} onSubmit={(approval: ApprovalDecision) => run(item, 'approval', approval, (key) => approveRequest(localUserId, item.id, item.version, key, approval))} />}
            {openApprovalId === item.id && selections.isPending && <p className="supporting-copy" role="status">Loading eligible people and active profiles…</p>}
            {openApprovalId === item.id && selections.error != null && <p className="form-error" role="alert">Eligible people and profiles could not be loaded. Close this form and try again.</p>}
          </RequestQueueCard>
        );
      }}
    >
      <RequestQueueFilterPanel filters={filters} selections={selections.data} disabled={selections.isPending} label="Filter revalidation requests" onChange={persistFilters} />
    </RequestQueueResults>
  );
}
