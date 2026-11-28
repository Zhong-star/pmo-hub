import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  approveLesson,
  getHome,
  getLessonDetails,
  getLessonProjects,
  getLibrary,
  getLibraryProjectSnapshots,
  getMySubmissions,
  getPmoDashboard,
  getPmoDrafts,
  getPmoEvaluationQueue,
  getEvaluationProjectSnapshots,
  recordLibraryView,
  type HomeResponse,
  type LessonDetails,
} from '../src/api';

vi.mock('../src/api', () => ({
  approveLesson: vi.fn(),
  castLessonVote: vi.fn(),
  closeLesson: vi.fn(),
  cancelLesson: vi.fn(),
  createLessonDraft: vi.fn(),
  createLessonComment: vi.fn(),
  createLessonCommentReply: vi.fn(),
  getHome: vi.fn(),
  getLibrary: vi.fn(),
  getLibraryLessonDetails: vi.fn(),
  getLibraryProjectSnapshots: vi.fn(),
  recordLibraryView: vi.fn(),
  removeLessonVote: vi.fn(),
  getLessonComments: vi.fn().mockResolvedValue({ items: [], page: { limit: 20, nextCursor: null }, publicCommentCount: 0 }),
  getLessonDetails: vi.fn(),
  getLessonProjects: vi.fn(),
  getMyOpenDrafts: vi.fn(),
  getMySubmissions: vi.fn(),
  getNotifications: vi.fn().mockResolvedValue({ items: [], page: { limit: 20, nextCursor: null }, unreadCount: 0 }),
  getPmoDrafts: vi.fn(),
  getPmoDashboard: vi.fn(),
  getProfiles: vi.fn(),
  getContributorProfile: vi.fn(),
  getPmoEvaluationQueue: vi.fn(),
  getEvaluationProjectSnapshots: vi.fn(),
  hideLessonComment: vi.fn(),
  markNotificationAsRead: vi.fn(),
  markNotificationsReadBatch: vi.fn(),
  returnLesson: vi.fn(),
  rejectLesson: vi.fn(),
  submitLesson: vi.fn(),
  updateLessonDraft: vi.fn(),
}));

