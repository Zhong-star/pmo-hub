import { useState } from 'react';
import { handleTabListKeyDown } from '../tabNavigation';
import { approveRequest, cancelExceptionRequest, correctRequestReferences, escalateRequest, recordExceptionStrategy, referRequest, removeRequestAdministratively, resolveException, type ExceptionResolutionStrategy } from '../requestQueueApi';
import { denyRequest } from '../requestDecisionApi';
import { DenialAction } from '../DenialAction';
import { ExceptionResolutionAction } from '../ExceptionResolutionAction';
import { ExceptionStageAction } from '../ExceptionStageAction';
import { revalidationImpedimentLabel } from '../revalidation';
import { ApprovalForm, ReferenceCorrectionForm, type ApprovalDecision, type ReferenceCorrectionValues } from './forms';
import { RequestAdministrativeRemoval, RequestReferralActions } from './ReferralRemovalActions';
import { optionLabel, readRequestValue, RequestQueueCard, RequestQueueFilterPanel, RequestQueueResults, useQueueAccessGuard, useQueueActionRunner, useQueueDeepLink, useQueueSelections, useRequestQueueQuery, type QueueFilterValues, type QueueVerticalProps } from './shared';

type ExceptionStage = 'PRE_N3' | 'ESCALATION' | null;
type ExceptionAction = 'approval' | 'denial' | 'correction' | 'removal' | 'resolution' | 'escalation' | 'cancellation';

const strategyLabels: Record<ExceptionResolutionStrategy, string> = {
  OUTSOURCE: 'Outsource',
  WAIT_FOR_EMB_RESOURCE: 'Wait for EMB Resource',
  DEPRIORITIZE_OTHER_DEMANDS: 'Deprioritize other demands',
};

function initialStage(): ExceptionStage {
  const value = new URLSearchParams(window.location.search).get('decisionState');
  return value === 'PRE_N3' || value === 'ESCALATION' ? value : null;
}

function initialFilters(): QueueFilterValues {
  const params = new URLSearchParams(window.location.search);
  return {
    ...(params.get('groupId') ? { groupId: params.get('groupId')! } : {}),
    ...(params.get('initiativeId') ? { initiativeId: params.get('initiativeId')! } : {}),
    ...(params.get('resourceProfileId') ? { resourceProfileId: params.get('resourceProfileId')! } : {}),
  };
}

function updateLocation(filters: QueueFilterValues, stage: ExceptionStage) {
  const params = new URLSearchParams(window.location.search);
  params.set('queue', 'exceptions');
  if (stage) params.set('decisionState', stage);
  else params.delete('decisionState');
  for (const name of ['groupId', 'initiativeId', 'resourceProfileId'] as const) {
    if (filters[name]) params.set(name, filters[name]!);
    else params.delete(name);
  }
  const search = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
}

