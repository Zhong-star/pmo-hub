import { useState } from 'react';
import { approveRequest, correctRequestReferences, referRequest, removeRequestAdministratively } from '../requestQueueApi';
import { denyRequest } from '../requestDecisionApi';
import { DenialAction } from '../DenialAction';
import { ApprovalForm, ReferenceCorrectionForm, type ApprovalDecision, type ReferenceCorrectionValues } from './forms';
import { RequestAdministrativeRemoval, RequestReferralActions } from './ReferralRemovalActions';
import { RequestQueueCard, RequestQueueResults, readRequestValue, useQueueAccessGuard, useQueueActionRunner, useQueueDeepLink, useQueueSelections, useRequestQueueQuery, type QueueVerticalProps } from './shared';

type TeamDecisionAction = 'approval' | 'denial' | 'correction' | 'removal';

export function TeamDecisionQueue(props: QueueVerticalProps) {
  const { localUserId, personId, role, selectedRequestId, onAccessDenied } = props;
  const query = useRequestQueueQuery(localUserId, 'team-decision', {});
  const { items, missing } = useQueueDeepLink(query, selectedRequestId);
  useQueueAccessGuard(query, onAccessDenied);
  const runner = useQueueActionRunner(localUserId, onAccessDenied);
  const [openApprovalId, setOpenApprovalId] = useState<string | null>(null);
  const [openDenialId, setOpenDenialId] = useState<string | null>(null);
  const [openCorrectionId, setOpenCorrectionId] = useState<string | null>(null);
  const [openRemovalId, setOpenRemovalId] = useState<string | null>(null);
  const activeFormRequestId = openApprovalId ?? (role === 'ALLOCATION_ADMIN' ? openCorrectionId : null);
  const activeItem = activeFormRequestId ? items.find((item) => item.id === activeFormRequestId) : undefined;
  const groupId = activeItem ? readRequestValue(activeItem, 'groupId') : null;
  const selections = useQueueSelections(localUserId, groupId !== null, groupId, openApprovalId ?? undefined, onAccessDenied);
  const actionsBlocked = query.isError && !query.isFetchNextPageError;

  function toggle(itemId: string, action: TeamDecisionAction) {
    runner.setActionError(null);
    if (action === 'approval') {
      setOpenDenialId(null);
      setOpenCorrectionId(null);
      setOpenRemovalId(null);
      setOpenApprovalId((current) => current === itemId ? null : itemId);
    } else if (action === 'denial') {
      setOpenApprovalId(null);
      setOpenCorrectionId(null);
      setOpenRemovalId(null);
      setOpenDenialId((current) => current === itemId ? null : itemId);
    } else if (action === 'correction') {
      setOpenApprovalId(null);
      setOpenDenialId(null);
      setOpenRemovalId(null);
      setOpenCorrectionId((current) => current === itemId ? null : itemId);
    } else {
      setOpenApprovalId(null);
      setOpenDenialId(null);
      setOpenCorrectionId(null);
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
      label="Group decision queue"
      selectedRequestId={selectedRequestId}
      deepLinkMissing={missing}
      actionError={runner.actionError}
      renderItem={(item) => {
        const busy = runner.pendingRequestIds.has(item.id);
        const disabled = busy || actionsBlocked;
        return (
          <RequestQueueCard key={item.id} item={item} queueLabel="Waiting for group decision" highlighted={item.id === selectedRequestId}>
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
                <button type="button" className="primary-button" aria-expanded={openApprovalId === item.id} onClick={() => toggle(item.id, 'approval')} disabled={disabled}>
                  {busy ? 'Approving request…' : 'Approve request'}
                </button>
              </div>
            )}
            {openCorrectionId === item.id && selections.data && <ReferenceCorrectionForm item={item} selections={selections.data} disabled={disabled} onSubmit={(correction: ReferenceCorrectionValues) => run(item, 'reference-correction', { ...correction }, (key) => correctRequestReferences(localUserId, item.id, item.version, key, correction))} />}
            {openCorrectionId === item.id && selections.isPending && <p className="supporting-copy" role="status">Loading active reference choices…</p>}
            {openCorrectionId === item.id && selections.error != null && <p className="form-error" role="alert">Reference choices could not be loaded. Close this form and try again.</p>}
            {openRemovalId === item.id && <RequestAdministrativeRemoval disabled={disabled} onSubmit={(reason) => run(item, 'administrative-removal', { reason }, (key) => removeRequestAdministratively(localUserId, item.id, item.version, key, reason))} />}
            {openApprovalId === item.id && selections.data && (
              <ApprovalForm item={item} selections={selections.data} disabled={disabled} onSubmit={(approval: ApprovalDecision) => run(item, 'approval', approval, (key) => approveRequest(localUserId, item.id, item.version, key, approval))} />
            )}
            {openApprovalId === item.id && selections.isPending && <p className="supporting-copy" role="status">Loading eligible people and active profiles…</p>}
            {openApprovalId === item.id && selections.error != null && <p className="form-error" role="alert">Eligible people and profiles could not be loaded. Close this form and try again.</p>}
          </RequestQueueCard>
        );
      }}
    />
  );
}
