import { useCallback, useEffect, useState } from 'react';
import type { ResourceAllocationRole } from './accessApi';
import type { RequestAuditEvent, ResourceRequestCollection } from './requestApi';
import { useNavigationProtection } from './NavigationProtection';
import { RequestAudit } from './request-workspace/RequestAudit';
import { RequestCollection } from './request-workspace/RequestCollection';
import { RequestDetail } from './request-workspace/RequestDetail';

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

export function RequestWorkspace({ localUserId, personId, role, onAccessDenied }: RequestWorkspaceProps) {
  const { guardNavigation } = useNavigationProtection();
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(() => querySelectedRequestId());
  const [selectedSummaryItem, setSelectedSummaryItem] = useState<ResourceRequestCollection['items'][number] | null>(null);
  const [auditRequestId, setAuditRequestId] = useState<string | null>(() => querySelectedAuditId());
  const [notice, setNotice] = useState('');
  const [listRefreshFailed, setListRefreshFailed] = useState(false);
  const handleDetailNotFound = useCallback(() => updateRequestUrl(null), []);

  useEffect(() => {
    function onPopState() {
      setSelectedRequestId(querySelectedRequestId());
      setSelectedSummaryItem(null);
      setAuditRequestId(querySelectedAuditId());
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

  return (
    <section className="request-workspace" aria-labelledby="my-requests-title">
      <RequestCollection
        localUserId={localUserId}
        role={role}
        selectedRequestId={selectedRequestId}
        notice={notice}
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
    </section>
  );
}
