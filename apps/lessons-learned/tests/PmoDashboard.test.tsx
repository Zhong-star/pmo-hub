import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  getHome,
  getLessonDetails,
  getLessonProjects,
  getPmoDashboard,
  getPmoEvaluationQueue,
  getEvaluationProjectSnapshots,
  recordLibraryView,
  type LessonDetails,
  type PmoDashboardLesson,
  type PmoDashboardResponse,
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
  getPmoDrafts: vi.fn(),
  getPmoDashboard: vi.fn(),
  getProfiles: vi.fn(),
  getContributorProfile: vi.fn(),
  getPmoEvaluationQueue: vi.fn(),
  getEvaluationProjectSnapshots: vi.fn(),
  hideLessonComment: vi.fn(),
  returnLesson: vi.fn(),
  rejectLesson: vi.fn(),
  submitLesson: vi.fn(),
  updateLessonDraft: vi.fn(),
}));

const contributor = {
  profile: { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' as const },
  navigation: [{ id: 'home' as const, label: 'Home' as const, current: true as const }],
};

const pmo = {
  profile: { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' as const },
  navigation: [{ id: 'home' as const, label: 'Home' as const, current: true as const }],
};

function dashboardLesson(overrides: Partial<PmoDashboardLesson> = {}): PmoDashboardLesson {
  return {
    id: 42,
    title: 'Improve release handover',
    authorId: 'local-contributor',
    authorName: 'Local Contributor',
    updatedBy: 'local-pmo',
    status: 'Approved',
    version: 3,
    viewCount: 5,
    votesCount: 0,
    hasVoted: false,
    projectId: 'LOCAL-PROJECT-001',
    projectName: 'Fictional Atlas Modernization',
    projectCategory: 'Technology',
    projectPhase: 'Execution',
    situationObserved: 'The handover omitted the runbook.',
    rootCause: 'No checklist owner had been assigned.',
    lessonType: 'Future Prevention',
    impact: 'The release team repeated verification work.',
    recommendation: 'Assign an owner to review the checklist.',
    applicability: 'Use for releases with shared ownership.',
    latestReviewGuidance: null,
    createdAt: '2026-11-10T12:00:00.000Z',
    updatedAt: '2026-11-15T12:00:00.000Z',
    approvedAt: '2026-11-14T12:00:00.000Z',
    commentCount: 0,
    lastActivityAt: '2026-11-15T12:00:00.000Z',
    latestClosedAt: null,
    latestReturnedAt: null,
    ...overrides,
  };
}

function dashboardResponse(overrides: Partial<PmoDashboardResponse> = {}): PmoDashboardResponse {
  return {
    windowDays: 30,
    windowStartAt: '2026-10-20T00:00:00.000Z',
    summary: {
      awaitingEvaluation: 2,
      recentlyApproved: 3,
      recentlyClosed: 1,
      recentlyReturned: 1,
    },
    items: [dashboardLesson()],
    projects: [{ id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' }],
    ...overrides,
  };
}

function renderScreen(localUserId: string, page?: 'home' | 'pmo-dashboard') {
  window.localStorage.clear();
  window.history.replaceState(null, '', page && page !== 'home' ? `/lessons-learned/?page=${page}` : '/lessons-learned/');
  window.localStorage.setItem('pmo-hub.local-user-id', localUserId);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LessonsLearnedScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  onlineManager.setOnline(true);
  vi.clearAllMocks();
  vi.mocked(getLessonProjects).mockResolvedValue([
    { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' },
  ]);
  vi.mocked(getEvaluationProjectSnapshots).mockResolvedValue([]);
  vi.mocked(getPmoEvaluationQueue).mockResolvedValue({ items: [], page: { limit: 50, nextCursor: null } });
});

afterEach(() => {
  cleanup();
});

describe('PMO Dashboard screen', () => {
  it('hides PMO Dashboard from Contributor navigation and shows Access denied on direct URL without calling the API', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);

    renderScreen('local-contributor', 'pmo-dashboard');

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/restricted to PMO/i);
    expect(screen.queryByRole('link', { name: 'PMO Dashboard' })).not.toBeInTheDocument();
    expect(getPmoDashboard).not.toHaveBeenCalled();
  });

  it('shows the 4 summary cards, toggles card quick filters, combines search/filters/sort, and links directly to PMO Review Queue', async () => {
    const user = userEvent.setup();
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoDashboard).mockResolvedValue(dashboardResponse());

    renderScreen('local-pmo', 'home');

    const dashboardLink = await screen.findByRole('link', { name: 'PMO Dashboard' });
    await user.click(dashboardLink);

    expect(await screen.findByRole('heading', { name: 'PMO Dashboard' })).toBeInTheDocument();

    // 4 summary cards with exact counts
    const summaryGroup = screen.getByRole('group', { name: /Operational summary/i });
    const awaitingCard = within(summaryGroup).getByRole('button', { name: /Awaiting Evaluation/i });
    const approvedCard = within(summaryGroup).getByRole('button', { name: /Recently Approved/i });
    const closedCard = within(summaryGroup).getByRole('button', { name: /Recently Closed/i });
    const returnedCard = within(summaryGroup).getByRole('button', { name: /Recently Returned/i });

    expect(awaitingCard).toHaveTextContent('2');
    expect(approvedCard).toHaveTextContent('3');
    expect(closedCard).toHaveTextContent('1');
    expect(returnedCard).toHaveTextContent('1');

    // Click card to apply quick filter
    await user.click(closedCard);
    await waitFor(() => {
      expect(getPmoDashboard).toHaveBeenLastCalledWith('local-pmo', { card: 'recently-closed' });
    });
    expect(closedCard).toHaveAttribute('aria-pressed', 'true');

    // Combine with search, project ("No project"), lesson type, status, and sort
    await user.type(screen.getByLabelText('Search title or ID'), '#42');
    await user.selectOptions(screen.getByLabelText('Project'), 'without-project');
    await user.selectOptions(screen.getByLabelText('Lesson type'), 'Future Prevention');
    await user.selectOptions(screen.getByLabelText('Status'), 'Closed');
    await user.selectOptions(screen.getByLabelText('Sort by'), 'title');

    await waitFor(() => {
      expect(getPmoDashboard).toHaveBeenLastCalledWith('local-pmo', {
        search: '#42',
        withoutProject: true,
        lessonType: 'Future Prevention',
        status: 'Closed',
        card: 'recently-closed',
        sort: 'title',
      });
    });

    // Clear filters resets search, filters, and active card quick filter
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      expect(getPmoDashboard).toHaveBeenLastCalledWith('local-pmo', { sort: 'title' });
    });
    expect(closedCard).toHaveAttribute('aria-pressed', 'false');

    // Shortcut to PMO Review Queue navigates to Evaluation Queue
    const queueShortcut = screen.getByRole('link', { name: /PMO Review Queue/i });
    await user.click(queueShortcut);
    expect(await screen.findByRole('heading', { name: 'Evaluation Queue' })).toBeInTheDocument();
  });

  it('opens Lesson Detail from PMO Dashboard without incrementing views (D7)', async () => {
    const user = userEvent.setup();
    vi.mocked(getHome).mockResolvedValue(pmo);
    const lesson = dashboardLesson();
    vi.mocked(getPmoDashboard).mockResolvedValue(dashboardResponse({ items: [lesson] }));
    const details: LessonDetails = {
      ...lesson,
      history: [{
        id: 1,
        actorId: 'local-contributor',
        eventType: 'Created',
        previousStatus: null,
        newStatus: 'Open',
        reason: null,
        occurredAt: lesson.createdAt,
      }],
    };
    vi.mocked(getLessonDetails).mockResolvedValue(details);

    renderScreen('local-pmo', 'pmo-dashboard');

    const viewButton = await screen.findByRole('button', { name: `View ${lesson.title}` });
    await user.click(viewButton);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(getLessonDetails).toHaveBeenCalledWith('local-pmo', lesson.id);
    expect(recordLibraryView).not.toHaveBeenCalled();
  });
});
