import { useMemo, useState } from 'react';
import { handleTabListKeyDown } from './tabNavigation';
import type { ResourceAllocationRole } from './accessApi';
import type { RequestQueueCode } from './requestQueueApi';
import { ExceptionsQueue } from './request-queues/ExceptionsQueue';
import { PresentationQueue } from './request-queues/PresentationQueue';
import { RevalidationQueue } from './request-queues/RevalidationQueue';
import { TeamDecisionQueue } from './request-queues/TeamDecisionQueue';
import type { QueueVerticalProps } from './request-queues/shared';

interface RequestQueuesProps {
  localUserId: string;
  personId: string;
  role: ResourceAllocationRole;
  groupId: string | null;
  onAccessDenied: () => void;
}

const queueLabels: Record<RequestQueueCode, string> = {
  presentation: 'Presentation queue',
  'team-decision': 'Group decision queue',
  'requester-response': 'Requester response queue',
  exceptions: 'Admin exceptions',
  revalidation: 'Revalidation queue',
};

function queuesFor(role: ResourceAllocationRole, groupId: string | null): RequestQueueCode[] {
  if (role === 'ALLOCATION_ADMIN') return groupId ? ['presentation', 'team-decision', 'exceptions', 'revalidation'] : ['presentation', 'exceptions', 'revalidation'];
  if (role === 'ALLOCATION_MODERATOR' || role === 'ALLOCATION_SUPERVISOR' || role === 'ALLOCATION_MANAGER') {
    return ['team-decision', 'revalidation'];
  }
  return [];
}

function initialQueue(queues: RequestQueueCode[]): RequestQueueCode {
  const requested = new URLSearchParams(window.location.search).get('queue');
  if (requested && queues.includes(requested as RequestQueueCode)) return requested as RequestQueueCode;
  return queues[0] ?? 'team-decision';
}

function updateQueueLocation(queue: RequestQueueCode) {
  const params = new URLSearchParams(window.location.search);
  params.set('queue', queue);
  params.delete('requestId');
  if (queue !== 'exceptions' && queue !== 'revalidation') {
    params.delete('groupId');
    params.delete('initiativeId');
    params.delete('resourceProfileId');
  }
  if (queue !== 'exceptions') params.delete('decisionState');
  const search = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
}

export function RequestQueues({ localUserId, personId, role, groupId, onAccessDenied }: RequestQueuesProps) {
  const queues = useMemo(() => queuesFor(role, groupId), [role, groupId]);
  const [selectedQueue, setSelectedQueue] = useState<RequestQueueCode>(() => initialQueue(queues));
  const activeQueue = queues.includes(selectedQueue) ? selectedQueue : initialQueue(queues);
  const locationQuery = new URLSearchParams(window.location.search);
  const selectedRequestId = locationQuery.has('queue') ? locationQuery.get('requestId') : null;

  if (queues.length === 0) return null;

  const verticalProps: QueueVerticalProps = { localUserId, personId, role, selectedRequestId, onAccessDenied };
  const queueContent = activeQueue === 'presentation'
    ? <PresentationQueue {...verticalProps} />
    : activeQueue === 'team-decision'
      ? <TeamDecisionQueue {...verticalProps} />
      : activeQueue === 'exceptions'
        ? <ExceptionsQueue {...verticalProps} />
        : activeQueue === 'revalidation'
          ? <RevalidationQueue {...verticalProps} />
          : null;

  return (
    <section className="request-queues-panel" aria-labelledby="request-queues-title">
      <header className="request-queues-heading">
        <div>
          <p className="eyebrow">Request work</p>
          <h2 id="request-queues-title">Request queues</h2>
          <p className="supporting-copy">Requests are shown only when your current role and group scope allow you to act on them.</p>
        </div>
      </header>

      <div className="request-queue-tabs" role="tablist" aria-label="Request queues">
        {queues.map((queue) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeQueue === queue}
            tabIndex={activeQueue === queue ? 0 : -1}
            key={queue}
            onKeyDown={handleTabListKeyDown}
            onClick={() => {
              setSelectedQueue(queue);
              updateQueueLocation(queue);
            }}
          >
            {queueLabels[queue]}
          </button>
        ))}
      </div>

      {queueContent}
    </section>
  );
}
