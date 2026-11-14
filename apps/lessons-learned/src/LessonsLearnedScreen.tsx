import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HubHeader } from '../../shared-ui/src/HubHeader';
import { useThemePreference } from '../../shared-ui/src/theme';
import {
  cancelLesson as cancelLessonRequest,
  createLessonDraft,
  getHome,
  getLessonProjects,
  getMyOpenDrafts,
  getMySubmissions,
  submitLesson as submitLessonRequest,
  updateLessonDraft,
  type LessonDraft,
  type CancelLessonBody,
  type SubmitLessonBody,
  type UpdateLessonDraftBody,
} from './api';
import { DraftEditor } from './DraftEditor';
import { ArchivedSubmissionDetailsDialog, CancelLessonDialog } from './SubmissionDialogs';

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

function getApiErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('status' in response)) return null;
  return typeof response.status === 'number' ? response.status : null;
}

function isDefinitiveAccessError(error: unknown): boolean {
  const errorCode = getApiErrorCode(error);
  return getApiErrorStatus(error) === 401
    || getApiErrorStatus(error) === 403
    || errorCode === 'AUTHENTICATION_REQUIRED'
    || errorCode === 'ACCESS_DENIED'
    || errorCode === 'ACCESS_CONFIGURATION_ERROR'
    || errorCode === 'LOCAL_AUTH_DISABLED';
}

function getRoleLabel(role: 'LESSONS_USER' | 'LESSONS_MODERATOR'): string {
  return role === 'LESSONS_MODERATOR' ? 'PMO' : 'Contributor';
}

type ModulePage = 'home' | 'my-submissions';

function readModulePage(): ModulePage {
  return new URLSearchParams(window.location.search).get('page') === 'my-submissions'
    ? 'my-submissions'
    : 'home';
}