export function ExceptionsQueue(props: QueueVerticalProps) {
  const { localUserId, personId, role, selectedRequestId, onAccessDenied } = props;
  const [stage, setStage] = useState<ExceptionStage>(initialStage);
  const [filters, setFilters] = useState<QueueFilterValues>(initialFilters);
  const [openApprovalId, setOpenApprovalId] = useState<string | null>(null);
  const [openDenialId, setOpenDenialId] = useState<string | null>(null);
  const [openCorrectionId, setOpenCorrectionId] = useState<string | null>(null);
  const [openRemovalId, setOpenRemovalId] = useState<string | null>(null);
  const [openExceptionId, setOpenExceptionId] = useState<string | null>(null);
  const [openEscalationId, setOpenEscalationId] = useState<string | null>(null);
  const [openCancellationId, setOpenCancellationId] = useState<string | null>(null);
  const queryFilters = { ...filters, ...(stage ? { decisionState: stage } : {}) };
  const query = useRequestQueueQuery(localUserId, 'exceptions', queryFilters);
  const { items, missing } = useQueueDeepLink(query, selectedRequestId);
  useQueueAccessGuard(query, onAccessDenied);
  const runner = useQueueActionRunner(localUserId, onAccessDenied);
  const activeFormRequestId = openApprovalId ?? openCorrectionId ?? openExceptionId;
  const activeItem = activeFormRequestId ? items.find((item) => item.id === activeFormRequestId) : undefined;
  const groupId = activeItem ? readRequestValue(activeItem, 'groupId') : null;
  const correctionNeedsPerson = activeItem !== undefined
    && (activeItem.decisionState === 'PRE_N3' || activeItem.decisionState === 'ESCALATION')
    && (activeItem.impediments?.includes('PERSON_INACTIVE') === true || activeItem.impediments?.includes('PERSON_LEFT_GROUP') === true);
  const candidateRequestId = openApprovalId ?? openExceptionId ?? (correctionNeedsPerson ? openCorrectionId ?? undefined : undefined);
  const selections = useQueueSelections(localUserId, true, groupId, candidateRequestId, onAccessDenied);
  const actionsBlocked = query.isError && !query.isFetchNextPageError;

  function persistFilters(next: QueueFilterValues) {
    setFilters(next);
    updateLocation(next, stage);
  }

  function closeForms() {
    setOpenApprovalId(null);
    setOpenDenialId(null);
    setOpenCorrectionId(null);
    setOpenRemovalId(null);
    setOpenExceptionId(null);
    setOpenEscalationId(null);
    setOpenCancellationId(null);
  }

  function toggle(itemId: string, action: ExceptionAction) {
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
    } else if (action === 'removal') {
      setOpenCorrectionId(null);
      setOpenApprovalId(null);
      setOpenDenialId(null);
      setOpenRemovalId((current) => current === itemId ? null : itemId);
    } else if (action === 'resolution') {
      setOpenCorrectionId(null);
      setOpenDenialId(null);
      setOpenApprovalId(null);
      setOpenRemovalId(null);
      setOpenEscalationId(null);
      setOpenCancellationId(null);
      setOpenExceptionId((current) => current === itemId ? null : itemId);
    } else if (action === 'escalation') {
      setOpenCorrectionId(null);
      setOpenDenialId(null);
      setOpenApprovalId(null);
      setOpenRemovalId(null);
      setOpenExceptionId(null);
      setOpenCancellationId(null);
      setOpenEscalationId((current) => current === itemId ? null : itemId);
    } else if (action === 'cancellation') {
      setOpenCorrectionId(null);
      setOpenDenialId(null);
      setOpenApprovalId(null);
      setOpenRemovalId(null);
      setOpenExceptionId(null);
      setOpenEscalationId(null);
      setOpenCancellationId((current) => current === itemId ? null : itemId);
    }
  }

  async function run(item: (typeof items)[number], actionName: string, payload: Record<string, unknown>, action: (key: string) => Promise<unknown>) {
    if (await runner.performAction(item, actionName, payload, action)) closeForms();
  }

  return (
    <RequestQueueResults
      query={query}
      items={items}
      label="Admin exceptions"
      selectedRequestId={selectedRequestId}
      deepLinkMissing={missing}
      actionError={runner.actionError}
      renderItem={(item) => {
        const busy = runner.pendingRequestIds.has(item.id);
        const disabled = busy || actionsBlocked;
        const ownRequest = item.requester.personId === personId;
        const correctionOpen = openCorrectionId === item.id;
        const denialOpen = openDenialId === item.id;
        const approvalOpen = openApprovalId === item.id;
        const removalOpen = openRemovalId === item.id;
        const resolutionOpen = openExceptionId === item.id;
        const escalationOpen = openEscalationId === item.id;
        const cancellationOpen = openCancellationId === item.id;
        const canRecordStrategy = item.availableActions.includes('RECORD_STRATEGY');
        const canResolve = item.availableActions.includes('RESOLVE');
        return (
          <RequestQueueCard key={item.id} item={item} queueLabel="Admin exception review" highlighted={item.id === selectedRequestId}>
            {(item.impediments?.length ?? 0) > 0 && (
              <div className="form-error request-exception-impediments" role="status">
                <p>Review these conditions before final approval:</p>
                <ul>{item.impediments?.map((impediment) => <li key={impediment}>{revalidationImpedimentLabel(impediment)}</li>)}</ul>
              </div>
            )}
            {item.resolutionStrategy && (
              <div className="request-exception-recorded-strategy" role="status">
                <p>Recorded strategy: {strategyLabels[item.resolutionStrategy]}</p>
                {item.resolutionReason && <p><strong>Reason:</strong> {item.resolutionReason}</p>}
                {(item.affectedInitiativeIds?.length ?? 0) > 0 && (
                  <p><strong>Affected ITDMs:</strong> {item.affectedInitiativeIds?.map((id) => {
                    const initiative = selections.data?.initiatives.find((candidate) => candidate.id === id);
                    return initiative ? optionLabel(initiative) : id;
                  }).join(', ')}</p>
                )}
              </div>
            )}
            {ownRequest && <p className="form-error request-queue-impediment" role="status">You cannot resolve your own request.</p>}
            <RequestReferralActions
              item={item}
              personId={personId}
              role={role}
              busy={busy}
              disabled={disabled}
              openRemoval={removalOpen}
              onRemovalToggle={() => toggle(item.id, 'removal')}
              onRefer={() => void run(item, 'referral', {}, (key) => referRequest(localUserId, item.id, item.version, key))}
            />
            {item.availableActions.includes('REFERENCE_CORRECTION') && (
              <div className="request-queue-actions">
                <button type="button" className="secondary-button" aria-expanded={correctionOpen} onClick={() => toggle(item.id, 'correction')} disabled={disabled}>Correct references</button>
              </div>
            )}
            {item.availableActions.includes('DENY') && (
              <DenialAction item={item} disabled={disabled} open={denialOpen} onToggle={() => toggle(item.id, 'denial')} onSubmit={(explanation) => run(item, 'denial', { explanation }, (key) => denyRequest(localUserId, item.id, item.version, key, explanation))} />
            )}
            {item.availableActions.includes('APPROVE') && (
              <div className="request-queue-actions">
                <button type="button" className="primary-button" aria-expanded={approvalOpen} onClick={() => toggle(item.id, 'approval')} disabled={disabled}>{busy ? 'Approving request…' : 'Approve request'}</button>
              </div>
            )}
            {role === 'ALLOCATION_ADMIN' && !ownRequest && (
              <div className="request-queue-actions request-exception-actions">
                {item.availableActions.includes('ESCALATE') && <ExceptionStageAction item={item} action="escalate" disabled={disabled} open={escalationOpen} onToggle={() => toggle(item.id, 'escalation')} onSubmit={(reason) => run(item, 'escalation', { reason }, (key) => escalateRequest(localUserId, item.id, item.version, key, reason))} />}
                {item.availableActions.includes('CANCEL') && <ExceptionStageAction item={item} action="cancel" disabled={disabled} open={cancellationOpen} onToggle={() => toggle(item.id, 'cancellation')} onSubmit={(reason) => run(item, 'exception-cancellation', { reason }, (key) => cancelExceptionRequest(localUserId, item.id, item.version, key, reason))} />}
                {(canRecordStrategy || canResolve) && (
                  <ExceptionResolutionAction
                    item={item}
                    selections={selections.data ?? { groups: [], profiles: [], initiatives: [], people: [] }}
                    canRecord={canRecordStrategy}
                    canResolve={canResolve}
                    disabled={disabled || selections.isPending}
                    open={resolutionOpen}
                    onToggle={() => toggle(item.id, 'resolution')}
                    onRecord={(strategy) => run(item, 'record-strategy', strategy as Record<string, unknown>, (key) => recordExceptionStrategy(localUserId, item.id, item.version, key, strategy))}
                    onResolve={(resolution) => run(item, 'resolve-exception', resolution as Record<string, unknown>, (key) => resolveException(localUserId, item.id, item.version, key, resolution))}
                  />
                )}
              </div>
            )}
            {correctionOpen && selections.data && <ReferenceCorrectionForm item={item} selections={selections.data} disabled={disabled} onSubmit={(correction: ReferenceCorrectionValues) => run(item, 'reference-correction', { ...correction }, (key) => correctRequestReferences(localUserId, item.id, item.version, key, correction))} />}
            {correctionOpen && selections.isPending && <p className="supporting-copy" role="status">Loading active reference choices…</p>}
            {correctionOpen && selections.error != null && <p className="form-error" role="alert">Reference choices could not be loaded. Close this form and try again.</p>}
            {removalOpen && <RequestAdministrativeRemoval disabled={disabled} onSubmit={(reason) => run(item, 'administrative-removal', { reason }, (key) => removeRequestAdministratively(localUserId, item.id, item.version, key, reason))} />}
            {approvalOpen && selections.data && <ApprovalForm item={item} selections={selections.data} disabled={disabled} onSubmit={(approval: ApprovalDecision) => run(item, 'approval', approval, (key) => approveRequest(localUserId, item.id, item.version, key, approval))} />}
            {approvalOpen && selections.isPending && <p className="supporting-copy" role="status">Loading eligible people and active profiles…</p>}
            {approvalOpen && selections.error != null && <p className="form-error" role="alert">Eligible people and profiles could not be loaded. Close this form and try again.</p>}
            {resolutionOpen && selections.isPending && <p className="supporting-copy" role="status">Loading active ITDMs, profiles, and eligible people…</p>}
            {resolutionOpen && selections.error != null && <p className="form-error" role="alert">Resolution choices could not be loaded. Close this form and try again.</p>}
          </RequestQueueCard>
        );
      }}
    >
      <div className="request-exception-stage-tabs" role="tablist" aria-label="Exception stage">
        {([
          { value: null, label: 'All exceptions' },
          { value: 'PRE_N3', label: 'Pre N3' },
          { value: 'ESCALATION', label: 'Escalation' },
        ] as const).map(({ value, label }) => (
          <button
            type="button"
            role="tab"
            aria-selected={stage === value}
            tabIndex={stage === value ? 0 : -1}
            key={value ?? 'all'}
            onKeyDown={handleTabListKeyDown}
            onClick={() => {
              runner.setActionError(null);
              setStage(value);
              updateLocation(filters, value);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <RequestQueueFilterPanel filters={filters} selections={selections.data} disabled={selections.isPending} label="Filter exceptions" onChange={persistFilters} />
    </RequestQueueResults>
  );
}
