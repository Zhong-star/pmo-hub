import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AccessRequestError,
  getResourceAllocationAccess,
  LOCAL_USER_STORAGE_KEY,
  readSelectedProfileId,
} from './accessApi';
import { Administration } from './Administration';
import { ProfileAdministration } from './ProfileAdministration';
import { AllocationsWorkspace } from './AllocationsWorkspace';
import { NotificationsInbox } from './NotificationsInbox';
import { RequestQueues } from './RequestQueues';
import { SubmissionWorkspace } from './SubmissionWorkspace';
import { RequestWorkspace } from './RequestWorkspace';
import { HubHeader } from '../../shared-ui/src/HubHeader';
import { WorkspaceSidebar } from '../../shared-ui/src/WorkspaceSidebar';
import { useThemePreference } from '../../shared-ui/src/theme';
import { NavigationProtectionProvider, useNavigationProtection } from './NavigationProtection';
import {
  normalizeResourceAllocationPage,
  readResourceAllocationPage,
  resourceAllocationPageHref,
  type ResourceAllocationPage,
} from './navigation';

type ProfileSelection = { profileId: string | null; generation: number };
const historyPositionKey = '__pmoResourceAllocationHistoryPosition';

function readHistoryPosition(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const position = (state as Record<string, unknown>)[historyPositionKey];
  return typeof position === 'number' ? position : null;
}

function withHistoryPosition(state: unknown, position: number) {
  const record = state && typeof state === 'object' ? state as Record<string, unknown> : {};
  return { ...record, [historyPositionKey]: position };
}

const navigationItems: Array<{ page: ResourceAllocationPage; label: string }> = [
  { page: 'requests', label: 'Requests' },
  { page: 'new-request', label: 'New request' },
  { page: 'request-queues', label: 'Request queues' },
  { page: 'allocations', label: 'Allocations and capacity' },
  { page: 'notifications', label: 'Notifications' },
  { page: 'administration', label: 'Administration' },
];

function isMissingProfile(error: unknown): boolean {
  return error instanceof AccessRequestError && error.status === 401;
}

function isDenied(error: unknown): error is AccessRequestError {
  return error instanceof AccessRequestError && error.status === 403;
}

function administratorContacts(error: AccessRequestError) {
  return error.problem?.administrators ?? [];
}

function canUseRequestQueues(role: string): boolean {
  return role === 'ALLOCATION_ADMIN'
    || role === 'ALLOCATION_MODERATOR'
    || role === 'ALLOCATION_SUPERVISOR'
    || role === 'ALLOCATION_MANAGER';
}

export function App() {
  return (
    <NavigationProtectionProvider>
      <ResourceAllocationApp />
    </NavigationProtectionProvider>
  );
}