export function LessonsLearnedScreen() {
  const [selectedProfileId, setSelectedProfileId] = useState(readSelectedProfileId);
  const [selectionGeneration, setSelectionGeneration] = useState(0);
  const [authorizedSelectionGeneration, setAuthorizedSelectionGeneration] = useState<number | null>(null);
  const [modulePage, setModulePage] = useState<ModulePage>(readModulePage);
  const { theme, selectTheme } = useThemePreference();
  const [isModuleMenuOpen, setIsModuleMenuOpen] = useState(false);
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState<LessonDraft | null>(null);
  const [selectedCancellationDraft, setSelectedCancellationDraft] = useState<LessonDraft | null>(null);
  const [selectedArchivedSubmission, setSelectedArchivedSubmission] = useState<LessonDraft | null>(null);
  const selectedProfileIdRef = useRef(selectedProfileId);
  const selectionGenerationRef = useRef(selectionGeneration);
  const pendingCreateProfilesRef = useRef(new Set<string>());
  const [pendingCreateProfiles, setPendingCreateProfiles] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const homeQuery = useQuery({
    queryKey: ['lessons-learned-home', selectedProfileId, selectionGeneration],
    queryFn: async () => {
      const profileId = selectedProfileId ?? '';
      const requestGeneration = selectionGeneration;
      const isCurrentSelection = () => (
        selectedProfileIdRef.current === profileId
        && selectionGenerationRef.current === requestGeneration
      );
      try {
        const home = await getHome(profileId);
        if (isCurrentSelection()) setAuthorizedSelectionGeneration(requestGeneration);
        return home;
      } catch (error) {
        if (isDefinitiveAccessError(error) && isCurrentSelection()) {
          setAuthorizedSelectionGeneration(null);
        }
        throw error;
      }
    },
    enabled: selectedProfileId !== null,
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: true,
  });
  const errorCode = homeQuery.isError ? getApiErrorCode(homeQuery.error) : null;
  const errorStatus = homeQuery.isError ? getApiErrorStatus(homeQuery.error) : null;
  const isAuthenticationRequired = homeQuery.isError && (
    errorCode === 'AUTHENTICATION_REQUIRED' || errorStatus === 401
  );
  const isAccessDenied = homeQuery.isError && !isAuthenticationRequired && (
    errorCode === 'ACCESS_DENIED' || errorStatus === 403
  );
  const isAccessConfigurationError = homeQuery.isError && (
    errorCode === 'ACCESS_CONFIGURATION_ERROR' || errorCode === 'LOCAL_AUTH_DISABLED'
  );
  const isDefinitiveAccessFailure = isAuthenticationRequired || isAccessDenied || isAccessConfigurationError;
  const hasUsableHomeData = homeQuery.data !== undefined
    && authorizedSelectionGeneration === selectionGeneration
    && !isDefinitiveAccessFailure;
  const isHomePage = selectedProfileId !== null && hasUsableHomeData;
  const showHomeRecheckError = isHomePage && homeQuery.isError && !homeQuery.isFetching;
  const isEditorOpen = isCreateFormOpen || selectedDraft !== null;
  const submissionsQuery = useQuery({
    queryKey: ['lessons-learned-my-submissions', selectedProfileId],
    queryFn: () => getMySubmissions(selectedProfileId ?? ''),
    enabled: isHomePage && modulePage === 'my-submissions',
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: true,
  });
  function markCreatePending(profileId: string, isPending: boolean) {
    const nextPendingProfiles = new Set(pendingCreateProfilesRef.current);
    if (isPending) nextPendingProfiles.add(profileId);
    else nextPendingProfiles.delete(profileId);
    pendingCreateProfilesRef.current = nextPendingProfiles;
    setPendingCreateProfiles(nextPendingProfiles);
  }

  const updateSelectedProfile = useCallback((profileId: string | null) => {
    if (profileId === selectedProfileIdRef.current) return;
    selectedProfileIdRef.current = profileId;
    selectionGenerationRef.current += 1;
    setSelectionGeneration(selectionGenerationRef.current);
    setSelectedProfileId(profileId);
    setAuthorizedSelectionGeneration(null);
    setSelectedDraft(null);
    setIsCreateFormOpen(false);
    setSelectedCancellationDraft(null);
    setSelectedArchivedSubmission(null);
  }, []);

  const isSavingCurrentDraft = selectedProfileId !== null && pendingCreateProfiles.has(selectedProfileId);
  const projectsQuery = useQuery({
    queryKey: ['lessons-learned-projects', selectedProfileId],
    queryFn: () => getLessonProjects(selectedProfileId ?? ''),
    enabled: isHomePage && modulePage === 'my-submissions' && (isCreateFormOpen || selectedDraft !== null),
    networkMode: 'always',
    retry: false,
  });

  useEffect(() => {
    if (!isDefinitiveAccessFailure) return;
    // An access revocation must discard the private editor state before a later recheck can restore the page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAuthorizedSelectionGeneration(null);
    setSelectedDraft(null);
    setIsCreateFormOpen(false);
    setSelectedCancellationDraft(null);
    setSelectedArchivedSubmission(null);
  }, [isDefinitiveAccessFailure]);

  async function saveDraftFields(input: UpdateLessonDraftBody, draftId: number | null): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before saving a lesson.');
    if (draftId === null) {
      if (pendingCreateProfilesRef.current.has(profileId)) throw new Error('A draft save is already in progress.');
      markCreatePending(profileId, true);
      try {
        const draftInput = {
          title: input.title,
          projectId: input.projectId,
          projectName: input.projectName,
          projectCategory: input.projectCategory,
          projectPhase: input.projectPhase,
          situationObserved: input.situationObserved,
          rootCause: input.rootCause,
          lessonType: input.lessonType,
          impact: input.impact,
          recommendation: input.recommendation,
          applicability: input.applicability,
        };
        const created = await createLessonDraft(profileId, draftInput);
        await queryClient.invalidateQueries({
          queryKey: ['lessons-learned-my-submissions', profileId],
        });
        return created;
      } finally {
        markCreatePending(profileId, false);
      }
    }

    const updated = await updateLessonDraft(profileId, draftId, input);
    await queryClient.invalidateQueries({
      queryKey: ['lessons-learned-my-submissions', profileId],
    });
    return updated;
  }

  async function reloadDraftFields(draftId: number): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before reloading a lesson.');
    const drafts = await getMyOpenDrafts(profileId);
    const latest = drafts.find((draft) => draft.id === draftId);
    if (!latest) throw new Error('This lesson is no longer an Open draft.');
    return latest;
  }

  async function submitDraft(input: SubmitLessonBody, draftId: number): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before submitting a lesson.');
    const submitted = await submitLessonRequest(profileId, draftId, input);
    await queryClient.invalidateQueries({
      queryKey: ['lessons-learned-my-submissions', profileId],
    });
    return submitted;
  }

  async function cancelDraft(draftId: number, input: CancelLessonBody): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before cancelling a lesson.');
    const cancelled = await cancelLessonRequest(profileId, draftId, input);
    await queryClient.invalidateQueries({
      queryKey: ['lessons-learned-my-submissions', profileId],
    });
    return cancelled;
  }

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
        profileName={(authorizedSelectionGeneration === selectionGeneration ? homeQuery.data?.profile.displayName : undefined)
          ?? selectedProfileId ?? undefined}
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

        {selectedProfileId && homeQuery.isFetching && !hasUsableHomeData && (
          <>
            <h1 id="page-title">Access check</h1>
            <p className="intro">Lessons Learned verifies your local profile before opening Home.</p>
            <div className="api-status" role="status" aria-live="polite">
              <span className="status-indicator is-checking" aria-hidden="true" />
              <span>Checking access for <strong>{selectedProfileId}</strong></span>
            </div>
          </>
        )}

        {selectedProfileId && !homeQuery.isFetching && isAuthenticationRequired && (
          <div className="api-status unavailable" role="alert" aria-live="assertive">
            <span className="status-indicator is-unavailable" aria-hidden="true" />
            <div>
              <h1 id="page-title">Authentication required</h1>
              <p>Your session is no longer authorized to access Lessons Learned. Retry the check or select a local profile.</p>
              <button className="retry-button" type="button" onClick={() => void homeQuery.refetch()}>Retry</button>
              <a className="primary-link" href="/">Select a local profile</a>
            </div>
          </div>
        )}

        {selectedProfileId && !homeQuery.isFetching && isAccessDenied && (
          <div className="api-status unavailable" role="alert" aria-live="assertive">
            <span className="status-indicator is-unavailable" aria-hidden="true" />
            <div>
              <h1 id="page-title">Access denied</h1>
              <p>Your local profile does not have access to Lessons Learned. Contact the PMO if you need access.</p>
              <a className="primary-link" href="/">Back to PMO Hub</a>
            </div>
          </div>
        )}

        {selectedProfileId && !homeQuery.isFetching && isAccessConfigurationError && (
          <div className="api-status unavailable" role="alert" aria-live="assertive">
            <span className="status-indicator is-unavailable" aria-hidden="true" />
            <div>
              <h1 id="page-title">Access configuration error</h1>
              <p>The Lessons Learned access configuration is invalid. Contact the responsible team.</p>
              <a className="primary-link" href="/">Back to PMO Hub</a>
            </div>
          </div>
        )}

        {selectedProfileId && !homeQuery.isFetching && homeQuery.isError && !hasUsableHomeData && !isDefinitiveAccessFailure && (
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

        {showHomeRecheckError && !isEditorOpen && (
          <div className="api-status unavailable" role="alert" aria-label="Home access check temporarily unavailable">
            <span className="status-indicator is-unavailable" aria-hidden="true" />
            <div>
              <p>The Home access recheck is temporarily unavailable. Your loaded page remains available; retry to verify access.</p>
              <button className="retry-button" type="button" onClick={() => void homeQuery.refetch()}>Retry access check</button>
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
                      <h1 id="page-title" tabIndex={-1}>My Submissions</h1>
                      <p className="intro">Your lessons. Open drafts can be edited or cancelled.</p>
                    </div>
                    <button className="draft-action" type="button" disabled={isSavingCurrentDraft} onClick={() => {
                      setSelectedDraft(null);
                      setIsCreateFormOpen(true);
                    }}>
                      Create lesson
                    </button>
                  </div>

                  {submissionsQuery.isPending && <p role="status">Loading your drafts…</p>}
                  {submissionsQuery.isError && (
                    <div className="draft-error" role="alert">
                      <p>Your drafts could not be loaded.</p>
                      <button className="draft-cancel" type="button" onClick={() => void submissionsQuery.refetch()}>Retry</button>
                    </div>
                  )}
                  {submissionsQuery.isSuccess && submissionsQuery.data.length === 0 && (
                    <p className="draft-empty">You have no submissions yet.</p>
                  )}
                  {submissionsQuery.isSuccess && submissionsQuery.data.length > 0 && (
                    <ul className="draft-list">
                      {submissionsQuery.data.map((draft) => (
                        <li key={draft.id}>
                          <div>
                            <p className="draft-title">{draft.title}</p>
                            <p className="draft-meta">{draft.status === 'Open' ? 'Draft' : 'Lesson'} #{draft.id} · {draft.status}</p>
                          </div>
                          {draft.status === 'Open' ? (
                            <div className="submission-actions">
                              <button
                                className="draft-cancel"
                                type="button"
                                onClick={() => setSelectedCancellationDraft(draft)}
                                aria-label={`Cancel ${draft.title}`}
                              >
                                Cancel
                              </button>
                              <button
                                className="draft-cancel"
                                type="button"
                                onClick={() => {
                                  setIsCreateFormOpen(false);
                                  setSelectedDraft(draft);
                                }}
                                aria-label={`Reopen ${draft.title}`}
                              >
                                Reopen
                              </button>
                            </div>
                          ) : (
                            <button
                              className="draft-cancel"
                              type="button"
                              onClick={() => setSelectedArchivedSubmission(draft)}
                              aria-label={`View ${draft.title}`}
                            >
                              View
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {isEditorOpen && (
                    <DraftEditor
                      key={selectedDraft?.id ?? 'new'}
                      draft={selectedDraft}
                      projects={projectsQuery.data ?? []}
                      projectsLoading={projectsQuery.isFetching}
                      projectsError={projectsQuery.isError && !projectsQuery.isFetching}
                      onRetryProjects={() => void projectsQuery.refetch()}
                      homeRecheckError={showHomeRecheckError}
                      onRetryHomeCheck={() => void homeQuery.refetch()}
                      onSave={saveDraftFields}
                      onSubmit={submitDraft}
                      onReload={reloadDraftFields}
                      onClose={() => {
                        setSelectedDraft(null);
                        setIsCreateFormOpen(false);
                      }}
                    />
                  )}
                  {selectedCancellationDraft && (
                    <CancelLessonDialog
                      draft={selectedCancellationDraft}
                      onConfirm={cancelDraft}
                      onClose={() => setSelectedCancellationDraft(null)}
                    />
                  )}
                  {selectedArchivedSubmission && (
                    <ArchivedSubmissionDetailsDialog
                      draft={selectedArchivedSubmission}
                      onClose={() => setSelectedArchivedSubmission(null)}
                    />
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