const contributorHome: HomeResponse = {
  profile: { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' },
  navigation: [{ id: 'home', label: 'Home', current: true }],
  notifications: {
    unreadCount: 1,
    items: [
      {
        id: 10,
        eventType: 'LESSON_RETURNED',
        actorUserId: 'local-pmo',
        actorDisplayName: 'Local PMO',
        lessonId: 12,
        lessonTitle: 'Deployment checklist gap',
        summary: 'Local PMO returned your lesson for changes: Add rollback steps.',
        createdAt: '2026-11-18T10:00:00.000Z',
        readAt: null,
        isRead: false,
      },
    ],
  },
  recentWork: [
    {
      id: 12,
      title: 'Deployment checklist gap',
      status: 'Open',
      authorId: 'local-contributor',
      authorName: 'Local Contributor',
      projectName: 'Core Platform',
      lessonType: 'Future Prevention',
      updatedAt: '2026-11-18T10:00:00.000Z',
      approvedAt: null,
      latestReviewGuidance: 'Add rollback steps.',
      isReturned: true,
    },
    {
      id: 15,
      title: 'Published release retrospective',
      status: 'Approved',
      authorId: 'local-contributor',
      authorName: 'Local Contributor',
      projectName: 'Core Platform',
      lessonType: 'Success to Repeat',
      updatedAt: '2026-11-17T09:00:00.000Z',
      approvedAt: '2026-11-17T09:00:00.000Z',
      latestReviewGuidance: null,
      isReturned: false,
    },
  ],
  recentlyApprovedLessons: [
    {
      id: 15,
      title: 'Published release retrospective',
      status: 'Approved',
      authorId: 'local-contributor',
      authorName: 'Local Contributor',
      projectName: 'Core Platform',
      lessonType: 'Success to Repeat',
      updatedAt: '2026-11-17T09:00:00.000Z',
      approvedAt: '2026-11-17T09:00:00.000Z',
      latestReviewGuidance: null,
      isReturned: false,
    },
  ],
  highlights: {
    returnedCount: 1,
    returnedLessons: [
      {
        id: 12,
        title: 'Deployment checklist gap',
        status: 'Open',
        authorId: 'local-contributor',
        authorName: 'Local Contributor',
        projectName: 'Core Platform',
        lessonType: 'Future Prevention',
        updatedAt: '2026-11-18T10:00:00.000Z',
        approvedAt: null,
        latestReviewGuidance: 'Add rollback steps.',
        isReturned: true,
      },
    ],
    openDraftCount: 2,
    openDraftLessons: [
      {
        id: 18,
        title: 'Staging cutover dry run',
        status: 'Open',
        authorId: 'local-contributor',
        authorName: 'Local Contributor',
        projectName: 'Core Platform',
        lessonType: 'Communication',
        updatedAt: '2026-11-18T11:00:00.000Z',
        approvedAt: null,
        latestReviewGuidance: null,
        isReturned: false,
      },
    ],
    pendingEvaluationCount: 0,
    pendingEvaluationLessons: [],
  },
  primaryAction: {
    kind: 'review-returned',
    label: 'Review returned lesson',
    description: '1 lesson was returned by the PMO and needs updates.',
    targetPage: 'my-submissions',
    lessonId: 12,
  },
  shortcuts: [
    { id: 'create-lesson', label: 'Create lesson', description: 'Draft a new lesson learned for PMO review.', targetPage: 'create-lesson' },
    { id: 'my-submissions', label: 'My Submissions', description: 'Continue drafts, review returned lessons, and track status.', targetPage: 'my-submissions' },
    { id: 'library', label: 'Lessons Library', description: 'Search and explore published lessons.', targetPage: 'library' },
    { id: 'profiles', label: 'Profiles', description: 'Find contributors and review published contributions.', targetPage: 'profiles' },
  ],
};

const pmoHome: HomeResponse = {
  profile: { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' },
  navigation: [{ id: 'home', label: 'Home', current: true }],
  notifications: { unreadCount: 0, items: [] },
  recentWork: [
    {
      id: 30,
      title: 'Incident handover automation',
      status: 'Approved',
      authorId: 'local-contributor',
      authorName: 'Local Contributor',
      projectName: 'Cloud Ops',
      lessonType: 'Success to Repeat',
      updatedAt: '2026-11-18T11:00:00.000Z',
      approvedAt: '2026-11-18T11:00:00.000Z',
      latestReviewGuidance: null,
      isReturned: false,
    },
  ],
  recentlyApprovedLessons: [
    {
      id: 30,
      title: 'Incident handover automation',
      status: 'Approved',
      authorId: 'local-contributor',
      authorName: 'Local Contributor',
      projectName: 'Cloud Ops',
      lessonType: 'Success to Repeat',
      updatedAt: '2026-11-18T11:00:00.000Z',
      approvedAt: '2026-11-18T11:00:00.000Z',
      latestReviewGuidance: null,
      isReturned: false,
    },
  ],
  highlights: {
    returnedCount: 0,
    returnedLessons: [],
    openDraftCount: 1,
    openDraftLessons: [
      {
        id: 25,
        title: 'Quarterly governance review draft',
        status: 'Open',
        authorId: 'local-pmo',
        authorName: 'Local PMO',
        projectName: null,
        lessonType: 'Future Prevention',
        updatedAt: '2026-11-18T09:00:00.000Z',
        approvedAt: null,
        latestReviewGuidance: null,
        isReturned: false,
      },
    ],
    pendingEvaluationCount: 2,
    pendingEvaluationLessons: [
      {
        id: 21,
        title: 'API rate limit lessons',
        status: 'PMOEvaluation',
        authorId: 'local-contributor',
        authorName: 'Local Contributor',
        projectName: 'Core Platform',
        lessonType: 'Risk Avoided',
        updatedAt: '2026-11-18T08:00:00.000Z',
        approvedAt: null,
        latestReviewGuidance: null,
        isReturned: false,
      },
    ],
  },
  primaryAction: {
    kind: 'evaluate-pending',
    label: 'Evaluate next lesson',
    description: '2 lessons are awaiting PMO evaluation.',
    targetPage: 'evaluation-queue',
    lessonId: 21,
  },
  shortcuts: [
    { id: 'evaluation-queue', label: 'PMO Review Queue', description: 'Evaluate submitted lessons in FIFO order.', targetPage: 'evaluation-queue' },
    { id: 'pmo-dashboard', label: 'PMO Dashboard', description: 'Monitor 30-day operational metrics and exceptions.', targetPage: 'pmo-dashboard' },
    { id: 'library', label: 'Lessons Library', description: 'Browse, vote on, and close published lessons.', targetPage: 'library' },
    { id: 'create-lesson', label: 'Create lesson', description: 'Register a new lesson learned directly.', targetPage: 'create-lesson' },
  ],
};

function makeDetails(id: number, title: string, status: LessonDetails['status']): LessonDetails {
  return {
    id,
    title,
    authorId: 'local-contributor',
    updatedBy: 'local-contributor',
    status,
    version: 2,
    projectId: 'proj-1',
    projectName: 'Core Platform',
    projectCategory: 'Technology',
    projectPhase: 'Execution',
    situationObserved: 'Observed gap.',
    rootCause: 'Missing checklist.',
    lessonType: 'Future Prevention',
    impact: 'Rework.',
    recommendation: 'Add checklist.',
    applicability: 'All squads.',
    latestReviewGuidance: status === 'Open' ? 'Add rollback steps.' : null,
    createdAt: '2026-11-15T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:00.000Z',
    approvedAt: status === 'Approved' ? '2026-11-17T09:00:00.000Z' : null,
    votesCount: 1,
    hasVoted: false,
    commentCount: 0,
    history: [],
  };
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LessonsLearnedScreen />
    </QueryClientProvider>,
  );
}

describe('Role-aware Home screen integration (#52)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/lessons-learned/');
    vi.mocked(getLessonProjects).mockResolvedValue([]);
    vi.mocked(getLibraryProjectSnapshots).mockResolvedValue([]);
    vi.mocked(getEvaluationProjectSnapshots).mockResolvedValue([]);
    vi.mocked(getLibrary).mockResolvedValue({ items: [], page: { limit: 50, nextCursor: null } });
    vi.mocked(getPmoDrafts).mockResolvedValue([]);
    vi.mocked(getPmoEvaluationQueue).mockResolvedValue({ items: [], page: { limit: 50, nextCursor: null } });
    vi.mocked(getPmoDashboard).mockResolvedValue({
      windowDays: 30,
      windowStartAt: '2026-10-19T00:00:00.000Z',
      summary: { awaitingEvaluation: 0, recentlyApproved: 0, recentlyClosed: 0, recentlyReturned: 0 },
      items: [],
      page: { limit: 50, nextCursor: null },
      projects: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('opens Lessons Library from Home when the API still serves the previous Home contract', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
    vi.mocked(getHome).mockResolvedValue({
      profile: contributorHome.profile,
      navigation: contributorHome.navigation,
    } as HomeResponse);
    const user = userEvent.setup();

    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeVisible();
    expect(screen.getByText('Welcome, Local Contributor')).toBeVisible();
    expect(screen.queryByText(/Active role/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Notifications/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Profiles' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Lessons Library' }));
    expect(await screen.findByRole('heading', { name: 'Lessons Library' })).toBeVisible();
  });

  it('renders Contributor Home without Active role badge, shows pending activities and PMO-approved feed, and opens approved lessons without incrementing views (D7)', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
    vi.mocked(getHome).mockResolvedValue(contributorHome);
    vi.mocked(getLessonDetails).mockResolvedValue(makeDetails(15, 'Published release retrospective', 'Approved'));

    renderScreen();

    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();
    expect(screen.queryByText(/Active role/i)).not.toBeInTheDocument();

    const returnedRegion = screen.getByRole('region', { name: 'Returned for changes' });
    expect(within(returnedRegion).getByText('#12 · Deployment checklist gap')).toBeInTheDocument();
    expect(within(returnedRegion).getByText('Add rollback steps.')).toBeInTheDocument();

    const draftsRegion = screen.getByRole('region', { name: 'Open drafts' });
    expect(within(draftsRegion).getByText('#18 · Staging cutover dry run')).toBeInTheDocument();

    const feedRegion = screen.getByRole('region', { name: 'Latest approved by PMO' });
    expect(within(feedRegion).getByRole('button', { name: /#15 · Published release retrospective/i })).toBeInTheDocument();

    // Theme toggle accessible from Home through the shared header icon button
    const user = userEvent.setup();
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');

    // D7: Opening a published lesson from Latest approved by PMO feed opens Lesson Detail via getLessonDetails and NEVER calls recordLibraryView
    await user.click(within(feedRegion).getByRole('button', { name: /#15 · Published release retrospective/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(getLessonDetails).toHaveBeenCalledWith('local-contributor', 15);
    expect(recordLibraryView).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await user.click(within(feedRegion).getByRole('button', { name: 'View Lessons Library' }));
    expect(await screen.findByRole('heading', { name: 'Lessons Library' })).toBeInTheDocument();
  });

  it('opens the Create lesson editor on My Submissions from the Home Create lesson button', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
    vi.mocked(getHome).mockResolvedValue(contributorHome);
    vi.mocked(getMySubmissions).mockResolvedValue([]);

    renderScreen();

    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create lesson' }));

    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(window.location.search).toBe('?page=my-submissions');
  });

  it('renders PMO Home with pending PMO evaluation, open drafts, approved feed, and View all navigation', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
    vi.mocked(getHome).mockResolvedValue(pmoHome);
    vi.mocked(getLessonDetails).mockResolvedValue(makeDetails(21, 'API rate limit lessons', 'PMOEvaluation'));

    renderScreen();

    expect(await screen.findByText('Welcome, Local PMO')).toBeInTheDocument();
    expect(screen.queryByText(/Active role/i)).not.toBeInTheDocument();

    const pendingRegion = screen.getByRole('region', { name: 'Pending PMO evaluation' });
    expect(within(pendingRegion).getByText('#21 · API rate limit lessons')).toBeInTheDocument();

    const draftsRegion = screen.getByRole('region', { name: 'Open drafts' });
    expect(within(draftsRegion).getByText('#25 · Quarterly governance review draft')).toBeInTheDocument();

    const feedRegion = screen.getByRole('region', { name: 'Latest approved by PMO' });
    expect(within(feedRegion).getByText('#30 · Incident handover automation')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(pendingRegion).getByRole('button', { name: 'View all' }));
    expect(getPmoEvaluationQueue).toHaveBeenCalled();

    await user.click(within(screen.getByRole('navigation', { name: 'Lessons Learned' })).getByRole('link', { name: 'Home' }));
    const draftsAfterReturn = await screen.findByRole('region', { name: 'Open drafts' });
    await user.click(within(draftsAfterReturn).getByRole('button', { name: 'View all' }));
    expect(getPmoDrafts).toHaveBeenCalled();
  });

  it('opens the Create lesson editor from the sidebar Create lesson link', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
    vi.mocked(getHome).mockResolvedValue(contributorHome);
    vi.mocked(getMySubmissions).mockResolvedValue([]);

    renderScreen();

    const navigation = await screen.findByRole('navigation', { name: 'Lessons Learned' });
    const user = userEvent.setup();
    await user.click(within(navigation).getByRole('link', { name: 'Create lesson' }));

    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: 'Create lesson' })).toBeInTheDocument();
    expect(window.location.search).toBe('?page=my-submissions');
  });

  it('refreshes Home after mutating a lesson opened from Pending PMO evaluation', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
    const updatedHome: HomeResponse = {
      ...pmoHome,
      highlights: { ...pmoHome.highlights, pendingEvaluationCount: 0, pendingEvaluationLessons: [] },
      recentlyApprovedLessons: [
        {
          id: 21,
          title: 'API rate limit lessons',
          status: 'Approved',
          authorId: 'local-contributor',
          authorName: 'Local Contributor',
          projectName: 'Core Platform',
          lessonType: 'Risk Avoided',
          updatedAt: '2026-11-18T12:00:00.000Z',
          approvedAt: '2026-11-18T12:00:00.000Z',
          latestReviewGuidance: null,
          isReturned: false,
        },
        ...pmoHome.recentlyApprovedLessons,
      ],
      primaryAction: {
        kind: 'explore-library',
        label: 'Explore Lessons Library',
        description: 'Browse published lessons from across the organization.',
        targetPage: 'library',
        lessonId: null,
      },
    };
    const pendingDetails = makeDetails(21, 'API rate limit lessons', 'PMOEvaluation');
    vi.mocked(getHome).mockResolvedValueOnce(pmoHome).mockResolvedValue(updatedHome);
    vi.mocked(getLessonDetails).mockResolvedValue(pendingDetails);
    vi.mocked(approveLesson).mockResolvedValue({ ...pendingDetails, status: 'Approved', version: 3, approvedAt: '2026-11-18T12:00:00.000Z' });

    renderScreen();

    const pendingRegion = await screen.findByRole('region', { name: 'Pending PMO evaluation' });
    const user = userEvent.setup();
    await user.click(within(pendingRegion).getByRole('button', { name: /#21 · API rate limit lessons/i }));

    const details = await screen.findByRole('dialog', { name: 'Lesson details' });
    await user.click(within(details).getByRole('button', { name: 'Approve and publish' }));
    const confirm = await screen.findByRole('dialog', { name: 'Approve lesson' });
    await user.click(within(confirm).getByRole('button', { name: 'Confirm approval' }));

    await waitFor(() => expect(approveLesson).toHaveBeenCalledWith('local-pmo', 21, { version: 2 }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Pending PMO evaluation' }))
      .getByText('No lessons are awaiting PMO evaluation.')).toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: 'Latest approved by PMO' }))
      .getByText('#21 · API rate limit lessons')).toBeInTheDocument();
  });
});
