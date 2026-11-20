import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  getHome,
  getLessonDetails,
  getLessonProjects,
  getLibrary,
  getLibraryProjectSnapshots,
  getMySubmissions,
  getPmoDashboard,
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
    openDraftCount: 1,
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
  highlights: {
    returnedCount: 0,
    returnedLessons: [],
    openDraftCount: 0,
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
    expect(screen.queryByRole('button', { name: /^Notifications/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Profiles' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Lessons Library' }));
    expect(await screen.findByRole('heading', { name: 'Lessons Library' })).toBeVisible();
  });

  it('renders Contributor Home with primary CTA, returned highlights, unread notifications, recent work, theme toggle, and role shortcuts without incrementing views on open (D7)', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
    vi.mocked(getHome).mockResolvedValue(contributorHome);
    vi.mocked(getLessonDetails).mockResolvedValue(makeDetails(15, 'Published release retrospective', 'Approved'));

    renderScreen();

    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();

    const primaryRegion = screen.getByRole('region', { name: 'Recommended next action' });
    expect(within(primaryRegion).getByRole('button', { name: 'Review returned lesson' })).toBeInTheDocument();
    expect(within(primaryRegion).getByText('1 lesson was returned by the PMO and needs updates.')).toBeInTheDocument();

    const returnedRegion = screen.getByRole('region', { name: 'Returned lessons' });
    expect(within(returnedRegion).getByText('Add rollback steps.')).toBeInTheDocument();

    const notificationsRegion = screen.getByRole('region', { name: 'Unread notifications summary' });
    expect(within(notificationsRegion).getByText('1 unread')).toBeInTheDocument();
    expect(within(notificationsRegion).getByText(/Local PMO returned your lesson for changes/i)).toBeInTheDocument();

    const shortcutsRegion = screen.getByRole('region', { name: 'Quick shortcuts' });
    expect(within(shortcutsRegion).getByRole('button', { name: /Lessons Library/i })).toBeInTheDocument();
    expect(within(shortcutsRegion).getByRole('button', { name: /Profiles/i })).toBeInTheDocument();
    expect(within(shortcutsRegion).queryByRole('button', { name: /PMO Dashboard/i })).not.toBeInTheDocument();
    expect(within(shortcutsRegion).queryByRole('button', { name: /PMO Review Queue/i })).not.toBeInTheDocument();

    // Theme toggle accessible from Home
    const user = userEvent.setup();
    const homeThemeGroup = screen.getByRole('group', { name: 'Home theme preference' });
    await user.click(within(homeThemeGroup).getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');

    // D7: Opening a published lesson from Recent Work opens Lesson Detail via getLessonDetails and NEVER calls recordLibraryView
    const recentRegion = screen.getByRole('region', { name: 'Recent work' });
    await user.click(within(recentRegion).getByRole('button', { name: /#15 · Published release retrospective/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(getLessonDetails).toHaveBeenCalledWith('local-contributor', 15);
    expect(recordLibraryView).not.toHaveBeenCalled();
  });

  it('opens the Create lesson editor on My Submissions from the Home shortcut', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
    vi.mocked(getHome).mockResolvedValue(contributorHome);
    vi.mocked(getMySubmissions).mockResolvedValue([]);

    renderScreen();

    const shortcutsRegion = await screen.findByRole('region', { name: 'Quick shortcuts' });
    const user = userEvent.setup();
    await user.click(within(shortcutsRegion).getByRole('button', { name: /Create lesson/i }));

    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(window.location.search).toBe('?page=my-submissions');
  });

  it('renders PMO Home with pending evaluation highlights, FIFO primary action, and shortcuts to PMO Review Queue and PMO Dashboard', async () => {
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
    vi.mocked(getHome).mockResolvedValue(pmoHome);
    vi.mocked(getLessonDetails).mockResolvedValue(makeDetails(21, 'API rate limit lessons', 'PMOEvaluation'));

    renderScreen();

    expect(await screen.findByText('Welcome, Local PMO')).toBeInTheDocument();

    const primaryRegion = screen.getByRole('region', { name: 'Recommended next action' });
    expect(within(primaryRegion).getByRole('button', { name: 'Evaluate next lesson' })).toBeInTheDocument();

    const pendingRegion = screen.getByRole('region', { name: 'Pending PMO evaluation' });
    expect(within(pendingRegion).getByText(/API rate limit lessons/i)).toBeInTheDocument();

    const shortcutsRegion = screen.getByRole('region', { name: 'Quick shortcuts' });
    expect(within(shortcutsRegion).getByRole('button', { name: /PMO Review Queue/i })).toBeInTheDocument();
    expect(within(shortcutsRegion).getByRole('button', { name: /PMO Dashboard/i })).toBeInTheDocument();
    expect(within(shortcutsRegion).getByRole('button', { name: /Lessons Library/i })).toBeInTheDocument();
    expect(within(shortcutsRegion).getByRole('button', { name: /Create lesson/i })).toBeInTheDocument();

    // Primary CTA opens pending lesson detail without incrementing views (D7)
    const user = userEvent.setup();
    await user.click(within(primaryRegion).getByRole('button', { name: 'Evaluate next lesson' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(getLessonDetails).toHaveBeenCalledWith('local-pmo', 21);
    expect(recordLibraryView).not.toHaveBeenCalled();

    // Close modal and navigate via PMO Dashboard shortcut
    await user.keyboard('{Escape}');
    await user.click(within(shortcutsRegion).getByRole('button', { name: /PMO Dashboard/i }));
    expect(getPmoDashboard).toHaveBeenCalled();
  });
});
