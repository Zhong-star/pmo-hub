import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { acceptRequest, RequestApiError, type RequestConfirmationSource, type ResourceRequestItem } from '../requestApi';
import { invalidateRequestSurfaces } from '../requestSurfaces';

const pendingAcceptanceKeys = new Map<string, Promise<string>>();

async function acceptanceIdempotencyKey(localUserId: string, requestId: string, version: number): Promise<string> {
  const identity = JSON.stringify([localUserId, requestId, version, 'acceptance']);
  const pending = pendingAcceptanceKeys.get(identity);
  if (pending) return pending;

  const keyPromise = (async () => {
    let slot = identity;
    try {
      const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
      slot = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      // Keep retries stable for this page session if Web Crypto is unavailable.
    }

    const storageKey = `pmo-hub.resource-allocation.acceptance.${slot}`;
    try {
      const existing = window.sessionStorage.getItem(storageKey);
      if (existing) return existing;
    } catch {
      // Some embedded browsers disable storage; use the in-memory cache below.
    }

    const idempotencyKey = window.crypto.randomUUID();
    try {
      window.sessionStorage.setItem(storageKey, idempotencyKey);
    } catch {
      // The in-memory promise cache still keeps retries in this page stable.
    }
    return idempotencyKey;
  })();

  pendingAcceptanceKeys.set(identity, keyPromise);
  return keyPromise;
}

export function ProposalResponse({
  localUserId,
  item,
  canAccept,
  disabled,
  onRefresh,
  onAccessDenied,
  onAccepted,
  onNotice,
}: {
  localUserId: string;
  item: ResourceRequestItem;
  canAccept: boolean;
  disabled: boolean;
  onRefresh: () => Promise<ResourceRequestItem | undefined>;
  onAccessDenied: () => void;
  onAccepted: (version: number, source: RequestConfirmationSource | null) => void;
  onNotice: (notice: string) => void;
}) {
  const queryClient = useQueryClient();
  const [acceptError, setAcceptError] = useState('');
  const acceptMutation = useMutation({
    mutationFn: (input: { requestId: string; version: number; idempotencyKey: string }) =>
      acceptRequest(localUserId, input.requestId, input.version, input.idempotencyKey),
  });

  async function acceptProposal() {
    if (!canAccept || disabled || acceptMutation.isPending) return;
    setAcceptError('');
    const idempotencyKey = await acceptanceIdempotencyKey(localUserId, item.id, item.version);
    try {
      const accepted = await acceptMutation.mutateAsync({ requestId: item.id, version: item.version, idempotencyKey });
      onAccepted(accepted.version, accepted.confirmationSource ?? null);
      onNotice(accepted.confirmationSource === 'SYSTEM_DEADLINE'
        ? 'The proposal was automatically confirmed when the 72-hour response deadline was reached.'
        : accepted.confirmationSource === 'REQUESTER_ACCEPTANCE'
          ? 'You accepted the proposed conditions.'
          : 'The request status was updated.');
      await invalidateRequestSurfaces(queryClient, { includeAllocations: true, preserveDetail: true });
    } catch (error) {
      if (error instanceof RequestApiError && (error.status === 401 || error.status === 403)) {
        onAccessDenied();
        return;
      }
      if (error instanceof RequestApiError && error.status === 412) {
        setAcceptError('This proposal changed before it could be accepted. Your view is preserved; reload the latest request before acting again.');
        void onRefresh();
        return;
      }
      if (error instanceof RequestApiError && error.status === 422 && error.problem?.code === 'INVALID_REQUEST_TRANSITION') {
        const latest = await onRefresh();
        if (!latest || (latest.decisionState === 'APPROVED_WITH_CHANGES' && latest.availableActions?.includes('ACCEPT'))) {
          setAcceptError(error.message);
        } else {
          setAcceptError('');
          onNotice('This proposal is no longer awaiting acceptance. The current request status has been loaded.');
        }
        await invalidateRequestSurfaces(queryClient, { localUserId, requestId: item.id, includeAllocations: true, preserveDetail: true });
        return;
      }
      setAcceptError(error instanceof Error ? error.message : 'The request could not be saved. Your form values are still available.');
    }
  }

  return (
    <section className="request-detail-outcome request-proposal-status" aria-label="Proposal response">
      <h4>Respond to proposed conditions</h4>
      <p>No allocation exists until you accept the proposal or the 72-hour response window ends.</p>
      {acceptError && <p className="form-error" role="alert">{acceptError}</p>}
      {canAccept ? (
        <button type="button" className="primary-button" onClick={() => void acceptProposal()} disabled={disabled || acceptMutation.isPending}>
          {acceptMutation.isPending ? 'Accepting proposal…' : 'Accept proposed conditions'}
        </button>
      ) : (
        <p className="request-proposal-pending" role="status">Acceptance is unavailable. The system confirms eligible proposals automatically when the 72-hour response deadline is reached.</p>
      )}
    </section>
  );
}
