import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RequestApiError, getRequest, REQUESTS_QUERY_ROOT, type RequestAuditEvent, type RequestConfirmationSource, type ResourceRequestCollection, type ResourceRequestItem } from '../requestApi';
import { DeniedRequestResponse } from '../DeniedRequestResponse';
import { invalidateRequestSurfaces } from '../requestSurfaces';
import { hasAccessError } from './shared';
import { ProposalResponse } from './ProposalResponse';
import { RequestEditWithdrawal } from './RequestEditWithdrawal';
import { RequestMetadata, RequestOutcomeDetails, RequestRevalidationStatus } from './RequestOutcomeSummary';

export function RequestDetail({
  localUserId,
  personId,
  requestId,
  listRefreshFailed,
  summaryItem,
  onClose,
  onDetailNotFound,
  onAccessDenied,
  onNotice,
  onWithdrawn,
}: {
  localUserId: string;
  personId: string;
  requestId: string | null;
  listRefreshFailed: boolean;
  summaryItem: ResourceRequestCollection['items'][number] | null;
  onClose: () => void;
  onDetailNotFound: () => void;
  onAccessDenied: () => void;
  onNotice: (notice: string) => void;
  onWithdrawn: (event: RequestAuditEvent) => void;
}) {
  const queryClient = useQueryClient();
  const [formVersion, setFormVersion] = useState<number | null>(null);
  const [lastConfirmation, setLastConfirmation] = useState<{ requestId: string; source: RequestConfirmationSource | null } | null>(null);
  const lastFormRequestId = useRef<string | null>(null);
  const selectedRequest = useQuery({
    queryKey: [...REQUESTS_QUERY_ROOT, localUserId, 'detail', requestId],
    queryFn: () => getRequest(localUserId, requestId!),
    enabled: requestId !== null,
    refetchInterval: requestId ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const isDetailNotFound = selectedRequest.error instanceof RequestApiError && selectedRequest.error.status === 404;
  const currentItem = isDetailNotFound ? undefined : selectedRequest.data;
  const isRequester = currentItem?.requesterSnapshot.personId === personId;
  const formVersionChanged = currentItem !== undefined && formVersion !== null && currentItem.version !== formVersion;
  const canAcceptProposal = currentItem?.decisionState === 'APPROVED_WITH_CHANGES'
    && isRequester
    && currentItem.availableActions?.includes('ACCEPT') === true
    && currentItem.dueAt !== null
    && currentItem.dueAt !== undefined;
  const acceptDisabled = !canAcceptProposal
    || formVersion === null
    || formVersionChanged
    || selectedRequest.isFetching
    || selectedRequest.isError
    || listRefreshFailed;
  const canEdit = currentItem?.decisionState === 'WAITING_FOR_PRESENTATION'
    && isRequester
    && !selectedRequest.isFetching
    && !selectedRequest.isError
    && !listRefreshFailed;
  const currentConditions = currentItem?.requestedConditions;
  const confirmationSource = lastConfirmation?.requestId === currentItem?.id ? lastConfirmation?.source ?? null : null;
  const confirmationLabel = confirmationSource === 'SYSTEM_DEADLINE'
    ? 'Automatically confirmed at deadline'
    : confirmationSource === 'REQUESTER_ACCEPTANCE' ? 'Accepted by requester' : null;

  useEffect(() => {
    if (hasAccessError(selectedRequest.error)) {
      queryClient.removeQueries({ queryKey: REQUESTS_QUERY_ROOT });
      onAccessDenied();
    }
  }, [onAccessDenied, queryClient, selectedRequest.error]);

  useEffect(() => {
    if (!currentItem || lastFormRequestId.current === currentItem.id) return;
    setFormVersion(currentItem.version);
    lastFormRequestId.current = currentItem.id;
  }, [currentItem]);

  useEffect(() => {
    if (requestId === null) lastFormRequestId.current = null;
  }, [requestId]);

  useEffect(() => {
    if (selectedRequest.isError && isDetailNotFound) onDetailNotFound();
  }, [isDetailNotFound, onDetailNotFound, selectedRequest.isError]);

  async function refreshLatest(): Promise<ResourceRequestItem | undefined> {
    const result = await selectedRequest.refetch();
    return result.data;
  }

  async function reloadLatest(): Promise<ResourceRequestItem | undefined> {
    const latest = await refreshLatest();
    if (latest) setFormVersion(latest.version);
    return latest;
  }

  if (!requestId) return null;

  return (
    <section className="request-detail" aria-labelledby="request-detail-title">
      <div className="request-detail-heading">
        <div>
          <p className="eyebrow">Request detail</p>
          <h3 id="request-detail-title">{currentConditions?.initiativeCode ?? summaryItem?.requestedConditions.initiativeCode ?? 'Selected request'}</h3>
          <p>{requestId}</p>
        </div>
        <button type="button" className="secondary-button" onClick={onClose}>Close detail</button>
      </div>
      {selectedRequest.isPending && <p role="status">Loading request detail…</p>}
      {selectedRequest.isError && !isDetailNotFound && (
        <div className="form-error" role="alert">
          <p>The latest request detail could not be loaded. Your unsaved text remains here and changes are paused.</p>
          <button type="button" className="secondary-button" onClick={() => void selectedRequest.refetch()} disabled={selectedRequest.isFetching}>Try again</button>
        </div>
      )}
      {isDetailNotFound && <p className="empty-state">This request is no longer available as an operational request.</p>}
      {currentItem && (
        <>
          <RequestMetadata item={currentItem} confirmationLabel={confirmationLabel} />
          {isRequester && currentItem.decisionState === 'APPROVED_WITH_CHANGES' && (
            <ProposalResponse
              key={currentItem.id}
              localUserId={localUserId}
              item={currentItem}
              canAccept={canAcceptProposal}
              disabled={acceptDisabled}
              onRefresh={refreshLatest}
              onAccessDenied={onAccessDenied}
              onAccepted={(version, source) => {
                setLastConfirmation({ requestId: currentItem.id, source });
                setFormVersion(version);
              }}
              onNotice={onNotice}
            />
          )}
          <RequestRevalidationStatus item={currentItem} />
          {((isRequester && (currentItem.decisionState === 'DENIED' || currentItem.decisionState === 'PRE_N3' || currentItem.decisionState === 'CANCELLED'
            || currentItem.decisionState === 'REQUIRES_REVALIDATION'
            || (currentItem.decisionState === 'APPROVED_WITH_CHANGES' && currentItem.availableActions?.includes('CONTEST') === true)))
            || !isRequester) && (
            <DeniedRequestResponse
              localUserId={localUserId}
              item={currentItem}
              readOnly={!isRequester}
              disabled={selectedRequest.isFetching || listRefreshFailed || formVersionChanged}
              onChanged={(updated) => {
                setFormVersion(updated.version);
                void selectedRequest.refetch();
                void invalidateRequestSurfaces(queryClient, { localUserId, requestId: updated.id });
              }}
              onAccessDenied={onAccessDenied}
            />
          )}
          <RequestOutcomeDetails item={currentItem} />
          {isRequester && currentItem.decisionState !== 'WAITING_FOR_PRESENTATION' && (
            <p className="field-help request-readonly-message">This request can no longer be edited or withdrawn because it has left the presentation-waiting stage.</p>
          )}
          {!isRequester && <p className="field-help request-readonly-message">Consultation only. Mutations and requester response actions are available only to the request owner.</p>}
          {isRequester && (
            <RequestEditWithdrawal
              key={currentItem.id}
              localUserId={localUserId}
              item={currentItem}
              formVersion={formVersion}
              formVersionChanged={formVersionChanged}
              canEdit={canEdit}
              listRefreshFailed={listRefreshFailed}
              onVersionChange={setFormVersion}
              onNotice={onNotice}
              onAccessDenied={onAccessDenied}
              onRefreshLatest={() => { void selectedRequest.refetch(); }}
              onReloadLatest={reloadLatest}
              onWithdrawn={onWithdrawn}
            />
          )}
        </>
      )}
    </section>
  );
}
