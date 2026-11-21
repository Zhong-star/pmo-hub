import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AccessRequestError,
  getResourceAllocationAccess,
  LOCAL_USER_STORAGE_KEY,
  readSelectedProfileId,
} from './accessApi';
import { Administration } from './Administration';
import { RequestQueues } from './RequestQueues';
import { SubmissionWorkspace } from './SubmissionWorkspace';
import { RequestWorkspace } from './RequestWorkspace';

type ProfileSelection = { profileId: string | null; generation: number };

function isMissingProfile(error: unknown): boolean {
  return error instanceof AccessRequestError && error.status === 401;
}

function isDenied(error: unknown): error is AccessRequestError {
  return error instanceof AccessRequestError && error.status === 403;
}

function administratorContacts(error: AccessRequestError) {
  return error.problem?.administrators ?? [];
}

export function App() {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<ProfileSelection>(() => ({
    profileId: readSelectedProfileId(),
    generation: 0,
  }));
  const currentSelection = useRef(selection);
  const [adminAccessBlocked, setAdminAccessBlocked] = useState(false);
  const [moduleDataAccessBlocked, setModuleDataAccessBlocked] = useState(false);
  const { profileId, generation } = selection;

  const reconcileProfile = useCallback(() => {
    const nextProfileId = readSelectedProfileId();
    const current = currentSelection.current;
    if (current.profileId === nextProfileId) return;
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] === 'resource-allocation-access'
        || query.queryKey[0] === 'resource-allocation-admin'
        || query.queryKey[0] === 'resource-allocation-selections'
        || query.queryKey[0] === 'resource-allocation-request-queues'
        || query.queryKey[0] === 'resource-allocation-submissions'
        || query.queryKey[0] === 'resource-allocation-requests',
    });
    setAdminAccessBlocked(false);
    setModuleDataAccessBlocked(false);
    const nextSelection = { profileId: nextProfileId, generation: current.generation + 1 };
    currentSelection.current = nextSelection;
    setSelection(nextSelection);
  }, [queryClient]);

  useEffect(() => {
    function handleStorageChange(event: StorageEvent) {
      if (event.key === null || event.key === LOCAL_USER_STORAGE_KEY) reconcileProfile();
    }
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('pageshow', reconcileProfile);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('pageshow', reconcileProfile);
    };
  }, [reconcileProfile]);

  const accessQuery = useQuery({
    queryKey: ['resource-allocation-access', profileId, generation],
    queryFn: () => getResourceAllocationAccess(profileId ?? ''),
    enabled: profileId !== null,
    networkMode: 'always',
    retry: false,
    staleTime: 0,
  });

  const accessDenied = accessQuery.isError && (isMissingProfile(accessQuery.error) || isDenied(accessQuery.error));
  const accessConfirmedNonAdmin = accessQuery.isSuccess && accessQuery.data.person.role !== 'ALLOCATION_ADMIN';

  useEffect(() => {
    if (profileId && accessDenied) {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] === 'resource-allocation-admin'
          || query.queryKey[0] === 'resource-allocation-selections'
          || query.queryKey[0] === 'resource-allocation-request-queues'
          || query.queryKey[0] === 'resource-allocation-submissions'
          || query.queryKey[0] === 'resource-allocation-requests',
      });
      return;
    }
    if (profileId && accessConfirmedNonAdmin) {
      queryClient.removeQueries({ queryKey: ['resource-allocation-admin', profileId] });
      queryClient.removeQueries({ queryKey: ['resource-allocation-request-queues', profileId] });
    }
  }, [accessConfirmedNonAdmin, accessDenied, profileId, queryClient]);

  const isAdministrator = accessQuery.isSuccess
    && accessQuery.data.person.role === 'ALLOCATION_ADMIN'
    && !adminAccessBlocked;
  const canUseModuleData = accessQuery.isSuccess && !moduleDataAccessBlocked;
  const refetchAccess = accessQuery.refetch;
  const handleAdminAccessDenied = useCallback(() => {
    setAdminAccessBlocked(true);
    queryClient.removeQueries({ queryKey: ['resource-allocation-admin', profileId] });
    void refetchAccess();
  }, [profileId, queryClient, refetchAccess]);

  const handleModuleDataAccessDenied = useCallback(() => {
    setModuleDataAccessBlocked(true);
    setAdminAccessBlocked(true);
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== 'resource-allocation-access'
        && typeof query.queryKey[0] === 'string'
        && query.queryKey[0].startsWith('resource-allocation-'),
    });
    void refetchAccess();
  }, [queryClient, refetchAccess]);

  const handleQueueAccessDenied = useCallback(() => {
    queryClient.removeQueries({ queryKey: ['resource-allocation-request-queues', profileId] });
    queryClient.removeQueries({ queryKey: ['resource-allocation-requests', profileId] });
    void refetchAccess();
  }, [profileId, queryClient, refetchAccess]);

  const heading = profileId === null || (accessQuery.isError && isMissingProfile(accessQuery.error))
    ? 'Select a local profile in PMO Hub'
    : accessQuery.isPending
      ? 'Checking access'
      : isDenied(accessQuery.error)
        ? 'Access not available'
        : accessQuery.isError
          ? 'Could not reach Tech Resource Allocation'
          : 'Tech Resource Allocation';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar">
        <a className="brand" href="/" aria-label="PMO Hub home">PMO Hub</a>
        <span className="product-label">TECH RESOURCE ALLOCATION</span>
        <a className="return-link" href="/">Return to PMO Hub</a>
      </header>

      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className={isAdministrator || canUseModuleData ? 'content-column content-column-wide' : 'content-column'}>
          <section className="access-card" aria-labelledby="page-title">
            <div className="card-mark" aria-hidden="true">RA</div>
            <p className="eyebrow">PMO Hub module</p>
            <h1 id="page-title">{heading}</h1>

            {profileId === null && (
              <p className="supporting-copy">
                Select your local profile in PMO Hub, then open Tech Resource Allocation again.
              </p>
            )}

            {profileId !== null && accessQuery.isPending && (
              <p className="supporting-copy" role="status">Checking your module access…</p>
            )}

            {accessQuery.isSuccess && (
              <div className="profile-summary" aria-live="polite">
                <span className="status-dot" aria-hidden="true" />
                <div>
                  <p className="profile-name">{accessQuery.data.person.displayName}</p>
                  <p className="profile-role">Role: {accessQuery.data.person.role}</p>
                </div>
              </div>
            )}

            {accessQuery.isError && isMissingProfile(accessQuery.error) && (
              <p className="supporting-copy" role="alert">
                Select your local profile in PMO Hub, then open Tech Resource Allocation again.
              </p>
            )}

            {accessQuery.isError && isDenied(accessQuery.error) && (
              <div className="access-message" role="alert">
                <p>You do not have active access to this module. Contact an active Admin for help.</p>
                {administratorContacts(accessQuery.error).length > 0 ? (
                  <ul className="contact-list" aria-label="Active Tech Resource Allocation Admins">
                    {administratorContacts(accessQuery.error).map((administrator) => (
                      <li key={`${administrator.email}:${administrator.displayName}`}>
                        <span>{administrator.displayName}</span>
                        <a href={`mailto:${administrator.email}`}>{administrator.email}</a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="fallback-copy">No active Admin contacts are available. Ask your PMO Hub environment owner for help.</p>
                )}
              </div>
            )}

            {accessQuery.isError && !isMissingProfile(accessQuery.error) && !isDenied(accessQuery.error) && (
              <div className="access-message" role="alert">
                <p>Tech Resource Allocation is temporarily unavailable. Try again.</p>
                <button type="button" onClick={() => void accessQuery.refetch()} disabled={accessQuery.isFetching}>
                  {accessQuery.isFetching ? 'Checking access…' : 'Try again'}
                </button>
              </div>
            )}
          </section>

          {canUseModuleData && profileId && (
            <RequestQueues
              key={`${profileId}:${generation}`}
              localUserId={profileId}
              role={accessQuery.data.person.role}
              groupId={accessQuery.data.person.groupId ?? null}
              onAccessDenied={handleQueueAccessDenied}
            />
          )}

          {canUseModuleData && profileId && (
            <SubmissionWorkspace localUserId={profileId} onAccessDenied={handleModuleDataAccessDenied} />
          )}

          {canUseModuleData && profileId && (
            <RequestWorkspace key={profileId} localUserId={profileId} onAccessDenied={handleModuleDataAccessDenied} />
          )}

          {moduleDataAccessBlocked && (
            <div className="form-error admin-access-revoked" role="alert">
              <p>Your module data access could not be confirmed. Protected records have been cleared.</p>
              <button type="button" className="secondary-button" onClick={() => { setModuleDataAccessBlocked(false); void refetchAccess(); }} disabled={accessQuery.isFetching}>
                {accessQuery.isFetching ? 'Checking access…' : 'Check access again'}
              </button>
            </div>
          )}

          {isAdministrator && profileId && (
            <Administration localUserId={profileId} onAccessDenied={handleAdminAccessDenied} />
          )}

          {adminAccessBlocked && accessQuery.data?.person.role === 'ALLOCATION_ADMIN' && (
            <div className="form-error admin-access-revoked" role="alert">
              <p>Your Admin permission could not be confirmed. Administrative records have been cleared.</p>
              <button type="button" className="secondary-button" onClick={() => void accessQuery.refetch()} disabled={accessQuery.isFetching}>
                {accessQuery.isFetching ? 'Checking access…' : 'Check access again'}
              </button>
            </div>
          )}
        </div>
      </main>
      <footer className="page-footer">Local development · PMO Hub</footer>
    </div>
  );
}