function ResourceAllocationApp() {
  const { theme, selectTheme } = useThemePreference();
  const queryClient = useQueryClient();
  const { isDirty, isPending, notice: navigationNotice, guardNavigation, allowUnloadOnce } = useNavigationProtection();
  const [selection, setSelection] = useState<ProfileSelection>(() => ({
    profileId: readSelectedProfileId(),
    generation: 0,
  }));
  const currentSelection = useRef(selection);
  const [activePage, setActivePage] = useState<ResourceAllocationPage>(() => readResourceAllocationPage(window.location.search));
  const [isModuleMenuOpen, setIsModuleMenuOpen] = useState(false);
  const workspacePanel = useRef<HTMLElement>(null);
  const currentHistoryPosition = useRef(0);
  const isRevertingHistory = useRef(false);
  const isResumingHistory = useRef(false);
  const pendingHistoryNavigation = useRef<{ delta: number; hasPosition: boolean } | null>(null);
  const [adminAccessBlocked, setAdminAccessBlocked] = useState(false);
  const [profileAdministrationAccessBlocked, setProfileAdministrationAccessBlocked] = useState(false);
  const [moduleDataAccessBlocked, setModuleDataAccessBlocked] = useState(false);
  const { profileId, generation } = selection;

  const reconcileProfile = useCallback(() => {
    const nextProfileId = readSelectedProfileId();
    const current = currentSelection.current;
    if (current.profileId === nextProfileId) return;
    queryClient.removeQueries({
      predicate: (query) => typeof query.queryKey[0] === 'string'
        && query.queryKey[0].startsWith('resource-allocation-'),
    });
    setAdminAccessBlocked(false);
    setProfileAdministrationAccessBlocked(false);
    setModuleDataAccessBlocked(false);
    setIsModuleMenuOpen(false);
    const nextSelection = { profileId: nextProfileId, generation: current.generation + 1 };
    currentSelection.current = nextSelection;
    setSelection(nextSelection);
  }, [queryClient]);

  useEffect(() => {
    const initialPosition = readHistoryPosition(window.history.state);
    if (initialPosition === null) {
      currentHistoryPosition.current = 0;
      window.history.replaceState(withHistoryPosition(window.history.state, 0), '', window.location.href);
    } else {
      currentHistoryPosition.current = initialPosition;
    }
    normalizeResourceAllocationPage(readResourceAllocationPage(window.location.search));

    function applyHistoryDestination() {
      setActivePage(readResourceAllocationPage(window.location.search));
      setIsModuleMenuOpen(false);
      workspacePanel.current?.focus();
    }

    function handleHistoryNavigation(event: PopStateEvent) {
      if (isResumingHistory.current) {
        isResumingHistory.current = false;
        const resumedPosition = readHistoryPosition(event.state);
        if (resumedPosition !== null) currentHistoryPosition.current = resumedPosition;
        applyHistoryDestination();
        return;
      }

      if (isRevertingHistory.current) {
        event.stopImmediatePropagation();
        isRevertingHistory.current = false;
        const pending = pendingHistoryNavigation.current;
        pendingHistoryNavigation.current = null;
        const revertedPosition = readHistoryPosition(event.state);
        if (revertedPosition !== null) currentHistoryPosition.current = revertedPosition;
        if (!pending) return;

        const allowed = guardNavigation(() => {
          if (!pending.hasPosition) allowUnloadOnce();
          isResumingHistory.current = true;
          window.history.go(pending.delta);
        });
        if (!allowed) applyHistoryDestination();
        return;
      }

      const destinationPosition = readHistoryPosition(event.state);
      const delta = destinationPosition === null
        ? -1
        : destinationPosition - currentHistoryPosition.current;
      if ((isDirty || isPending) && delta !== 0) {
        event.stopImmediatePropagation();
        pendingHistoryNavigation.current = { delta, hasPosition: destinationPosition !== null };
        isRevertingHistory.current = true;
        window.history.go(-delta);
        return;
      }

      if (destinationPosition !== null) currentHistoryPosition.current = destinationPosition;
      applyHistoryDestination();
    }

    window.addEventListener('popstate', handleHistoryNavigation, { capture: true });
    return () => window.removeEventListener('popstate', handleHistoryNavigation, { capture: true });
  }, [allowUnloadOnce, guardNavigation, isDirty, isPending]);

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
        predicate: (query) => typeof query.queryKey[0] === 'string'
          && query.queryKey[0].startsWith('resource-allocation-')
          && query.queryKey[0] !== 'resource-allocation-access',
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
  const role = accessQuery.data?.person.role;
  const isDelegatedProfileAdministrator = role === 'ALLOCATION_MODERATOR'
    || role === 'ALLOCATION_SUPERVISOR'
    || role === 'ALLOCATION_MANAGER';
  const canManageProfiles = isAdministrator || (isDelegatedProfileAdministrator && !profileAdministrationAccessBlocked);
  const canUseModuleData = accessQuery.isSuccess && !moduleDataAccessBlocked;
  const canDisplayWorkspace = profileId !== null && accessQuery.isSuccess;
  const refetchAccess = accessQuery.refetch;
  const handleAdminAccessDenied = useCallback(() => {
    setAdminAccessBlocked(true);
    queryClient.removeQueries({ queryKey: ['resource-allocation-admin', profileId] });
    void refetchAccess();
  }, [profileId, queryClient, refetchAccess]);

  const handleProfileAdministrationAccessDenied = useCallback(() => {
    setProfileAdministrationAccessBlocked(true);
    queryClient.removeQueries({ queryKey: ['resource-allocation-profile-administration', profileId] });
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

  const queueAccess = role ? canUseRequestQueues(role) : false;
  const selectedPageIsAllowed = (activePage !== 'request-queues' || queueAccess)
    && (activePage !== 'administration' || canManageProfiles || (profileAdministrationAccessBlocked && isDelegatedProfileAdministrator));

  function changeProfile() {
    if (!guardNavigation()) return false;
    if (isDirty || isPending) allowUnloadOnce();
    try {
      window.localStorage.removeItem(LOCAL_USER_STORAGE_KEY);
    } catch {
      // The Hub can still present profile selection when storage is unavailable.
    }
    queryClient.removeQueries({
      predicate: (query) => typeof query.queryKey[0] === 'string'
        && query.queryKey[0].startsWith('resource-allocation-'),
    });
    window.location.assign('/');
    return true;
  }

  function navigateToPage(page: ResourceAllocationPage, event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (page === activePage) {
      setIsModuleMenuOpen(false);
      return;
    }
    if (!guardNavigation()) return;
    setIsModuleMenuOpen(false);

    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('page', page);
    url.hash = '';
    const nextPosition = currentHistoryPosition.current + 1;
    window.history.pushState(withHistoryPosition(window.history.state, nextPosition), '', url);
    currentHistoryPosition.current = nextPosition;
    setActivePage(page);
    workspacePanel.current?.focus();
  }

  function guardSameOriginAnchor(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || anchor.hasAttribute('data-resource-allocation-navigation') || anchor.hasAttribute('download')) return;
    if (anchor.target && anchor.target.toLowerCase() !== '_self') return;

    const destination = new URL(anchor.href, window.location.href);
    if (destination.origin !== window.location.origin) return;
    if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;

    if (!guardNavigation()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isDirty || isPending) allowUnloadOnce();
  }

  const visibleNavigationItems = navigationItems.filter(({ page }) => {
    if (page === 'request-queues') return queueAccess;
    if (page === 'administration') return isAdministrator || (isDelegatedProfileAdministrator && !profileAdministrationAccessBlocked);
    return true;
  });

  return (
    <div className={`app-shell${canDisplayWorkspace ? ' workspace-shell' : ''}`} onClickCapture={guardSameOriginAnchor}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <HubHeader
        key={`${profileId ?? 'no-profile'}:${generation}`}
        profileName={accessQuery.data?.person.displayName ?? profileId ?? undefined}
        onChangeProfile={profileId ? changeProfile : undefined}
        theme={theme}
        onThemeChange={selectTheme}
      />

      {canDisplayWorkspace ? (
        <div className="workspace-layout">
          <WorkspaceSidebar
            label="Tech Resource Allocation navigation"
            navigationLabel="Tech Resource Allocation"
            navigationId="resource-allocation-navigation"
            open={isModuleMenuOpen}
            onToggle={() => setIsModuleMenuOpen((open) => !open)}
          >
            {visibleNavigationItems.map(({ page, label }) => (
              <a
                key={page}
                href={resourceAllocationPageHref(page)}
                aria-current={activePage === page ? 'page' : undefined}
                data-resource-allocation-navigation="true"
                onClick={(event) => navigateToPage(page, event)}
              >
                {page === 'administration' && isDelegatedProfileAdministrator ? 'Resource profiles' : label}
              </a>
            ))}
          </WorkspaceSidebar>

          <main ref={workspacePanel} id="main-content" className="workspace-panel" tabIndex={-1}>
            {navigationNotice && <p className="supporting-copy" role="status">{navigationNotice}</p>}
            <header className="module-workspace-heading">
              <p className="eyebrow">PMO Hub module</p>
              <h1>Tech Resource Allocation</h1>
              {role && <p className="module-role">Role: {role}</p>}
            </header>

            {moduleDataAccessBlocked ? (
              <div className="form-error admin-access-revoked" role="alert">
                <p>Your module data access could not be confirmed. Protected records have been cleared.</p>
                <button type="button" className="secondary-button" onClick={() => { setModuleDataAccessBlocked(false); void refetchAccess(); }} disabled={accessQuery.isFetching}>
                  {accessQuery.isFetching ? 'Checking access…' : 'Check access again'}
                </button>
              </div>
            ) : !selectedPageIsAllowed ? (
              <div className="form-error page-access-denied" role="alert">
                <p>{activePage === 'administration' ? 'Resource profile administration is only available to Admins and in-scope resource leaders.' : 'Request queues are not available for this profile.'}</p>
                <a data-resource-allocation-navigation="true" href={resourceAllocationPageHref('requests')} onClick={(event) => navigateToPage('requests', event)}>Go to Requests</a>
              </div>
            ) : canUseModuleData && profileId ? (
              <Fragment key={`${profileId}:${generation}`}>
                {activePage === 'requests' && (
                  <RequestWorkspace
                    localUserId={profileId}
                    personId={accessQuery.data.person.id}
                    role={accessQuery.data.person.role}
                    onAccessDenied={handleModuleDataAccessDenied}
                  />
                )}
                {activePage === 'new-request' && <SubmissionWorkspace localUserId={profileId} onAccessDenied={handleModuleDataAccessDenied} />}
                {activePage === 'request-queues' && (
                  <RequestQueues
                    localUserId={profileId}
                    personId={accessQuery.data.person.id}
                    role={accessQuery.data.person.role}
                    groupId={accessQuery.data.person.groupId ?? null}
                    onAccessDenied={handleQueueAccessDenied}
                  />
                )}
                {activePage === 'allocations' && <AllocationsWorkspace localUserId={profileId} onAccessDenied={handleModuleDataAccessDenied} />}
                {activePage === 'notifications' && <NotificationsInbox localUserId={profileId} onAccessDenied={handleModuleDataAccessDenied} />}
                {activePage === 'administration' && profileAdministrationAccessBlocked && isDelegatedProfileAdministrator && (
                  <div className="form-error admin-access-revoked" role="alert">
                    <p>Your current profile-management scope could not be confirmed. Protected profile records have been cleared.</p>
                    <button type="button" className="secondary-button" onClick={() => { setProfileAdministrationAccessBlocked(false); void refetchAccess(); }} disabled={accessQuery.isFetching}>
                      {accessQuery.isFetching ? 'Checking access…' : 'Check profile access again'}
                    </button>
                  </div>
                )}
                {activePage === 'administration' && isAdministrator && <Administration localUserId={profileId} onAccessDenied={handleAdminAccessDenied} />}
                {activePage === 'administration' && isDelegatedProfileAdministrator && !profileAdministrationAccessBlocked && role && (
                  <ProfileAdministration localUserId={profileId} role={role} onAccessDenied={handleProfileAdministrationAccessDenied} />
                )}
              </Fragment>
            ) : null}

            {adminAccessBlocked && accessQuery.data?.person.role === 'ALLOCATION_ADMIN' && activePage !== 'administration' && (
              <div className="form-error admin-access-revoked" role="status">
                <p>Your Admin permission could not be confirmed. Administrative records have been cleared.</p>
                <button type="button" className="secondary-button" onClick={() => void refetchAccess()} disabled={accessQuery.isFetching}>
                  {accessQuery.isFetching ? 'Checking access…' : 'Check access again'}
                </button>
              </div>
            )}
          </main>
        </div>
      ) : (
        <main id="main-content" className="main-content" tabIndex={-1}>
          <div className="content-column">
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
          </div>
        </main>
      )}
    </div>
  );
}
