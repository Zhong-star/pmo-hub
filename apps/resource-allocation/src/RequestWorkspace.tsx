import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceAllocationRole } from './accessApi';
import type { RequestAuditEvent, ResourceRequestCollection } from './requestApi';
import type { SubmissionLine, SubmissionReceipt, SubmissionSummary } from './submissionApi';
import { readNewRequestDrawerOpen } from './navigation';
import { useNavigationProtection } from './NavigationProtection';
import { readOutbox } from './submissionOutbox';
import { NewRequestDrawer, type RetryLineDraft } from './request-workspace/NewRequestDrawer';
import { RequestAudit } from './request-workspace/RequestAudit';
import { RequestCollection } from './request-workspace/RequestCollection';
import { RequestDetail } from './request-workspace/RequestDetail';
import { SubmissionHistory } from './request-workspace/SubmissionHistory';

interface RequestWorkspaceProps {
  localUserId: string;
  personId: string;
  role: ResourceAllocationRole;
  onAccessDenied: () => void;
}

function querySelectedRequestId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.has('queue') ? null : params.get('requestId');
}

function querySelectedAuditId(): string | null {
  return new URLSearchParams(window.location.search).get('auditId');
}

function updateRequestUrl(requestId: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.set('page', 'requests');
  if (requestId) {
    url.searchParams.delete('queue');
    url.searchParams.set('requestId', requestId);
  } else {
    url.searchParams.delete('requestId');
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function updateAuditUrl(requestId: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.set('page', 'requests');
  if (requestId) url.searchParams.set('auditId', requestId);
  else url.searchParams.delete('auditId');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function updateNewRequestUrl(open: boolean) {
  const url = new URL(window.location.href);
  url.searchParams.set('page', 'requests');
  if (open) url.searchParams.set('newRequest', '1');
  else url.searchParams.delete('newRequest');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function RequestWorkspace({ localUserId, personId, role, onAccessDenied }: RequestWorkspaceProps) {
  const { guardNavigation } = useNavigationProtection();
  const newRequestButtonRef = useRef<HTMLButtonElement>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(() => querySelectedRequestId());
  const [selectedSummaryItem, setSelectedSummaryItem] = useState<ResourceRequestCollection['items'][number] | null>(null);
  const [auditRequestId, setAuditRequestId] = useState<string | null>(() => querySelectedAuditId());
  const [isNewRequestOpen, setIsNewRequestOpen] = useState<boolean>(() => readNewRequestDrawerOpen(window.location.search));
  const [retryDraft, setRetryDraft] = useState<RetryLineDraft | null>(null);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const [submissionNotice, setSubmissionNotice] = useState('');
  const [hasUnconfirmedOutbox, setHasUnconfirmedOutbox] = useState<boolean>(() => Boolean(readOutbox(localUserId)));
  const [notice, setNotice] = useState('');
  const [listRefreshFailed, setListRefreshFailed] = useState(false);
  const handleDetailNotFound = useCallback(() => updateRequestUrl(null), []);
  const handleRetryDraftConsumed = useCallback(() => setRetryDraft(null), []);

  useEffect(() => {
    function onPopState() {
      setSelectedRequestId(querySelectedRequestId());
      setSelectedSummaryItem(null);
      setAuditRequestId(querySelectedAuditId());
      setIsNewRequestOpen(readNewRequestDrawerOpen(window.location.search));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function openRequest(item: ResourceRequestCollection['items'][number]) {
    if (item.id === selectedRequestId) return;
    guardNavigation(() => {
      setSelectedRequestId(item.id);
      setSelectedSummaryItem(item);
      setAuditRequestId(null);
      setNotice('');
      updateRequestUrl(item.id);
      updateAuditUrl(null);
    });
  }

  function closeRequest() {
    guardNavigation(() => {
      setSelectedRequestId(null);
      setSelectedSummaryItem(null);
      updateRequestUrl(null);
    });
  }

  function clearSelection() {
    guardNavigation(() => {
      setSelectedRequestId(null);
      setSelectedSummaryItem(null);
      updateRequestUrl(null);
    });
  }

  function onWithdrawn(event: RequestAuditEvent) {
    setAuditRequestId(event.requestId);
    setSelectedRequestId(null);
    setSelectedSummaryItem(null);
    updateRequestUrl(null);
    updateAuditUrl(event.requestId);
  }

  function closeAudit() {
    setAuditRequestId(null);
    updateAuditUrl(null);
  }

  function openNewRequest() {
    setSubmissionNotice('');
    setIsNewRequestOpen(true);
    updateNewRequestUrl(true);
  }

  function closeNewRequest() {
    setIsNewRequestOpen(false);
    setRetryDraft(null);
    updateNewRequestUrl(false);
  }

  function handleRetryLine(_submission: SubmissionSummary, line: SubmissionLine) {
    const initiativeId = line.submittedConditions.initiativeId;
    const category = line.submittedConditions.category;
    if (hasUnconfirmedOutbox || line.status !== 'FAILED' || !initiativeId || !category) return;
    setSubmissionNotice('');
    setRetryDraft({
      key: `${line.id}:${Date.now()}`,
      initiativeId,
      category,
      line: {
        groupId: line.submittedConditions.groupId,
        resourceProfileId: line.submittedConditions.resourceProfileId,
        startDate: line.submittedConditions.startDate,
        endDate: line.submittedConditions.endDate,
        weeklyHours: String(line.submittedConditions.weeklyHours),
        comment: line.submittedConditions.comment ?? '',
      },
    });
    setIsNewRequestOpen(true);
    updateNewRequestUrl(true);
  }

  function handleSubmitted(receipt: SubmissionReceipt) {
    setSelectedSubmissionId(receipt.id);
    setSubmissionNotice(`Submission ${receipt.id} was received. Line processing can continue after you close this page.`);
    setRetryDraft(null);
    setIsNewRequestOpen(false);
    updateNewRequestUrl(false);
  }

  return (
    <section className="request-workspace" aria-labelledby="my-requests-title">
      {!isNewRequestOpen && hasUnconfirmedOutbox && (
        <div className="unknown-receipt" role="alert">
          <div>
            <h3>Unconfirmed request batch</h3>
            <p>A previous submission receipt was not confirmed. Open the request batch drawer to recover it safely.</p>
          </div>
          <button type="button" className="primary-button" onClick={openNewRequest}>
            Open New request
          </button>
        </div>
      )}
      <RequestCollection
        localUserId={localUserId}
        role={role}
        selectedRequestId={selectedRequestId}
        notice={notice}
        newRequestButtonRef={newRequestButtonRef}
        onOpenNewRequest={openNewRequest}
        onOpenRequest={openRequest}
        onClearSelection={clearSelection}
        onAccessDenied={onAccessDenied}
        onRefreshStateChange={setListRefreshFailed}
      />
      <RequestDetail
        localUserId={localUserId}
        personId={personId}
        requestId={selectedRequestId}
        listRefreshFailed={listRefreshFailed}
        summaryItem={selectedSummaryItem}
        onClose={closeRequest}
        onDetailNotFound={handleDetailNotFound}
        onAccessDenied={onAccessDenied}
        onNotice={setNotice}
        onWithdrawn={onWithdrawn}
      />
      <RequestAudit localUserId={localUserId} requestId={auditRequestId} onClose={closeAudit} onAccessDenied={onAccessDenied} />
      <SubmissionHistory
        localUserId={localUserId}
        selectedSubmissionId={selectedSubmissionId}
        onSelectSubmission={setSelectedSubmissionId}
        notice={submissionNotice}
        onRetryLine={handleRetryLine}
        onAccessDenied={onAccessDenied}
      />
      <NewRequestDrawer
        open={isNewRequestOpen}
        localUserId={localUserId}
        retryDraft={retryDraft}
        onRetryDraftConsumed={handleRetryDraftConsumed}
        onClose={closeNewRequest}
        onSubmitted={handleSubmitted}
        onOutboxChange={setHasUnconfirmedOutbox}
        onAccessDenied={onAccessDenied}
        returnFocusRef={newRequestButtonRef}
      />
    </section>
  );
}
