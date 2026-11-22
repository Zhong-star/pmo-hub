import type { ResourceAllocationRole } from '../accessApi';
import type { RequestQueueItem } from '../requestQueueApi';
import { AdministrativeRemovalForm } from './forms';

export function RequestReferralActions({
  item,
  personId,
  role,
  busy,
  disabled,
  openRemoval,
  onRemovalToggle,
  onRefer,
}: {
  item: RequestQueueItem;
  personId: string;
  role: ResourceAllocationRole;
  busy: boolean;
  disabled: boolean;
  openRemoval: boolean;
  onRemovalToggle: () => void;
  onRefer: () => void;
}) {
  if (!item.availableActions.includes('REFER')) return null;

  const ownRequest = item.requester.personId === personId;

  return (
    <div className="request-queue-actions">
      <button type="button" className="primary-button" onClick={onRefer} disabled={disabled}>
        {busy ? 'Updating request…' : 'Refer to group decision'}
      </button>
      {role === 'ALLOCATION_ADMIN' && !ownRequest && item.availableActions.includes('ADMINISTRATIVE_REMOVE') && (
        <button type="button" className="secondary-button" aria-expanded={openRemoval} onClick={onRemovalToggle} disabled={disabled}>
          Remove request
        </button>
      )}
    </div>
  );
}

export function RequestAdministrativeRemoval({ disabled, onSubmit }: { disabled: boolean; onSubmit: (reason: string) => Promise<void> }) {
  return (
    <AdministrativeRemovalForm
      disabled={disabled}
      onSubmit={(reason) => {
        if (!window.confirm('Remove this request from the active queue? The request history and audit will be retained.')) return Promise.resolve();
        return onSubmit(reason);
      }}
    />
  );
}
