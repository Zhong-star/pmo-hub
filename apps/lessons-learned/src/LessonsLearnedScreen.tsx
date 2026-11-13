import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HubHeader } from '../../shared-ui/src/HubHeader';
import { useThemePreference } from '../../shared-ui/src/theme';
import { createLessonDraft, getHome, getMyOpenDrafts } from './api';

const LOCAL_USER_STORAGE_KEY = 'pmo-hub.local-user-id';

function readSelectedProfileId(): string | null {
  try {
    const id = window.localStorage.getItem(LOCAL_USER_STORAGE_KEY)?.trim();
    return id || null;
  } catch {
    return null;
  }
}

function getApiErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return null;
  const data = response.data;
  if (typeof data !== 'object' || data === null || !('code' in data)) return null;
  return typeof data.code === 'string' ? data.code : null;
}

function getRoleLabel(role: 'LESSONS_USER' | 'LESSONS_MODERATOR'): string {
  return role === 'LESSONS_MODERATOR' ? 'PMO' : 'Contributor';
}

type ModulePage = 'home' | 'my-submissions';
type CreateDraftVariables = { profileId: string; title: string; submittedTitle: string };

function readModulePage(): ModulePage {
  return new URLSearchParams(window.location.search).get('page') === 'my-submissions'
    ? 'my-submissions'
    : 'home';
}

