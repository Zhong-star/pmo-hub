import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HubHeader } from '../../shared-ui/src/HubHeader';
import { useThemePreference } from '../../shared-ui/src/theme';
import {
  cancelLesson as cancelLessonRequest,
  createLessonDraft,
  getHome,
  getLessonDetails,
  getLessonProjects,
  getMyOpenDrafts,
  getMySubmissions,
  getPmoDrafts,
  submitLesson as submitLessonRequest,
  updateLessonDraft,
  type LessonDraft,
  type LessonProject,
  type LessonSubmissionsFilters,
  type PmoDraftsFilters,
  type CancelLessonBody,
  type SubmitLessonBody,
  type UpdateLessonDraftBody,
} from './api';
import { DraftEditor } from './DraftEditor';
import { LessonSubmissionDetailsDialog, CancelLessonDialog } from './SubmissionDialogs';

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

type ModulePage = 'home' | 'my-submissions' | 'pmo-drafts';

function readModulePage(): ModulePage {
  const page = new URLSearchParams(window.location.search).get('page');
  if (page === 'my-submissions') return 'my-submissions';
  if (page === 'pmo-drafts') return 'pmo-drafts';
  return 'home';
}

function formatUpdatedAt(timestamp: string): string {
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(timestamp))} UTC`;
}

type SubmissionProjectFilter =
  | { kind: 'any' }
  | { kind: 'without-project' }
  | { kind: 'project'; id: string };

function getProjectFilterOptionValue(filter: SubmissionProjectFilter): string {
  if (filter.kind === 'without-project') return 'without-project';
  if (filter.kind === 'project') return `project:${encodeURIComponent(filter.id)}`;
  return '';
}

function readProjectFilterOptionValue(value: string): SubmissionProjectFilter {
  if (value === 'without-project') return { kind: 'without-project' };
  if (value.startsWith('project:')) {
    try {
      return { kind: 'project', id: decodeURIComponent(value.slice('project:'.length)) };
    } catch {
      return { kind: 'any' };
    }
  }
  return { kind: 'any' };
}

function getProjectFilterOptions(
  catalogProjects: LessonProject[],
  submissions: LessonDraft[],
): LessonProject[] {
  const projectsById = new Map<string, LessonProject>();
  for (const submission of submissions) {
    if (submission.projectId && submission.projectName && !projectsById.has(submission.projectId)) {
      projectsById.set(submission.projectId, { id: submission.projectId, name: submission.projectName });
    }
  }
  for (const project of catalogProjects) {
    if (!projectsById.has(project.id)) projectsById.set(project.id, project);
  }
  return [...projectsById.values()];
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
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<number | null>(null);
  const [submissionSearch, setSubmissionSearch] = useState('');
  const [submissionProjectFilter, setSubmissionProjectFilter] = useState<SubmissionProjectFilter>({ kind: 'any' });
  const [submissionLessonType, setSubmissionLessonType] = useState<NonNullable<LessonDraft['lessonType']> | ''>('');
  const [submissionStatus, setSubmissionStatus] = useState<LessonDraft['status'] | ''>(
    () => readModulePage() === 'pmo-drafts' ? 'Open' : '',
  );
  const [submissionAuthorFilter, setSubmissionAuthorFilter] = useState('');
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
  const isPmo = homeQuery.data?.profile.role === 'LESSONS_MODERATOR';
  const isPmoDraftsPage = modulePage === 'pmo-drafts' && isPmo;
  const isMySubmissionsPage = modulePage === 'my-submissions';
  const showHomeRecheckError = isHomePage && homeQuery.isError && !homeQuery.isFetching;
  const isEditorOpen = isCreateFormOpen || selectedDraft !== null;
  const submissionsFilters: LessonSubmissionsFilters = {
    ...(submissionSearch.trim() ? { search: submissionSearch.trim() } : {}),
    ...(submissionProjectFilter.kind === 'project' ? { projectId: submissionProjectFilter.id } : {}),
    ...(submissionProjectFilter.kind === 'without-project' ? { withoutProject: true } : {}),
    ...(submissionLessonType ? { lessonType: submissionLessonType } : {}),
    ...(submissionStatus ? { status: submissionStatus } : {}),
  };
  const pmoDraftFilters: PmoDraftsFilters = {
    ...submissionsFilters,
    ...(submissionAuthorFilter ? { authorId: submissionAuthorFilter } : {}),
  };
  const submissionsQuery = useQuery({
    queryKey: ['lessons-learned-my-submissions', selectedProfileId, submissionsFilters],
    queryFn: () => Object.keys(submissionsFilters).length
      ? getMySubmissions(selectedProfileId ?? '', submissionsFilters)
      : getMySubmissions(selectedProfileId ?? ''),
    enabled: isHomePage && isMySubmissionsPage,
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: true,
  });
  const pmoDraftsQuery = useQuery({
    queryKey: ['lessons-learned-pmo-drafts', selectedProfileId, pmoDraftFilters],
    queryFn: () => getPmoDrafts(selectedProfileId ?? '', pmoDraftFilters),
    enabled: isHomePage && isPmoDraftsPage,
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: true,
  });
  const projectOptionsQuery = useQuery({
    queryKey: ['lessons-learned-project-options', selectedProfileId, isPmoDraftsPage ? 'pmo' : 'mine'],
    queryFn: () => isPmoDraftsPage
      ? getPmoDrafts(selectedProfileId ?? '')
      : getMySubmissions(selectedProfileId ?? ''),
    enabled: isHomePage && (isMySubmissionsPage || isPmoDraftsPage),
    networkMode: 'always',
    retry: false,
  });
  const submissionDetailsQuery = useQuery({
    queryKey: ['lessons-learned-submission-details', selectedProfileId, selectedSubmissionId],
    queryFn: () => getLessonDetails(selectedProfileId ?? '', selectedSubmissionId ?? 0),
    enabled: isHomePage && (isMySubmissionsPage || isPmoDraftsPage) && selectedSubmissionId !== null,
    networkMode: 'always',
    retry: false,
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
    setSelectedSubmissionId(null);
    setSubmissionSearch('');
    setSubmissionProjectFilter({ kind: 'any' });
    setSubmissionLessonType('');
    setSubmissionStatus('');
    setSubmissionAuthorFilter('');
  }, []);

  const isSavingCurrentDraft = selectedProfileId !== null && pendingCreateProfiles.has(selectedProfileId);
  const projectsQuery = useQuery({
    queryKey: ['lessons-learned-projects', selectedProfileId],
    queryFn: () => getLessonProjects(selectedProfileId ?? ''),
    enabled: isHomePage && (isMySubmissionsPage || isPmoDraftsPage),
    networkMode: 'always',
    retry: false,
  });
  const projectFilterOptions = getProjectFilterOptions(projectsQuery.data ?? [], projectOptionsQuery.data ?? []);
  const authorFilterOptions = [...new Set((projectOptionsQuery.data ?? []).map(({ authorId }) => authorId))].sort();
  const currentSubmissionsQuery = isPmoDraftsPage ? pmoDraftsQuery : submissionsQuery;
  const currentSubmissionFilters = isPmoDraftsPage ? pmoDraftFilters : submissionsFilters;

  async function refreshSubmissionQueries(profileId: string, lessonId?: number): Promise<void> {
    if (lessonId !== undefined) {
      queryClient.removeQueries({
        queryKey: ['lessons-learned-submission-details', profileId, lessonId],
        exact: true,
      });
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['lessons-learned-my-submissions', profileId] }),
      queryClient.invalidateQueries({ queryKey: ['lessons-learned-pmo-drafts', profileId] }),
      queryClient.invalidateQueries({ queryKey: ['lessons-learned-project-options', profileId] }),
    ]);
  }

  useEffect(() => {
    if (!isDefinitiveAccessFailure) return;
    // An access revocation must discard the private editor state before a later recheck can restore the page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAuthorizedSelectionGeneration(null);
    setSelectedDraft(null);
    setIsCreateFormOpen(false);
    setSelectedCancellationDraft(null);
    setSelectedSubmissionId(null);
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
        await refreshSubmissionQueries(profileId);
        return created;
      } finally {
        markCreatePending(profileId, false);
      }
    }

    const updated = await updateLessonDraft(profileId, draftId, input);
    await refreshSubmissionQueries(profileId, draftId);
    return updated;
  }

  async function reloadDraftFields(draftId: number): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before reloading a lesson.');
    const drafts = homeQuery.data?.profile.role === 'LESSONS_MODERATOR'
      ? await getPmoDrafts(profileId, { status: 'Open' })
      : await getMyOpenDrafts(profileId);
    const latest = drafts.find((draft) => draft.id === draftId);
    if (!latest) {
      throw Object.assign(new Error('This lesson is no longer an Open draft.'), { code: 'LESSON_NOT_OPEN' });
    }
    return latest;
  }

  async function submitDraft(input: SubmitLessonBody, draftId: number): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before submitting a lesson.');
    const submitted = await submitLessonRequest(profileId, draftId, input);
    await refreshSubmissionQueries(profileId, draftId);
    return submitted;
  }

  async function cancelDraft(draftId: number, input: CancelLessonBody): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before cancelling a lesson.');
    const cancelled = await cancelLessonRequest(profileId, draftId, input);
    await refreshSubmissionQueries(profileId, draftId);
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
      const page = readModulePage();
      setModulePage(page);
      setSubmissionSearch('');
      setSubmissionProjectFilter({ kind: 'any' });
      setSubmissionLessonType('');
      setSubmissionStatus(page === 'pmo-drafts' ? 'Open' : '');
      setSubmissionAuthorFilter('');
      setSelectedDraft(null);
      setIsCreateFormOpen(false);
    }

    window.addEventListener('popstate', restorePageFromUrl);
    return () => window.removeEventListener('popstate', restorePageFromUrl);
  }, []);

  function navigateTo(page: ModulePage, event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const path = page === 'home'
      ? '/lessons-learned/'
      : `/lessons-learned/?page=${page}`;
    window.history.pushState(null, '', path);
    setModulePage(page);
    setSubmissionSearch('');
    setSubmissionProjectFilter({ kind: 'any' });
    setSubmissionLessonType('');
    setSubmissionStatus(page === 'pmo-drafts' ? 'Open' : '');
    setSubmissionAuthorFilter('');
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
                    aria-current={(modulePage === 'home' || (!isPmo && modulePage === 'pmo-drafts')) && destination.current ? 'page' : undefined}
                    onClick={(event) => navigateTo('home', event)}
                  >
                    {destination.label}
                  </a>
                ))}
                <a
                  href="/lessons-learned/?page=my-submissions"
                  aria-current={isMySubmissionsPage ? 'page' : undefined}
                  onClick={(event) => navigateTo('my-submissions', event)}
                >
                  My Submissions
                </a>
                {isPmo && (
                  <a
                    href="/lessons-learned/?page=pmo-drafts"
                    aria-current={isPmoDraftsPage ? 'page' : undefined}
                    onClick={(event) => navigateTo('pmo-drafts', event)}
                  >
                    PMO Drafts
                  </a>
                )}
              </nav>
            </aside>
            <div className="module-content">
              {modulePage === 'home' || (modulePage === 'pmo-drafts' && !isPmo) ? (
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
                      <h1 id="page-title" tabIndex={-1}>{isPmoDraftsPage ? 'PMO Drafts' : 'My Submissions'}</h1>
                      <p className="intro">{isPmoDraftsPage
                        ? 'Find lessons across the module. Only Open lessons can be edited or cancelled.'
                        : 'Your lessons. Open drafts can be edited or cancelled.'}</p>
                    </div>
                    {!isPmoDraftsPage && (
                      <button className="draft-action" type="button" disabled={isSavingCurrentDraft} onClick={() => {
                        setSelectedDraft(null);
                        setIsCreateFormOpen(true);
                      }}>
                        Create lesson
                      </button>
                    )}
                  </div>

                  <div className="submission-filters" role="group" aria-label={isPmoDraftsPage ? 'Filter PMO Drafts' : 'Filter My Submissions'}>
                    <div className="draft-editor-field">
                      <label htmlFor="submission-search">Search title or ID</label>
                      <input
                        id="submission-search"
                        type="search"
                        value={submissionSearch}
                        placeholder="Title prefix or exact ID"
                        onChange={(event) => setSubmissionSearch(event.target.value)}
                      />
                    </div>
                    <div className="draft-editor-field">
                      <label htmlFor="submission-project">Project</label>
                      <select
                        id="submission-project"
                        value={getProjectFilterOptionValue(submissionProjectFilter)}
                        onChange={(event) => setSubmissionProjectFilter(readProjectFilterOptionValue(event.target.value))}
                      >
                        <option value="">Any project</option>
                        <option value="without-project">No project</option>
                        {projectFilterOptions.map((project) => (
                          <option key={project.id} value={getProjectFilterOptionValue({ kind: 'project', id: project.id })}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="draft-editor-field">
                      <label htmlFor="submission-type">Lesson type</label>
                      <select id="submission-type" value={submissionLessonType} onChange={(event) => setSubmissionLessonType(event.target.value as NonNullable<LessonDraft['lessonType']> | '')}>
                        <option value="">Any type</option>
                        <option value="Future Prevention">Future Prevention</option>
                        <option value="Success to Repeat">Success to Repeat</option>
                        <option value="Risk Avoided">Risk Avoided</option>
                        <option value="Communication">Communication</option>
                      </select>
                    </div>
                    <div className="draft-editor-field">
                      <label htmlFor="submission-status">Status</label>
                      <select id="submission-status" value={submissionStatus} onChange={(event) => setSubmissionStatus(event.target.value as LessonDraft['status'] | '')}>
                        <option value="">Any status</option>
                        <option value="Open">Open</option>
                        <option value="PMOEvaluation">PMO Evaluation</option>
                        <option value="Approved">Approved</option>
                        <option value="Closed">Closed</option>
                        <option value="Archived">Archived</option>
                      </select>
                    </div>
                    {isPmoDraftsPage && (
                      <div className="draft-editor-field">
                        <label htmlFor="submission-author">Author</label>
                        <select
                          id="submission-author"
                          value={submissionAuthorFilter}
                          onChange={(event) => setSubmissionAuthorFilter(event.target.value)}
                        >
                          <option value="">Any author</option>
                          {authorFilterOptions.map((authorId) => (
                            <option key={authorId} value={authorId}>{authorId}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                  {projectsQuery.isError && !projectsQuery.isFetching && (
                    <div className="draft-error" role="alert">
                      <p>The project filter options could not be loaded.</p>
                      <button className="draft-cancel" type="button" onClick={() => void projectsQuery.refetch()}>Retry projects</button>
                    </div>
                  )}
                  {projectOptionsQuery.isError && !projectOptionsQuery.isFetching && (
                    <div className="draft-error" role="alert">
                      <p>Past project filter options could not be loaded.</p>
                      <button className="draft-cancel" type="button" onClick={() => void projectOptionsQuery.refetch()}>
                        Retry project filters
                      </button>
                    </div>
                  )}

                  {currentSubmissionsQuery.isPending && <p role="status">{isPmoDraftsPage ? 'Loading PMO Drafts…' : 'Loading your submissions…'}</p>}
                  {currentSubmissionsQuery.isError && (
                    <div className="draft-error" role="alert">
                      <p>{isPmoDraftsPage ? 'PMO Drafts could not be loaded.' : 'Your submissions could not be loaded.'}</p>
                      <button className="draft-cancel" type="button" onClick={() => void currentSubmissionsQuery.refetch()}>Retry</button>
                    </div>
                  )}
                  {currentSubmissionsQuery.isSuccess && currentSubmissionsQuery.data.length === 0 && (
                    <p className="draft-empty">{isPmoDraftsPage
                      ? Object.keys(currentSubmissionFilters).length ? 'No lessons match these filters.' : 'No lessons are available.'
                      : Object.keys(currentSubmissionFilters).length ? 'No submissions match these filters.' : 'You have no submissions yet.'}</p>
                  )}
                  {isPmoDraftsPage && currentSubmissionsQuery.isSuccess && currentSubmissionsQuery.data.length > 0 && (
                    <div className="submission-table-wrapper">
                      <table className="submission-table">
                        <caption className="visually-hidden">Lessons available to PMO</caption>
                        <thead>
                          <tr>
                            <th scope="col">Title</th>
                            <th scope="col">ID</th>
                            <th scope="col">Author</th>
                            <th scope="col">Project</th>
                            <th scope="col">Type</th>
                            <th scope="col">Status</th>
                            <th scope="col">Updated</th>
                            <th scope="col">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentSubmissionsQuery.data.map((draft) => (
                            <tr key={draft.id}>
                              <th scope="row">
                                <button
                                  className="submission-title-link"
                                  type="button"
                                  onClick={() => setSelectedSubmissionId(draft.id)}
                                  aria-label={`View ${draft.title}`}
                                >
                                  {draft.title}
                                </button>
                              </th>
                              <td>#{draft.id}</td>
                              <td>{draft.authorId}</td>
                              <td>{draft.projectName ?? 'No project'}</td>
                              <td>{draft.lessonType ?? 'Not specified'}</td>
                              <td>{draft.status}</td>
                              <td><time dateTime={draft.updatedAt}>{formatUpdatedAt(draft.updatedAt)}</time></td>
                              <td>
                                <div className="submission-actions">
                                  {draft.status === 'Open' && (
                                    <>
                                      <button
                                        className="draft-cancel"
                                        type="button"
                                        onClick={() => {
                                          setIsCreateFormOpen(false);
                                          setSelectedDraft(draft);
                                        }}
                                        aria-label={`Edit ${draft.title}`}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        className="draft-cancel"
                                        type="button"
                                        onClick={() => setSelectedCancellationDraft(draft)}
                                        aria-label={`Cancel ${draft.title}`}
                                      >
                                        Cancel
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {!isPmoDraftsPage && currentSubmissionsQuery.isSuccess && currentSubmissionsQuery.data.length > 0 && (
                    <ul className="draft-list">
                      {currentSubmissionsQuery.data.map((draft) => (
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
                              <button
                                className="draft-cancel"
                                type="button"
                                onClick={() => setSelectedSubmissionId(draft.id)}
                                aria-label={`View ${draft.title}`}
                              >
                                View
                              </button>
                            </div>
                          ) : (
                            <button
                              className="draft-cancel"
                              type="button"
                              onClick={() => setSelectedSubmissionId(draft.id)}
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
                      canSubmit={selectedDraft === null || selectedDraft.authorId === selectedProfileId}
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
                      onReload={reloadDraftFields}
                      onConfirm={cancelDraft}
                      onClose={() => setSelectedCancellationDraft(null)}
                    />
                  )}
                  {selectedSubmissionId !== null && (
                    <LessonSubmissionDetailsDialog
                      lessonId={selectedSubmissionId}
                      details={submissionDetailsQuery.data}
                      isLoading={submissionDetailsQuery.isLoading}
                      hasError={submissionDetailsQuery.isError}
                      onRetry={() => void submissionDetailsQuery.refetch()}
                      onClose={() => setSelectedSubmissionId(null)}
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
