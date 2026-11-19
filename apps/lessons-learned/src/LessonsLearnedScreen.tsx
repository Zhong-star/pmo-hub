import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { WorkspaceSidebar } from '../../shared-ui/src/WorkspaceSidebar';
import { HubHeader } from '../../shared-ui/src/HubHeader';
import { useThemePreference } from '../../shared-ui/src/theme';
import {
  approveLesson as approveLessonRequest,
  castLessonVote,
  closeLesson as closeLessonRequest,
  cancelLesson as cancelLessonRequest,
  createLessonDraft,
  getHome,
  getEvaluationProjectSnapshots,
  getLibrary,
  getLibraryLessonDetails,
  getLibraryProjectSnapshots,
  recordLibraryView,
  removeLessonVote,
  getLessonDetails,
  getLessonProjects,
  getMyOpenDrafts,
  getMySubmissions,
  getPmoDrafts,
  getPmoDashboard,
  getPmoEvaluationQueue,
  returnLesson as returnLessonRequest,
  rejectLesson as rejectLessonRequest,
  submitLesson as submitLessonRequest,
  updateLessonDraft,
  type LessonDraft,
  type LessonPage,
  type LessonDetails,
  type LibraryLesson,
  type LibraryPage,
  type LessonProject,
  type LessonSubmissionsFilters,
  type LessonsLibraryFilters,
  type PmoDraftsFilters,
  type PmoDashboardCard,
  type PmoDashboardFilters,
  type PmoDashboardSort,
  type PmoEvaluationQueueFilters,
  type CancelLessonBody,
  type ApproveLessonBody,
  type RejectLessonBody,
  type CloseLessonBody,
  type SubmitLessonBody,
  type ReturnLessonBody,
  type UpdateLessonDraftBody,
} from './api';
import { DraftEditor } from './DraftEditor';
import { ApprovalDialog } from './ApprovalDialogs';
import { ClosureDialog } from './ClosureDialog';
import { LessonSubmissionDetailsDialog, CancelLessonDialog, RejectLessonDialog } from './SubmissionDialogs';
import { ReturnLessonDialog } from './ReturnLessonDialog';
import { PmoDashboardView } from './PmoDashboardView';
import { getLibraryLessonHref, useLibraryNavigation } from './useLibraryNavigation';

const LOCAL_USER_STORAGE_KEY = 'pmo-hub.local-user-id';
const HISTORY_POSITION_KEY = '__pmoHubLessonsLearnedHistoryPosition';

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

type ModulePage = 'home' | 'my-submissions' | 'pmo-drafts' | 'evaluation-queue' | 'pmo-dashboard' | 'library';
type LibrarySort = NonNullable<LessonsLibraryFilters['sort']>;

function getLibrarySortCaption(sort: LibrarySort): string {
  if (sort === 'oldest') return 'Published lessons, oldest approval first';
  if (sort === 'most-voted') return 'Published lessons, most voted first';
  if (sort === 'title') return 'Published lessons, title order';
  if (sort === 'project') return 'Published lessons, project order';
  if (sort === 'type') return 'Published lessons, type order';
  return 'Published lessons, newest approval first';
}

function readModulePage(): ModulePage {
  const page = new URLSearchParams(window.location.search).get('page');
  if (page === 'my-submissions') return 'my-submissions';
  if (page === 'pmo-drafts') return 'pmo-drafts';
  if (page === 'evaluation-queue') return 'evaluation-queue';
  if (page === 'pmo-dashboard') return 'pmo-dashboard';
  if (page === 'library') return 'library';
  return 'home';
}

function getHistoryPosition(state: unknown): number | null {
  if (typeof state !== 'object' || state === null || !(HISTORY_POSITION_KEY in state)) return null;
  const position = (state as Record<string, unknown>)[HISTORY_POSITION_KEY];
  return typeof position === 'number' ? position : null;
}