export function LessonsLearnedScreen() {
  const [selectedProfileId, setSelectedProfileId] = useState(readSelectedProfileId);
  const [modulePage, setModulePage] = useState<ModulePage>(readModulePage);
  const { theme, selectTheme } = useThemePreference();
  const [isModuleMenuOpen, setIsModuleMenuOpen] = useState(false);
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftTitleError, setDraftTitleError] = useState<string | null>(null);
  const [selectedDraft, setSelectedDraft] = useState<Awaited<ReturnType<typeof getMyOpenDrafts>>[number] | null>(null);
  const selectedProfileIdRef = useRef(selectedProfileId);
  const draftTitleRef = useRef(draftTitle);
  const pendingCreateProfilesRef = useRef(new Set<string>());
  const [pendingCreateProfiles, setPendingCreateProfiles] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const homeQuery = useQuery({
    queryKey: ['lessons-learned-home', selectedProfileId],
    queryFn: () => getHome(selectedProfileId ?? ''),
    enabled: selectedProfileId !== null,
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: true,
  });
  const errorCode = homeQuery.isError ? getApiErrorCode(homeQuery.error) : null;
  const isHomePage = selectedProfileId !== null && !homeQuery.isFetching && homeQuery.isSuccess && !homeQuery.isError;
  const submissionsQuery = useQuery({
    queryKey: ['lessons-learned-my-submissions', selectedProfileId],
    queryFn: () => getMyOpenDrafts(selectedProfileId ?? ''),
    enabled: isHomePage && modulePage === 'my-submissions',
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: true,
  });
  const createDraftMutation = useMutation({
    mutationFn: ({ profileId, title }: CreateDraftVariables) => createLessonDraft(profileId, title),
    onSuccess: async (_draft, variables) => {
      if (
        selectedProfileIdRef.current === variables.profileId &&
        draftTitleRef.current === variables.submittedTitle
      ) {
        draftTitleRef.current = '';
        setDraftTitle('');
        setDraftTitleError(null);
        setIsCreateFormOpen(false);
      }
      await queryClient.invalidateQueries({
        queryKey: ['lessons-learned-my-submissions', variables.profileId],
      });
    },
    onSettled: (_draft, _error, variables) => markCreatePending(variables.profileId, false),
  });

  function markCreatePending(profileId: string, isPending: boolean) {
    const nextPendingProfiles = new Set(pendingCreateProfilesRef.current);
    if (isPending) nextPendingProfiles.add(profileId);
    else nextPendingProfiles.delete(profileId);
    pendingCreateProfilesRef.current = nextPendingProfiles;
    setPendingCreateProfiles(nextPendingProfiles);
  }

  const resetCreateDraftMutation = createDraftMutation.reset;
  const updateSelectedProfile = useCallback((profileId: string | null) => {
    if (profileId === selectedProfileIdRef.current) return;
    selectedProfileIdRef.current = profileId;
    setSelectedProfileId(profileId);
    draftTitleRef.current = '';
    setDraftTitle('');
    setDraftTitleError(null);
    setSelectedDraft(null);
    setIsCreateFormOpen(false);
    resetCreateDraftMutation();
  }, [resetCreateDraftMutation]);

  const isSavingCurrentDraft = selectedProfileId !== null && pendingCreateProfiles.has(selectedProfileId);

  useEffect(() => {
    function handleStorageChange(event: StorageEvent) {
      if (event.key === null || event.key === LOCAL_USER_STORAGE_KEY) {
        updateSelectedProfile(readSelectedProfileId());
      }
    }

    function restoreSelectedProfile() {
      updateSelectedProfile(readSelectedProfileId());
    }

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('pageshow', restoreSelectedProfile);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('pageshow', restoreSelectedProfile);
    };
  }, [updateSelectedProfile]);

  useEffect(() => {
    function restorePageFromUrl() {
      setModulePage(readModulePage());
      setSelectedDraft(null);
      setIsCreateFormOpen(false);
    }

    window.addEventListener('popstate', restorePageFromUrl);
    return () => window.removeEventListener('popstate', restorePageFromUrl);
  }, []);

  function navigateTo(page: ModulePage, event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const path = page === 'my-submissions'
      ? '/lessons-learned/?page=my-submissions'
      : '/lessons-learned/';
    window.history.pushState(null, '', path);
    setModulePage(page);
    setSelectedDraft(null);
    setIsCreateFormOpen(false);
    setIsModuleMenuOpen(false);
  }

  function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProfileId || pendingCreateProfilesRef.current.has(selectedProfileId)) return;
    const title = draftTitle.trim();
    if (!title) {
      setDraftTitleError('Enter a title to save this draft.');
      return;
    }
    if (title.length > 150) {
      setDraftTitleError('Title must be 150 characters or fewer.');
      return;
    }
    setDraftTitleError(null);
    markCreatePending(selectedProfileId, true);
    createDraftMutation.mutate({ profileId: selectedProfileId, title, submittedTitle: draftTitle });
  }

  function changeProfile() {
    try {
      window.localStorage.removeItem(LOCAL_USER_STORAGE_KEY);
    } catch {
      // The Hub still presents profile selection when browser storage is unavailable.
    }
    updateSelectedProfile(null);
    window.location.assign('/');
  }

  return (
    <div className="app-shell">
      <HubHeader
        profileName={homeQuery.data?.profile.displayName ?? selectedProfileId ?? undefined}
        onChangeProfile={selectedProfileId ? changeProfile : undefined}
        theme={theme}
        onThemeChange={selectTheme}
      />
      <main className="page-shell">
      <section
        className={isHomePage ? 'module-card module-card-with-navigation' : 'module-card'}
        aria-labelledby="page-title"
      >
        <p className="eyebrow">Lessons Learned</p>

        {!selectedProfileId && (
          <>
            <h1 id="page-title">Access check</h1>
            <p className="intro">No local profile is selected. Return to PMO Hub and select a profile to continue.</p>
            <a className="primary-link" href="/">Select a local profile</a>
          </>
        )}

        {selectedProfileId && homeQuery.isFetching && (
          <>
            <h1 id="page-title">Access check</h1>
            <p className="intro">Lessons Learned verifies your local profile before opening Home.</p>
            <div className="api-status" role="status" aria-live="polite">
              <span className="status-indicator is-checking" aria-hidden="true" />
              <span>Checking access for <strong>{selectedProfileId}</strong></span>
            </div>
          </>
        )}

        {selectedProfileId && !homeQuery.isFetching && homeQuery.isError && errorCode === 'ACCESS_DENIED' && (
          <div className="api-status unavailable" role="alert" aria-live="assertive">
            <span className="status-indicator is-unavailable" aria-hidden="true" />
            <div>
              <h1 id="page-title">Access denied</h1>
              <p>Your local profile does not have access to Lessons Learned. Contact the PMO if you need access.</p>
              <a className="primary-link" href="/">Back to PMO Hub</a>
            </div>
          </div>
        )}

        {selectedProfileId && !homeQuery.isFetching && homeQuery.isError && (
          errorCode === 'ACCESS_CONFIGURATION_ERROR' || errorCode === 'LOCAL_AUTH_DISABLED'
        ) && (
          <div className="api-status unavailable" role="alert" aria-live="assertive">
            <span className="status-indicator is-unavailable" aria-hidden="true" />
            <div>
              <h1 id="page-title">Access configuration error</h1>
              <p>The Lessons Learned access configuration is invalid. Contact the responsible team.</p>
              <a className="primary-link" href="/">Back to PMO Hub</a>
            </div>
          </div>
        )}

        {selectedProfileId && !homeQuery.isFetching && homeQuery.isError && errorCode !== 'ACCESS_DENIED' &&
          errorCode !== 'ACCESS_CONFIGURATION_ERROR' && errorCode !== 'LOCAL_AUTH_DISABLED' && (
            <div className="api-status unavailable" role="alert" aria-live="assertive">
              <span className="status-indicator is-unavailable" aria-hidden="true" />
              <div>
                <h1 id="page-title">Access check temporarily unavailable</h1>
                <p>The API could not complete the access check. Retry to continue.</p>
                <button className="retry-button" type="button" onClick={() => void homeQuery.refetch()}>
                  Retry
                </button>
              </div>
            </div>
          )}

        {isHomePage && (
          <div className="module-layout">
            <aside
              className="module-sidebar"
              aria-label="Lessons Learned navigation"
              data-menu-open={isModuleMenuOpen}
            >
              <button
                className="module-menu-toggle"
                type="button"
                aria-controls="module-navigation"
                aria-expanded={isModuleMenuOpen}
                onClick={() => setIsModuleMenuOpen((isOpen) => !isOpen)}
              >
                Module menu
              </button>
              <nav id="module-navigation" className="module-navigation" aria-label="Lessons Learned">
                {homeQuery.data.navigation.map((destination) => (
                  <a
                    key={destination.id}
                  href="/lessons-learned/"
                  aria-current={modulePage === 'home' && destination.current ? 'page' : undefined}
                  onClick={(event) => navigateTo('home', event)}
                >
                  {destination.label}
                </a>
              ))}
              <a
                href="/lessons-learned/?page=my-submissions"
                aria-current={modulePage === 'my-submissions' ? 'page' : undefined}
                onClick={(event) => navigateTo('my-submissions', event)}
              >
                My Submissions
              </a>
              </nav>
            </aside>
            <div className="module-content">
              {modulePage === 'home' ? (
                <>
                  <h1 id="page-title">Home</h1>
                  <p className="intro">Welcome, {homeQuery.data.profile.displayName}</p>
                  <p className="active-role">Active role: <strong>{getRoleLabel(homeQuery.data.profile.role)}</strong></p>
                  <a className="primary-link" href="/">Back to PMO Hub</a>
                </>
              ) : (
                <section className="submissions-page" aria-labelledby="page-title">
                  <div className="submissions-header">
                    <div>
                      <h1 id="page-title">My Submissions</h1>
                      <p className="intro">Your open lesson drafts.</p>
                    </div>
                    <button className="draft-action" type="button" disabled={isSavingCurrentDraft} onClick={() => {
                      setSelectedDraft(null);
                      draftTitleRef.current = '';
                      setDraftTitle('');
                      setDraftTitleError(null);
                      createDraftMutation.reset();
                      setIsCreateFormOpen(true);
                    }}>
                      Create lesson
                    </button>
                  </div>

                  {createDraftMutation.isSuccess && createDraftMutation.variables?.profileId === selectedProfileId && (
                    <p className="draft-success" role="status">Draft saved.</p>
                  )}
                  {createDraftMutation.isError && createDraftMutation.variables?.profileId === selectedProfileId && (
                    <p className="draft-error" role="alert">The draft could not be saved. Your title is still here; try again.</p>
                  )}

                  {isCreateFormOpen && (
                    <form className="draft-form" onSubmit={saveDraft}>
                      <h2>Create lesson</h2>
                      <label htmlFor="draft-title">Title</label>
                      <input
                        id="draft-title"
                        type="text"
                        maxLength={150}
                        required
                        disabled={isSavingCurrentDraft}
                        value={draftTitle}
                        onChange={(event) => {
                          draftTitleRef.current = event.target.value;
                          setDraftTitle(event.target.value);
                          setDraftTitleError(null);
                          if (!pendingCreateProfilesRef.current.has(selectedProfileId)) createDraftMutation.reset();
                        }}
                        aria-invalid={draftTitleError ? 'true' : undefined}
                        aria-describedby={draftTitleError ? 'draft-title-error' : 'draft-title-count'}
                      />
                      {draftTitleError ? (
                        <p id="draft-title-error" className="draft-error">{draftTitleError}</p>
                      ) : (
                        <p id="draft-title-count" className="draft-helper">{draftTitle.length}/150 characters</p>
                      )}
                      <div className="draft-form-actions">
                        <button className="draft-action" type="submit" disabled={isSavingCurrentDraft}>
                          {isSavingCurrentDraft ? 'Saving…' : 'Save Draft'}
                        </button>
                        <button className="draft-cancel" type="button" disabled={isSavingCurrentDraft} onClick={() => setIsCreateFormOpen(false)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}

                  {submissionsQuery.isPending && <p role="status">Loading your drafts…</p>}
                  {submissionsQuery.isError && (
                    <div className="draft-error" role="alert">
                      <p>Your drafts could not be loaded.</p>
                      <button className="draft-cancel" type="button" onClick={() => void submissionsQuery.refetch()}>Retry</button>
                    </div>
                  )}
                  {submissionsQuery.isSuccess && submissionsQuery.data.length === 0 && (
                    <p className="draft-empty">You have no open drafts yet.</p>
                  )}
                  {submissionsQuery.isSuccess && submissionsQuery.data.length > 0 && (
                    <ul className="draft-list">
                      {submissionsQuery.data.map((draft) => (
                        <li key={draft.id}>
                          <div>
                            <p className="draft-title">{draft.title}</p>
                            <p className="draft-meta">Draft #{draft.id} · Open</p>
                          </div>
                          <button
                            className="draft-cancel"
                            type="button"
                            onClick={() => setSelectedDraft(draft)}
                            aria-label={`Reopen ${draft.title}`}
                          >
                            Reopen
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {selectedDraft && (
                    <dialog open className="draft-dialog" aria-labelledby="draft-dialog-title">
                      <h2 id="draft-dialog-title">Open draft</h2>
                      <p>{selectedDraft.title}</p>
                      <p className="draft-meta">Draft #{selectedDraft.id} · Open</p>
                      <button className="draft-action" type="button" onClick={() => setSelectedDraft(null)}>Close</button>
                    </dialog>
                  )}
                </section>
              )}
            </div>
          </div>
        )}
      </section>
      </main>
    </div>
  );
}