function withHistoryPosition(state: unknown, position: number): Record<string, unknown> {
  return {
    ...(typeof state === 'object' && state !== null ? state : {}),
    [HISTORY_POSITION_KEY]: position,
  };
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
  submissions: Pick<LessonDraft, 'projectId' | 'projectName'>[],
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

function flattenLessonPages(pages: (LessonPage | LibraryPage | LessonDraft[])[]): (LessonDraft | LibraryLesson)[] {
  const legacy = pages.find(Array.isArray);
  if (legacy) return legacy;
  const byId = new Map<number, LessonDraft | LibraryLesson>();
  for (const page of pages) {
    if (!Array.isArray(page)) for (const lesson of page.items) byId.set(lesson.id, lesson);
  }
  return Array.from(byId.values());
}

function isLibraryLesson(lesson: LessonDraft | LibraryLesson): lesson is LibraryLesson {
  return 'viewCount' in lesson && typeof lesson.viewCount === 'number';
}

function isPublishedLibraryLesson(lesson: LessonDetails): boolean {
  return (lesson.status === 'Approved' || lesson.status === 'Closed') && Boolean(lesson.approvedAt);
}

async function getLegacyPublishedLibraryLesson(profileId: string, lessonId: number): Promise<LessonDetails> {
  const lesson = await getLessonDetails(profileId, lessonId);
  if (!isPublishedLibraryLesson(lesson)) throw new Error('Published lesson is unavailable.');
  return lesson;
}

function createLibraryOpeningId(): string {
  if (typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function updateLibraryPageViewCount(
  page: LibraryPage | LibraryLesson[],
  lessonId: number,
  viewCount: number,
): LibraryPage | LibraryLesson[] {
  const update = (lesson: LibraryLesson) => lesson.id === lessonId
    ? { ...lesson, viewCount: Math.max(lesson.viewCount, viewCount) }
    : lesson;
  return Array.isArray(page) ? page.map(update) : { ...page, items: page.items.map(update) };
}

function updateLibraryPageVote(
  page: LibraryPage | LibraryLesson[],
  lessonId: number,
  votesCount: number,
  hasVoted: boolean,
): LibraryPage | LibraryLesson[] {
  const update = (lesson: LibraryLesson) => lesson.id === lessonId
    ? { ...lesson, votesCount, hasVoted }
    : lesson;
  return Array.isArray(page) ? page.map(update) : { ...page, items: page.items.map(update) };
}

export function LessonsLearnedScreen() {
  const [selectedProfileId, setSelectedProfileId] = useState(readSelectedProfileId);
  const [selectionGeneration, setSelectionGeneration] = useState(0);
  const [authorizedSelectionGeneration, setAuthorizedSelectionGeneration] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const libraryOpeningRef = useRef<{
    profileId: string;
    lessonId: number;
    openingId: string;
    status: 'ready' | 'recording' | 'recorded' | 'failed';
  } | null>(null);
  const [modulePage, setModulePage] = useState<ModulePage>(readModulePage);
  const {
    lessonId: libraryDetailId,
    openLesson: openLibraryLesson,
    closeLesson: closeLibraryLesson,
    clearLesson: clearLibraryLesson,
  } = useLibraryNavigation();
  const { theme, selectTheme } = useThemePreference();
  const [isModuleMenuOpen, setIsModuleMenuOpen] = useState(false);
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState<LessonDraft | null>(null);
  const [selectedCancellationDraft, setSelectedCancellationDraft] = useState<LessonDraft | null>(null);
  const [selectedReturnLesson, setSelectedReturnLesson] = useState<LessonDetails | null>(null);
  const [selectedApprovalDraft, setSelectedApprovalDraft] = useState<LessonDraft | null>(null);
  const [selectedRejectionDraft, setSelectedRejectionDraft] = useState<LessonDraft | null>(null);
  const [selectedClosureDraft, setSelectedClosureDraft] = useState<LessonDraft | null>(null);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<number | null>(null);
  const [submissionSearch, setSubmissionSearch] = useState('');
  const [submissionProjectFilter, setSubmissionProjectFilter] = useState<SubmissionProjectFilter>({ kind: 'any' });
  const [submissionLessonType, setSubmissionLessonType] = useState<NonNullable<LessonDraft['lessonType']> | ''>('');
  const [librarySort, setLibrarySort] = useState<LibrarySort>('newest');
  const [dashboardCard, setDashboardCard] = useState<PmoDashboardCard | ''>('');
  const [dashboardSort, setDashboardSort] = useState<PmoDashboardSort>('activity');
  const [submissionStatus, setSubmissionStatus] = useState<LessonDraft['status'] | ''>(
    () => readModulePage() === 'pmo-drafts' ? 'Open' : '',
  );
  const [submissionAuthorFilter, setSubmissionAuthorFilter] = useState('');
  const navigationCloseRequestRef = useRef<(() => boolean) | null>(null);
  const currentHistoryPositionRef = useRef(0);
  const pendingHistoryDeltaRef = useRef<number | null>(null);
  const isRevertingHistoryRef = useRef(false);
  const isResumingHistoryRef = useRef(false);
  const selectedProfileIdRef = useRef(selectedProfileId);
  const selectionGenerationRef = useRef(selectionGeneration);
  const pendingCreateProfilesRef = useRef(new Set<string>());
  const [pendingCreateProfiles, setPendingCreateProfiles] = useState<Set<string>>(new Set());
  const pendingVoteIdsRef = useRef(new Set<number>());
  const [pendingVoteIds, setPendingVoteIds] = useState<Set<number>>(new Set());
  const [voteError, setVoteError] = useState<{ lessonId: number; message: string } | null>(null);
  const queryClient = useQueryClient();
  const resetSubmissionFilters = useCallback((destination: ModulePage) => {
    setSubmissionSearch('');
    setSubmissionProjectFilter({ kind: 'any' });
    setSubmissionLessonType('');
    setSubmissionStatus(destination === 'pmo-drafts' ? 'Open' : '');
    setSubmissionAuthorFilter('');
    setDashboardCard('');
    setDashboardSort('activity');
  }, []);

  const applyPageFromLocation = useCallback(() => {
    const page = readModulePage();
    setModulePage(page);
    if (page !== 'library' || modulePage !== 'library') resetSubmissionFilters(page);
    setSelectedDraft(null);
    setIsCreateFormOpen(false);
    setSelectedCancellationDraft(null);
    setSelectedReturnLesson(null);
    setSelectedApprovalDraft(null);
    setSelectedRejectionDraft(null);
    setSelectedClosureDraft(null);
    setSelectedSubmissionId(null);
    setIsModuleMenuOpen(false);
  }, [modulePage, resetSubmissionFilters]);

  const registerNavigationCloseRequest = useCallback((requestClose: (() => boolean) | null) => {
    navigationCloseRequestRef.current = requestClose;
  }, []);
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
  const isPmoEvaluationQueuePage = modulePage === 'evaluation-queue' && isPmo;
  const isPmoDashboardPage = modulePage === 'pmo-dashboard' && isPmo;
  const isPmoDashboardDenied = modulePage === 'pmo-dashboard' && !isPmo;
  const isPmoReviewListPage = isPmoDraftsPage || isPmoEvaluationQueuePage;
  const isMySubmissionsPage = modulePage === 'my-submissions';
  const isLibraryPage = modulePage === 'library';
  const isSubmissionTablePage = isPmoReviewListPage || isLibraryPage;
  const showHomeRecheckError = isHomePage && homeQuery.isError && !homeQuery.isFetching;
  const isEditorOpen = isCreateFormOpen || selectedDraft !== null;
  const commonSubmissionFilters: PmoEvaluationQueueFilters = {
    ...(submissionSearch.trim() ? { search: submissionSearch.trim() } : {}),
    ...(submissionProjectFilter.kind === 'project' ? { projectId: submissionProjectFilter.id } : {}),
    ...(submissionProjectFilter.kind === 'without-project' ? { withoutProject: true } : {}),
    ...(submissionLessonType ? { lessonType: submissionLessonType } : {}),
  };
  const submissionsFilters: LessonSubmissionsFilters = {
    ...commonSubmissionFilters,
    ...(submissionStatus ? { status: submissionStatus } : {}),
  };
  const pmoDraftFilters: PmoDraftsFilters = {
    ...submissionsFilters,
    ...(submissionAuthorFilter ? { authorId: submissionAuthorFilter } : {}),
  };
  const pmoDashboardFilters: PmoDashboardFilters = {
    ...submissionsFilters,
    ...(dashboardCard ? { card: dashboardCard } : {}),
    ...(dashboardSort === 'activity' ? {} : { sort: dashboardSort }),
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
  const pmoDashboardQuery = useQuery({
    queryKey: ['lessons-learned-pmo-dashboard', selectedProfileId, pmoDashboardFilters],
    queryFn: () => Object.keys(pmoDashboardFilters).length
      ? getPmoDashboard(selectedProfileId ?? '', pmoDashboardFilters)
      : getPmoDashboard(selectedProfileId ?? ''),
    enabled: isHomePage && isPmoDashboardPage,
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: true,
  });
  const evaluationQueueQuery = useInfiniteQuery({
    queryKey: ['lessons-learned-evaluation-queue', selectedProfileId, commonSubmissionFilters],
    queryFn: ({ pageParam }) => getPmoEvaluationQueue(selectedProfileId ?? '', commonSubmissionFilters, { paged: 'true', cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => Array.isArray(lastPage) ? undefined : lastPage.page.nextCursor ?? undefined,
    enabled: isHomePage && isPmoEvaluationQueuePage,
    gcTime: 0,
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: true,
  });
  const libraryFilters: LessonsLibraryFilters = {
    ...commonSubmissionFilters,
    ...(librarySort === 'newest' ? {} : { sort: librarySort }),
  };
  const libraryProjectsQuery = useQuery({
    queryKey: ['lessons-learned-project-options', selectedProfileId, 'library'],
    queryFn: () => getLibraryProjectSnapshots(selectedProfileId ?? ''),
    enabled: isHomePage && isLibraryPage,
    networkMode: 'always',
    retry: false,
  });
  const libraryCapabilityResolved = libraryProjectsQuery.isSuccess || libraryProjectsQuery.isError;
  const isLegacyLibrary = libraryProjectsQuery.isError && getApiErrorStatus(libraryProjectsQuery.error) === 404;
  const libraryQuery = useInfiniteQuery({
    queryKey: ['lessons-learned-library', selectedProfileId, isLegacyLibrary ? 'legacy' : libraryFilters],
    queryFn: ({ pageParam }) => isLegacyLibrary
      ? getLibrary(selectedProfileId ?? '', { paged: 'true', cursor: pageParam })
      : getLibrary(selectedProfileId ?? '', {
        ...libraryFilters,
        paged: 'true',
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => Array.isArray(lastPage) ? undefined : lastPage.page.nextCursor ?? undefined,
    enabled: isHomePage && isLibraryPage && libraryCapabilityResolved,
    networkMode: 'always',
    retry: false,
    refetchOnWindowFocus: true,
  });
  const projectOptionsQuery = useQuery({
    queryKey: [
      'lessons-learned-project-options',
      selectedProfileId,
      isPmoDraftsPage ? 'pmo-drafts' : 'mine',
    ],
    queryFn: () => isPmoDraftsPage
      ? getPmoDrafts(selectedProfileId ?? '')
      : getMySubmissions(selectedProfileId ?? ''),
    enabled: isHomePage && (isMySubmissionsPage || isPmoDraftsPage),
    networkMode: 'always',
    retry: false,
  });
  const evaluationProjectsQuery = useQuery({
    queryKey: ['lessons-learned-project-options', selectedProfileId, 'evaluation-queue'],
    queryFn: ({ signal }) => getEvaluationProjectSnapshots(selectedProfileId ?? '', signal),
    enabled: isHomePage && isPmoEvaluationQueuePage,
    networkMode: 'always',
    retry: false,
  });
  const submissionDetailsQuery = useQuery({
    queryKey: ['lessons-learned-submission-details', selectedProfileId, selectedSubmissionId],
    queryFn: () => getLessonDetails(selectedProfileId ?? '', selectedSubmissionId ?? 0),
    enabled: isHomePage && (isMySubmissionsPage || isPmoReviewListPage || isPmoDashboardPage) && selectedSubmissionId !== null,
    networkMode: 'always',
    retry: false,
  });
  const libraryDetailsQuery = useQuery({
    queryKey: ['lessons-learned-library-details', selectedProfileId, libraryDetailId, isLegacyLibrary ? 'legacy' : 'current'],
    queryFn: () => isLegacyLibrary
      ? getLegacyPublishedLibraryLesson(selectedProfileId ?? '', libraryDetailId ?? 0)
      : getLibraryLessonDetails(selectedProfileId ?? '', libraryDetailId ?? 0),
    enabled: isHomePage && isLibraryPage && libraryDetailId !== null && libraryCapabilityResolved,
    networkMode: 'always',
    retry: false,
  });
  const isLibraryDetailOpen = isLibraryPage && libraryDetailId !== null;
  // A cached response cannot authorize showing content or history on a new opening.
  const isLibraryDetailLoading = libraryDetailsQuery.isPending || libraryDetailsQuery.isFetching;
  const confirmedLibraryDetails = libraryDetailsQuery.isSuccess && !isLibraryDetailLoading
    ? libraryDetailsQuery.data
    : undefined;
  const { mutate: recordView } = useMutation({
    mutationFn: ({ profileId, lessonId, openingId }: { profileId: string; lessonId: number; openingId: string }) =>
      recordLibraryView(profileId, lessonId, { openingId }),
    retry: 2,
    networkMode: 'always',
    onSuccess: (result, opening) => {
      const currentOpening = libraryOpeningRef.current;
      if (currentOpening?.openingId === opening.openingId) currentOpening.status = 'recorded';
      queryClient.setQueriesData<InfiniteData<LibraryPage | LibraryLesson[]>>(
        { queryKey: ['lessons-learned-library', opening.profileId] },
        (current) => current ? {
          ...current,
          pages: current.pages.map((page) => updateLibraryPageViewCount(page, opening.lessonId, result.viewCount)),
        } : current,
      );
    },
    onError: (_error, opening) => {
      const currentOpening = libraryOpeningRef.current;
      if (currentOpening?.openingId === opening.openingId) currentOpening.status = 'failed';
    },
  });
  useEffect(() => {
    if (!isHomePage || !isLibraryPage || isLegacyLibrary || !libraryDetailsQuery.isSuccess || !selectedProfileId || libraryDetailId === null) return;
    const opening = libraryOpeningRef.current;
    if (!opening || opening.status !== 'ready' || opening.lessonId !== libraryDetailId || opening.profileId !== selectedProfileId) return;
    if (libraryDetailsQuery.isFetching || libraryDetailsQuery.data?.id !== libraryDetailId) return;

    opening.status = 'recording';
    recordView({
      profileId: opening.profileId,
      lessonId: opening.lessonId,
      openingId: opening.openingId,
    });
  }, [isHomePage, isLibraryPage, isLegacyLibrary, libraryDetailId, libraryDetailsQuery.data, libraryDetailsQuery.isFetching, libraryDetailsQuery.isSuccess, recordView, selectedProfileId]);
  useEffect(() => {
    const opening = libraryOpeningRef.current;
    if (opening?.status === 'ready' && libraryDetailId !== opening.lessonId) opening.status = 'failed';
  }, [libraryDetailId]);
  const refetchHomeAccess = homeQuery.refetch;
  useEffect(() => {
    if (libraryDetailsQuery.isError && isDefinitiveAccessError(libraryDetailsQuery.error)) {
      void refetchHomeAccess();
    }
  }, [libraryDetailsQuery.error, libraryDetailsQuery.isError, refetchHomeAccess]);
  function markCreatePending(profileId: string, isPending: boolean) {
    const nextPendingProfiles = new Set(pendingCreateProfilesRef.current);
    if (isPending) nextPendingProfiles.add(profileId);
    else nextPendingProfiles.delete(profileId);
    pendingCreateProfilesRef.current = nextPendingProfiles;
    setPendingCreateProfiles(nextPendingProfiles);
  }

  function markVotePending(lessonId: number, isPending: boolean) {
    const next = new Set(pendingVoteIdsRef.current);
    if (isPending) next.add(lessonId);
    else next.delete(lessonId);
    pendingVoteIdsRef.current = next;
    setPendingVoteIds(next);
  }

  function applyVoteToCaches(profileId: string, lessonId: number, votesCount: number, hasVoted: boolean) {
    queryClient.setQueriesData<InfiniteData<LibraryPage | LibraryLesson[]>>(
      { queryKey: ['lessons-learned-library', profileId] },
      (current) => current ? {
        ...current,
        pages: current.pages.map((page) => updateLibraryPageVote(page, lessonId, votesCount, hasVoted)),
      } : current,
    );
    queryClient.setQueriesData<LessonDetails>(
      { queryKey: ['lessons-learned-library-details', profileId, lessonId] },
      (current) => current ? { ...current, votesCount, hasVoted } : current,
    );
    queryClient.setQueriesData<LessonDetails>(
      { queryKey: ['lessons-learned-submission-details', profileId, lessonId] },
      (current) => current ? { ...current, votesCount, hasVoted } : current,
    );
  }

  async function toggleLessonVote(lesson: { id: number; votesCount: number; hasVoted: boolean }) {
    const profileId = selectedProfileIdRef.current;
    if (!profileId || pendingVoteIdsRef.current.has(lesson.id)) return;

    const previous = { votesCount: lesson.votesCount, hasVoted: lesson.hasVoted };
    const nextHasVoted = !previous.hasVoted;
    const nextVotesCount = Math.max(0, previous.votesCount + (nextHasVoted ? 1 : -1));

    markVotePending(lesson.id, true);
    setVoteError((current) => (current?.lessonId === lesson.id ? null : current));
    applyVoteToCaches(profileId, lesson.id, nextVotesCount, nextHasVoted);

    try {
      const updated = nextHasVoted
        ? await castLessonVote(profileId, lesson.id)
        : await removeLessonVote(profileId, lesson.id);
      applyVoteToCaches(profileId, lesson.id, updated.votesCount, updated.hasVoted);
    } catch {
      applyVoteToCaches(profileId, lesson.id, previous.votesCount, previous.hasVoted);
      if (selectedProfileIdRef.current === profileId) {
        setVoteError({
          lessonId: lesson.id,
          message: 'Your vote could not be updated. Please try again.',
        });
      }
    } finally {
      markVotePending(lesson.id, false);
    }
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
    setSelectedApprovalDraft(null);
    setSelectedRejectionDraft(null);
    setSelectedClosureDraft(null);
    setSelectedSubmissionId(null);
    setVoteError(null);
    resetSubmissionFilters(modulePage);
  }, [modulePage, resetSubmissionFilters]);

  const isSavingCurrentDraft = selectedProfileId !== null && pendingCreateProfiles.has(selectedProfileId);
  const projectsQuery = useQuery({
    queryKey: ['lessons-learned-projects', selectedProfileId],
    queryFn: () => getLessonProjects(selectedProfileId ?? ''),
    enabled: isHomePage && (isMySubmissionsPage || isPmoReviewListPage || isPmoDashboardPage),
    networkMode: 'always',
    retry: false,
  });
  const currentProjectOptionsQuery = isLibraryPage
    ? libraryProjectsQuery
    : isPmoEvaluationQueuePage ? evaluationProjectsQuery : projectOptionsQuery;
  const projectFilterOptions = isLibraryPage
    ? libraryProjectsQuery.data ?? []
    : isPmoEvaluationQueuePage
      ? getProjectFilterOptions(projectsQuery.data ?? [], (evaluationProjectsQuery.data ?? []).map(({ id, name }) => ({ projectId: id, projectName: name })))
      : getProjectFilterOptions(projectsQuery.data ?? [], projectOptionsQuery.data ?? []);
  const authorFilterOptions = [...new Set((projectOptionsQuery.data ?? []).map(({ authorId }) => authorId))].sort();
  const currentSubmissionsQuery = isPmoDraftsPage
    ? pmoDraftsQuery
    : isPmoEvaluationQueuePage ? evaluationQueueQuery : isLibraryPage ? libraryQuery : submissionsQuery;
  const pagedQuery = isPmoEvaluationQueuePage ? evaluationQueueQuery : isLibraryPage ? libraryQuery : undefined;
  const submissionItems = pagedQuery
    ? flattenLessonPages(pagedQuery.data?.pages ?? [])
    : (isPmoDraftsPage ? pmoDraftsQuery.data : submissionsQuery.data) ?? [];
  const currentSubmissionFilters = isPmoDraftsPage
    ? pmoDraftFilters
    : isPmoEvaluationQueuePage || isLibraryPage ? commonSubmissionFilters : submissionsFilters;
  const activeLibraryFilterLabels = [
    ...(submissionSearch.trim() ? [`Search: “${submissionSearch.trim()}”`] : []),
    ...(submissionProjectFilter.kind === 'without-project'
      ? ['Project: No project']
      : submissionProjectFilter.kind === 'project'
        ? [`Project: ${projectFilterOptions.find(({ id }) => id === submissionProjectFilter.id)?.name ?? submissionProjectFilter.id}`]
        : []),
    ...(submissionLessonType ? [`Type: ${submissionLessonType}`] : []),
  ];

  function openLibraryLessonFromList(lessonId: number) {
    if (!selectedProfileId) return;
    libraryOpeningRef.current = isLegacyLibrary ? null : {
      profileId: selectedProfileId,
      lessonId,
      openingId: createLibraryOpeningId(),
      status: 'ready',
    };
    openLibraryLesson(lessonId);
  }

  async function refreshSubmissionQueries(profileId: string, lessonId?: number): Promise<void> {
    if (lessonId !== undefined) {
      queryClient.removeQueries({
        queryKey: ['lessons-learned-submission-details', profileId, lessonId],
        exact: true,
      });
      queryClient.removeQueries({
        queryKey: ['lessons-learned-library-details', profileId, lessonId],
        exact: false,
      });
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['lessons-learned-my-submissions', profileId] }),
      queryClient.invalidateQueries({ queryKey: ['lessons-learned-pmo-drafts', profileId] }),
      queryClient.invalidateQueries({ queryKey: ['lessons-learned-pmo-dashboard', profileId] }),
      queryClient.invalidateQueries({ queryKey: ['lessons-learned-evaluation-queue', profileId] }),
      queryClient.invalidateQueries({ queryKey: ['lessons-learned-project-options', profileId] }),
      queryClient.invalidateQueries({ queryKey: ['lessons-learned-library', profileId] }),
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
    setSelectedReturnLesson(null);
    setSelectedApprovalDraft(null);
    setSelectedRejectionDraft(null);
    setSelectedClosureDraft(null);
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
    const isEvaluationEdit = selectedDraft?.id === draftId && selectedDraft.status === 'PMOEvaluation';
    const drafts = homeQuery.data?.profile.role === 'LESSONS_MODERATOR'
      ? isEvaluationEdit ? await getPmoEvaluationQueue(profileId) : await getPmoDrafts(profileId, { status: 'Open' })
      : await getMyOpenDrafts(profileId);
    const latest = drafts.find((draft) => draft.id === draftId);
    if (!latest) {
      const code = isEvaluationEdit ? 'LESSON_NOT_IN_EVALUATION' : 'LESSON_NOT_OPEN';
      throw Object.assign(new Error('This lesson is no longer editable in its current state.'), { code });
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

  async function returnLesson(draftId: number, input: ReturnLessonBody): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before returning a lesson.');
    const returned = await returnLessonRequest(profileId, draftId, input);
    await refreshSubmissionQueries(profileId, draftId);
    return returned;
  }

  async function reloadLessonDetails(lessonId: number): Promise<LessonDetails> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before reloading a lesson.');
    return getLessonDetails(profileId, lessonId);
  }

  async function approveDraft(draftId: number, input: ApproveLessonBody): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before approving a lesson.');
    const approved = await approveLessonRequest(profileId, draftId, input);
    await refreshSubmissionQueries(profileId, draftId);
    setSelectedApprovalDraft(null);
    setSelectedSubmissionId(null);
    return approved;
  }

  async function closeDraft(draftId: number, input: CloseLessonBody): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before closing a lesson.');
    const closed = await closeLessonRequest(profileId, draftId, input);
    await refreshSubmissionQueries(profileId, draftId);
    setSelectedClosureDraft(null);
    setSelectedSubmissionId(null);
    if (isLibraryPage && libraryDetailId !== null) closeLibraryLesson();
    return closed;
  }

  async function reloadApprovalLesson(lessonId: number): Promise<LessonDetails> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before reloading a lesson.');
    const latest = await getLessonDetails(profileId, lessonId);
    queryClient.setQueryData(['lessons-learned-submission-details', profileId, lessonId], latest);
    setSelectedApprovalDraft(null);
    return latest;
  }


  async function reloadRejectionEvaluation(lessonId: number): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before reloading an evaluation.');
    const latest = await getLessonDetails(profileId, lessonId);
    if (latest.status !== 'PMOEvaluation') {
      throw Object.assign(new Error('This lesson no longer awaits PMO evaluation.'), {
        code: 'LESSON_NOT_AWAITING_EVALUATION',
      });
    }
    return latest;
  }

  async function rejectEvaluation(lessonId: number, input: RejectLessonBody): Promise<LessonDraft> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before rejecting a lesson.');
    const rejected = await rejectLessonRequest(profileId, lessonId, input);
    await refreshSubmissionQueries(profileId, lessonId);
    return rejected;
  }

  async function reloadClosureLesson(lessonId: number): Promise<LessonDetails> {
    const profileId = selectedProfileIdRef.current;
    if (!profileId) throw new Error('Select a profile before reloading a lesson.');
    const latest = isLibraryPage
      ? isLegacyLibrary
        ? await getLegacyPublishedLibraryLesson(profileId, lessonId)
        : await getLibraryLessonDetails(profileId, lessonId)
      : await getLessonDetails(profileId, lessonId);
    const detailsKey = isLibraryPage ? 'lessons-learned-library-details' : 'lessons-learned-submission-details';
    queryClient.setQueryData([
      detailsKey,
      profileId,
      lessonId,
      ...(isLibraryPage ? [isLegacyLibrary ? 'legacy' : 'current'] : []),
    ], latest);
    setSelectedClosureDraft(null);
    return latest;
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
    const initialPosition = getHistoryPosition(window.history.state);
    if (initialPosition === null) {
      currentHistoryPositionRef.current = 0;
      window.history.replaceState(withHistoryPosition(window.history.state, 0), '', window.location.href);
    } else {
      currentHistoryPositionRef.current = initialPosition;
    }

    function handlePopState(event: PopStateEvent) {
      if (isResumingHistoryRef.current) {
        isResumingHistoryRef.current = false;
        const resumedPosition = getHistoryPosition(event.state);
        if (resumedPosition !== null) currentHistoryPositionRef.current = resumedPosition;
        applyPageFromLocation();
        return;
      }

      if (isRevertingHistoryRef.current) {
        isRevertingHistoryRef.current = false;
        const delta = pendingHistoryDeltaRef.current;
        pendingHistoryDeltaRef.current = null;
        if (delta === null) return;
        if (navigationCloseRequestRef.current?.() ?? true) {
          isResumingHistoryRef.current = true;
          window.history.go(delta);
        }
        return;
      }

      const destinationPosition = getHistoryPosition(event.state);
      const delta = destinationPosition === null
        ? -1
        : destinationPosition - currentHistoryPositionRef.current;
      if (navigationCloseRequestRef.current && delta !== 0) {
        pendingHistoryDeltaRef.current = delta;
        isRevertingHistoryRef.current = true;
        window.history.go(-delta);
        return;
      }

      if (destinationPosition !== null) currentHistoryPositionRef.current = destinationPosition;
      applyPageFromLocation();
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [applyPageFromLocation]);

  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [modulePage]);

  function navigateModulePage(page: ModulePage) {
    const path = page === 'home'
      ? '/lessons-learned/'
      : `/lessons-learned/?page=${page}`;
    const nextPosition = currentHistoryPositionRef.current + 1;
    window.history.pushState(withHistoryPosition(window.history.state, nextPosition), '', path);
    currentHistoryPositionRef.current = nextPosition;
    clearLibraryLesson();
    setModulePage(page);
    resetSubmissionFilters(page);
    setSelectedDraft(null);
    setIsCreateFormOpen(false);
    setSelectedCancellationDraft(null);
    setSelectedReturnLesson(null);
    setSelectedApprovalDraft(null);
    setSelectedRejectionDraft(null);
    setSelectedClosureDraft(null);
    setSelectedSubmissionId(null);
    setIsModuleMenuOpen(false);
  }

  function navigateTo(page: ModulePage, event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (navigationCloseRequestRef.current && !navigationCloseRequestRef.current()) return;
    navigateModulePage(page);
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
    <div className={isHomePage ? 'app-shell workspace-shell' : 'app-shell'}>
      <HubHeader
        profileName={(authorizedSelectionGeneration === selectionGeneration ? homeQuery.data?.profile.displayName : undefined)
          ?? selectedProfileId ?? undefined}
        onChangeProfile={selectedProfileId ? changeProfile : undefined}
        theme={theme}
        onThemeChange={selectTheme}
      />
      <div className={isHomePage ? 'workspace-layout' : 'page-shell'}>
        {isHomePage && (
          <WorkspaceSidebar
            label="Lessons Learned navigation"
            navigationLabel="Lessons Learned"
            navigationId="module-navigation"
            open={isModuleMenuOpen}
            onToggle={() => setIsModuleMenuOpen((open) => !open)}
          >
            {homeQuery.data.navigation.map((destination) => (
              <a
                key={destination.id}
                href="/lessons-learned/"
                aria-current={(
                  modulePage === 'home'
                  || (!isPmo && (modulePage === 'pmo-drafts' || modulePage === 'evaluation-queue'))
                ) && destination.current ? 'page' : undefined}
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
            <a
              href="/lessons-learned/?page=library"
              aria-current={isLibraryPage ? 'page' : undefined}
              onClick={(event) => navigateTo('library', event)}
            >
              Lessons Library
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
            {isPmo && (
              <a
                href="/lessons-learned/?page=evaluation-queue"
                aria-current={isPmoEvaluationQueuePage ? 'page' : undefined}
                onClick={(event) => navigateTo('evaluation-queue', event)}
              >
                Evaluation Queue
              </a>
            )}
            {isPmo && (
              <a
                href="/lessons-learned/?page=pmo-dashboard"
                aria-current={isPmoDashboardPage ? 'page' : undefined}
                onClick={(event) => navigateTo('pmo-dashboard', event)}
              >
                PMO Dashboard
              </a>
            )}
          </WorkspaceSidebar>
        )}
        <main ref={panelRef} className={isHomePage ? 'workspace-panel' : 'module-access'} tabIndex={isHomePage ? 0 : undefined}>
      <section
        className={isHomePage ? undefined : 'module-card'}
        aria-labelledby="page-title"
      >
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
          <>
              {isPmoDashboardDenied ? (
                <div className="api-status unavailable" role="alert" aria-live="assertive">
                  <span className="status-indicator is-unavailable" aria-hidden="true" />
                  <div>
                    <h1 id="page-title">Access denied</h1>
                    <p>The PMO Dashboard is restricted to PMO moderators.</p>
                    <a
                      className="primary-link"
                      href="/lessons-learned/"
                      onClick={(event) => navigateTo('home', event)}
                    >
                      Back to Home
                    </a>
                  </div>
                </div>
              ) : modulePage === 'home' || (!isPmo && (modulePage === 'pmo-drafts' || modulePage === 'evaluation-queue')) ? (
                <>
                  <h1 id="page-title">Home</h1>
                  <p className="intro">Welcome, {homeQuery.data.profile.displayName}</p>
                  <p className="active-role">Active role: <strong>{getRoleLabel(homeQuery.data.profile.role)}</strong></p>
                  <a className="primary-link" href="/">Back to PMO Hub</a>
                </>
              ) : (
                <section className="submissions-page" aria-labelledby="page-title">
                  {isPmoDashboardPage ? (
                    <PmoDashboardView
                      data={pmoDashboardQuery.data}
                      isLoading={pmoDashboardQuery.isPending}
                      isError={pmoDashboardQuery.isError}
                      onRetry={() => void pmoDashboardQuery.refetch()}
                      search={submissionSearch}
                      onSearchChange={setSubmissionSearch}
                      projectFilter={submissionProjectFilter}
                      onProjectFilterChange={setSubmissionProjectFilter}
                      projectOptions={getProjectFilterOptions(
                        projectsQuery.data ?? [],
                        (pmoDashboardQuery.data?.projects ?? []).map((project) => ({
                          projectId: project.id,
                          projectName: project.name,
                        })),
                      )}
                      lessonType={submissionLessonType}
                      onLessonTypeChange={setSubmissionLessonType}
                      status={submissionStatus}
                      onStatusChange={setSubmissionStatus}
                      activeCard={dashboardCard}
                      onCardToggle={(card) => setDashboardCard((current) => current === card ? '' : card)}
                      sort={dashboardSort}
                      onSortChange={setDashboardSort}
                      onClearFilters={() => {
                        setSubmissionSearch('');
                        setSubmissionProjectFilter({ kind: 'any' });
                        setSubmissionLessonType('');
                        setSubmissionStatus('');
                        setDashboardCard('');
                      }}
                      onOpenReviewQueue={(event) => navigateTo('evaluation-queue', event)}
                      onViewLesson={(lessonId) => setSelectedSubmissionId(lessonId)}
                    />
                  ) : (
                    <>
                  <div className="submissions-header">
                    <div>
                      <h1 id="page-title" tabIndex={-1}>{isLibraryPage
                        ? 'Lessons Library'
                        : isPmoEvaluationQueuePage ? 'Evaluation Queue'
                          : isPmoDraftsPage ? 'PMO Drafts' : 'My Submissions'}</h1>
                      {!isLibraryPage && (
                        <p className="intro">{isPmoEvaluationQueuePage
                          ? 'Oldest submission first.'
                          : isPmoDraftsPage
                            ? 'Only Open lessons can be edited or cancelled.'
                            : 'Open drafts can be edited or cancelled.'}</p>
                      )}
                    </div>
                    {!isPmoReviewListPage && (
                      <button className="draft-action" type="button" disabled={isSavingCurrentDraft} onClick={() => {
                        setSelectedDraft(null);
                        setIsCreateFormOpen(true);
                      }}>
                        Create lesson
                      </button>
                    )}
                  </div>

                  {isLibraryPage && !isLegacyLibrary && (
                    <>
                      <div className="submission-filters" role="group" aria-label="Search, filter, and sort Lessons Library">
                        <div className="draft-editor-field">
                          <label htmlFor="library-search">Search title or ID</label>
                          <input
                            id="library-search"
                            type="search"
                            value={submissionSearch}
                            placeholder="Title prefix, ID or #ID"
                            onChange={(event) => setSubmissionSearch(event.target.value)}
                          />
                        </div>
                        <div className="draft-editor-field">
                          <label htmlFor="library-project">Project</label>
                          <select
                            id="library-project"
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
                          <label htmlFor="library-type">Lesson type</label>
                          <select id="library-type" value={submissionLessonType} onChange={(event) => setSubmissionLessonType(event.target.value as NonNullable<LessonDraft['lessonType']> | '')}>
                            <option value="">Any type</option>
                            <option value="Future Prevention">Future Prevention</option>
                            <option value="Success to Repeat">Success to Repeat</option>
                            <option value="Risk Avoided">Risk Avoided</option>
                            <option value="Communication">Communication</option>
                          </select>
                        </div>
                        <div className="draft-editor-field">
                          <label htmlFor="library-sort">Sort by</label>
                          <select
                            id="library-sort"
                            value={librarySort}
                            onChange={(event) => setLibrarySort(event.target.value as LibrarySort)}
                          >
                            <option value="newest">Most recently approved</option>
                            <option value="oldest">Oldest approval</option>
                            <option value="most-voted">Most voted</option>
                            <option value="title">Title</option>
                            <option value="project">Project</option>
                            <option value="type">Lesson type</option>
                          </select>
                        </div>
                        {activeLibraryFilterLabels.length > 0 && (
                          <button className="draft-cancel" type="button" onClick={() => {
                            setSubmissionSearch('');
                            setSubmissionProjectFilter({ kind: 'any' });
                            setSubmissionLessonType('');
                          }}>
                            Clear filters
                          </button>
                        )}
                      </div>
                      {activeLibraryFilterLabels.length > 0 && (
                        <p className="draft-meta" role="status">Active filters: {activeLibraryFilterLabels.join(' · ')}</p>
                      )}
                    </>
                  )}

                  {!isLibraryPage && <div className="submission-filters" role="group" aria-label={isPmoEvaluationQueuePage
                    ? 'Filter Evaluation Queue'
                    : isPmoDraftsPage ? 'Filter PMO Drafts' : 'Filter My Submissions'}>
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
                    {!isPmoEvaluationQueuePage && <div className="draft-editor-field">
                      <label htmlFor="submission-status">Status</label>
                      <select id="submission-status" value={submissionStatus} onChange={(event) => setSubmissionStatus(event.target.value as LessonDraft['status'] | '')}>
                        <option value="">Any status</option>
                        <option value="Open">Open</option>
                        <option value="PMOEvaluation">PMO Evaluation</option>
                        <option value="Approved">Approved</option>
                        <option value="Closed">Closed</option>
                        <option value="Archived">Archived</option>
                      </select>
                    </div>}
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
                  </div>}
                  {projectsQuery.isError && !projectsQuery.isFetching && (
                    <div className="draft-error" role="alert">
                      <p>The project filter options could not be loaded.</p>
                      <button className="draft-cancel" type="button" onClick={() => void projectsQuery.refetch()}>Retry projects</button>
                    </div>
                  )}
                  {currentProjectOptionsQuery.isError && !currentProjectOptionsQuery.isFetching && !isLegacyLibrary && (
                    <div className="draft-error" role="alert">
                      <p>{isLibraryPage ? 'Published project filter options could not be loaded.' : 'Past project filter options could not be loaded.'}</p>
                      <button className="draft-cancel" type="button" onClick={() => void currentProjectOptionsQuery.refetch()}>
                        Retry project filters
                      </button>
                    </div>
                  )}

                  {currentSubmissionsQuery.isPending && <p role="status">{isLibraryPage
                    ? 'Loading published lessons…'
                    : isPmoEvaluationQueuePage
                      ? 'Loading the evaluation queue…'
                      : isPmoDraftsPage ? 'Loading PMO Drafts…' : 'Loading your submissions…'}</p>}
                  {currentSubmissionsQuery.isError && !pagedQuery?.isFetchNextPageError && (
                    <div className="draft-error" role="alert">
                      <p>{isLibraryPage
                        ? 'The Lessons Library could not be loaded.'
                        : isPmoEvaluationQueuePage
                          ? 'The evaluation queue could not be loaded.'
                          : isPmoDraftsPage ? 'PMO Drafts could not be loaded.' : 'Your submissions could not be loaded.'}</p>
                      <button className="draft-cancel" type="button" onClick={() => void currentSubmissionsQuery.refetch()}>Retry</button>
                    </div>
                  )}
                  {currentSubmissionsQuery.isSuccess && submissionItems.length === 0 && (
                    <p className="draft-empty">{isLibraryPage
                      ? !isLegacyLibrary && currentSubmissionFilters && Object.keys(currentSubmissionFilters).length > 0
                        ? 'No published lessons match these filters.'
                        : 'No lessons have been published yet.'
                      : isPmoEvaluationQueuePage
                        ? Object.keys(currentSubmissionFilters).length
                          ? 'No lessons match these filters.'
                          : 'No lessons are awaiting PMO evaluation.'
                        : isPmoDraftsPage
                          ? Object.keys(currentSubmissionFilters).length ? 'No lessons match these filters.' : 'No lessons are available.'
                          : Object.keys(currentSubmissionFilters).length ? 'No submissions match these filters.' : 'You have no submissions yet.'}</p>
                  )}
                  {isLibraryPage && voteError && !isLibraryDetailOpen && (
                    <div className="draft-error" role="alert">
                      <p>{voteError.message}</p>
                    </div>
                  )}
                  {isSubmissionTablePage && submissionItems.length > 0 && (
                    <div className="submission-table-wrapper">
                      <table className="submission-table">
                        <caption className="visually-hidden">{isLibraryPage
                          ? getLibrarySortCaption(librarySort)
                          : isPmoEvaluationQueuePage
                            ? 'Lessons awaiting PMO evaluation, oldest submission first'
                            : 'Lessons available to PMO'}</caption>
                        <thead>
                          <tr>
                            <th scope="col">Title</th>
                            <th scope="col">ID</th>
                            <th scope="col">Author</th>
                            <th scope="col">Project</th>
                            <th scope="col">Type</th>
                            <th scope="col">Status</th>
                            {isLibraryPage && <th scope="col">Approved</th>}
                            {isLibraryPage && !isLegacyLibrary && <th scope="col">Views</th>}
                            {isLibraryPage && !isLegacyLibrary && <th scope="col">Votes</th>}
                            {isPmoDraftsPage && <th scope="col">Updated</th>}
                            {isPmoReviewListPage && <th scope="col">Actions</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {submissionItems.map((draft) => (
                            <tr key={draft.id}>
                              <th scope="row">
                                {isLibraryPage ? (
                                  <a
                                    className="submission-title-link"
                                    href={getLibraryLessonHref(draft.id)}
                                    onClick={(event) => {
                                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                                      event.preventDefault();
                                      openLibraryLessonFromList(draft.id);
                                    }}
                                    aria-label={`View ${draft.title}`}
                                    data-lesson-view-id={draft.id}
                                  >
                                    {draft.title}
                                  </a>
                                ) : (
                                  <button
                                    className="submission-title-link"
                                    type="button"
                                    onClick={() => setSelectedSubmissionId(draft.id)}
                                    aria-label={`View ${draft.title}`}
                                    data-lesson-view-id={draft.id}
                                  >
                                    {draft.title}
                                  </button>
                                )}
                                {isLibraryPage && (
                                  <p className="library-description">{draft.situationObserved || 'No description available.'}</p>
                                )}
                              </th>
                              <td>#{draft.id}</td>
                              <td>{isLibraryPage ? draft.authorName ?? draft.authorId : draft.authorId}</td>
                              <td>{draft.projectName ?? 'No project'}</td>
                              <td>{draft.lessonType ?? 'Not specified'}</td>
                              <td>{draft.status}</td>
                              {isLibraryPage && <td>{draft.approvedAt
                                ? <time dateTime={draft.approvedAt}>{formatUpdatedAt(draft.approvedAt)}</time>
                                : 'Not available'}</td>}
                              {isLibraryPage && !isLegacyLibrary && <td>{isLibraryLesson(draft) ? draft.viewCount : 0}</td>}
                              {isLibraryPage && !isLegacyLibrary && (
                                <td>
                                  {isLibraryLesson(draft) ? (
                                    <button
                                      type="button"
                                      className={draft.hasVoted ? 'vote-button is-voted' : 'vote-button'}
                                      aria-pressed={draft.hasVoted}
                                      aria-label={draft.hasVoted
                                        ? `Remove vote for ${draft.title} (${draft.votesCount})`
                                        : `Vote for ${draft.title} (${draft.votesCount})`}
                                      disabled={pendingVoteIds.has(draft.id)}
                                      onClick={() => void toggleLessonVote(draft)}
                                    >
                                      <span aria-hidden="true">{draft.hasVoted ? '★' : '☆'}</span>
                                      <span>{draft.hasVoted ? 'Voted' : 'Vote'}</span>
                                      <span className="vote-count">{draft.votesCount}</span>
                                    </button>
                                  ) : 0}
                                </td>
                              )}
                              {isPmoDraftsPage && <td><time dateTime={draft.updatedAt}>{formatUpdatedAt(draft.updatedAt)}</time></td>}
                              {isPmoReviewListPage && <td>
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
                                  {isPmoEvaluationQueuePage && draft.status === 'PMOEvaluation' && (
                                    <button
                                      className="draft-cancel"
                                      type="button"
                                      onClick={() => setSelectedRejectionDraft(draft)}
                                      aria-label={`Reject ${draft.title}`}
                                    >
                                      Reject
                                    </button>
                                  )}
                                </div>
                              </td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {pagedQuery?.hasNextPage && (
                    <div>
                      {pagedQuery.isFetchNextPageError && <p role="alert">The next page could not be loaded.</p>}
                      <button className="draft-cancel" type="button" disabled={pagedQuery.isFetching}
                        onClick={() => void pagedQuery.fetchNextPage()}>
                        {pagedQuery.isFetchingNextPage ? 'Loading more…' : 'Load more'}
                      </button>
                    </div>
                  )}
                  {!isSubmissionTablePage && currentSubmissionsQuery.isSuccess && submissionItems.length > 0 && (
                    <ul className="draft-list">
                      {submissionItems.map((draft) => (
                        <li key={draft.id}>
                          <div>
                            <p className="draft-title">{draft.title}</p>
                            <p className="draft-meta">{draft.status === 'Open' ? 'Draft' : 'Lesson'} #{draft.id} · {draft.status}</p>
                            {draft.status === 'Open' && draft.latestReviewGuidance && (
                              <p className="return-guidance-notice">
                                <strong>Latest PMO guidance</strong>
                                <span>{draft.latestReviewGuidance}</span>
                              </p>
                            )}
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
                                data-lesson-view-id={draft.id}
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
                              data-lesson-view-id={draft.id}
                            >
                              View
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                    </>
                  )}
                  {isEditorOpen && (
                    <DraftEditor
                      key={selectedDraft?.id ?? 'new'}
                      draft={selectedDraft}
                      canEditEvaluation={isPmoEvaluationQueuePage && selectedDraft?.status === 'PMOEvaluation'}
                      canSubmit={selectedDraft === null || (
                        selectedDraft.status !== 'PMOEvaluation' && selectedDraft.authorId === selectedProfileId
                      )}
                      projects={projectsQuery.data ?? []}
                      projectsLoading={projectsQuery.isFetching}
                      projectsError={projectsQuery.isError && !projectsQuery.isFetching}
                      onRetryProjects={() => void projectsQuery.refetch()}
                      homeRecheckError={showHomeRecheckError}
                      onRetryHomeCheck={() => void homeQuery.refetch()}
                      onSave={saveDraftFields}
                      onSubmit={submitDraft}
                      onReload={reloadDraftFields}
                      onViewCurrent={(lessonId) => {
                        queryClient.removeQueries({
                          queryKey: ['lessons-learned-submission-details', selectedProfileId, lessonId],
                          exact: true,
                        });
                        setSelectedSubmissionId(lessonId);
                      }}
                      getReturnFocusTarget={(lessonId) => lessonId === null
                        ? null
                        : document.querySelector<HTMLElement>(`[data-lesson-view-id="${lessonId}"]`)}
                      onRegisterNavigationCloseRequest={registerNavigationCloseRequest}
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
                      onRegisterNavigationCloseRequest={registerNavigationCloseRequest}
                    />
                  )}
                  {selectedRejectionDraft && (
                    <RejectLessonDialog
                      draft={selectedRejectionDraft}
                      onReload={reloadRejectionEvaluation}
                      onConfirm={rejectEvaluation}
                      onClose={() => setSelectedRejectionDraft(null)}
                      onRegisterNavigationCloseRequest={registerNavigationCloseRequest}
                    />
                  )}
                  {(selectedSubmissionId !== null || isLibraryDetailOpen) && (
                    <LessonSubmissionDetailsDialog
                      lessonId={isLibraryPage && libraryDetailId !== null ? libraryDetailId : selectedSubmissionId ?? 0}
                      details={isLibraryDetailOpen ? confirmedLibraryDetails : submissionDetailsQuery.data}
                      isLoading={isLibraryDetailOpen ? isLibraryDetailLoading : submissionDetailsQuery.isLoading}
                      hasError={isLibraryDetailOpen ? !isLibraryDetailLoading && libraryDetailsQuery.isError : submissionDetailsQuery.isError}
                      canEdit={isPmoEvaluationQueuePage && submissionDetailsQuery.data?.status === 'PMOEvaluation'}
                      onEdit={() => {
                        const details = submissionDetailsQuery.data;
                        if (!isPmoEvaluationQueuePage || details?.status !== 'PMOEvaluation') return;
                        setSelectedDraft(details);
                        setSelectedSubmissionId(null);
                      }}
                      onRetry={() => void (isLibraryPage && libraryDetailId !== null
                        ? libraryDetailsQuery.refetch()
                        : submissionDetailsQuery.refetch())}
                      canApprove={Boolean(isPmo)}
                      onApprove={(lesson) => setSelectedApprovalDraft(lesson)}
                      canClose={Boolean(isPmo)}
                      onCloseLesson={(lesson) => setSelectedClosureDraft(lesson)}
                      onClose={() => {
                        if (isLibraryPage && libraryDetailId !== null) closeLibraryLesson();
                        else setSelectedSubmissionId(null);
                      }}
                      onReturn={isPmoEvaluationQueuePage ? setSelectedReturnLesson : undefined}
                      isLibrarySurface={isLibraryPage && libraryDetailId !== null}
                      onToggleVote={(lesson) => void toggleLessonVote(lesson)}
                      isVotePending={pendingVoteIds.has(isLibraryPage && libraryDetailId !== null ? libraryDetailId : selectedSubmissionId ?? 0)}
                      voteError={voteError?.lessonId === (isLibraryPage && libraryDetailId !== null ? libraryDetailId : selectedSubmissionId ?? 0)
                        ? voteError.message
                        : null}
                    />
                  )}
                  {selectedReturnLesson && (
                    <ReturnLessonDialog
                      lesson={selectedReturnLesson}
                      onReload={reloadLessonDetails}
                      onConfirm={returnLesson}
                      onClose={() => setSelectedReturnLesson(null)}
                      onComplete={() => {
                        setSelectedReturnLesson(null);
                        setSelectedSubmissionId(null);
                      }}
                      onRegisterNavigationCloseRequest={registerNavigationCloseRequest}
                    />
                  )}
                  {selectedApprovalDraft && (
                    <ApprovalDialog
                      lesson={selectedApprovalDraft}
                      onConfirm={approveDraft}
                      onReload={reloadApprovalLesson}
                      onClose={() => setSelectedApprovalDraft(null)}
                    />
                  )}
                  {selectedClosureDraft && (
                    <ClosureDialog
                      lesson={selectedClosureDraft}
                      onConfirm={closeDraft}
                      onReload={reloadClosureLesson}
                      onClose={() => setSelectedClosureDraft(null)}
                    />
                  )}
                </section>
              )}
          </>
        )}
      </section>
        </main>
      </div>
    </div>
  );
}
