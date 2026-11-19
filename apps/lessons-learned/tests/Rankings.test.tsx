import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  getContributorProfile,
  getHome,
  getLibrary,
  getLibraryLessonDetails,
  getLibraryProjectSnapshots,
  getRankings,
  recordLibraryView,
  type ContributorProfileResponse,
  type LessonDetails,
  type LibraryLesson,
  type RankingsResponse,
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
  getLessonComments: vi.fn().mockResolvedValue({ items: [], page: { limit: 20, nextCursor: null }, publicCommentCount: 0 }),
  getLibrary: vi.fn(),
  getLibraryLessonDetails: vi.fn(),
  getLibraryProjectSnapshots: vi.fn(),
  recordLibraryView: vi.fn(),
  removeLessonVote: vi.fn(),
  getLessonDetails: vi.fn(),
  getLessonProjects: vi.fn(),
  getMyOpenDrafts: vi.fn(),
  getMySubmissions: vi.fn(),
  getNotifications: vi.fn().mockResolvedValue({ items: [], unreadCount: 0, page: { limit: 20, nextCursor: null } }),
  getPmoDrafts: vi.fn(),
  getPmoDashboard: vi.fn(),
  getProfiles: vi.fn(),
  getContributorProfile: vi.fn(),
  getRankings: vi.fn(),
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

const contributor = {
  profile: { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' as const },
  navigation: [{ id: 'home' as const, label: 'Home' as const, current: true as const }],
};

const fullRankings: RankingsResponse = {
  mostVotedLessons: [
    {
      position: 1,
      id: 101,
      title: 'First Place Release Guide',
      authorId: 'user-ana',
      authorName: 'Ana Costa',
      projectName: 'Atlas Modernization',
      lessonType: 'Future Prevention',
      status: 'Approved',
      approvedAt: '2026-11-12T10:00:00.000Z',
      votesCount: 9,
      viewCount: 24,
    },
    {
      position: 2,
      id: 102,
      title: 'Second Place Incident Review',
      authorId: 'user-bruno',
      authorName: 'Bruno Lima',
      projectName: 'Orion Cloud',
      lessonType: 'Risk Avoided',
      status: 'Closed',
      approvedAt: '2026-11-11T10:00:00.000Z',
      votesCount: 5,
      viewCount: 15,
    },
    {
      position: 3,
      id: 103,
      title: 'Third Place QA Checklist',
      authorId: 'user-carla',
      authorName: 'Carla Dias',
      projectName: null,
      lessonType: 'Success to Repeat',
      status: 'Approved',
      approvedAt: '2026-11-10T10:00:00.000Z',
      votesCount: 3,
      viewCount: 8,
    },
  ],
  topContributors: [
    {
      position: 1,
      id: 'user-ana',
      displayName: 'Ana Costa',
      initials: 'AC',
      role: 'LESSONS_USER',
      publishedLessonsCount: 6,
      votesReceivedCount: 18,
      viewsReceivedCount: 60,
      latestApprovedAt: '2026-11-12T10:00:00.000Z',
    },
    {
      position: 2,
      id: 'user-bruno',
      displayName: 'Bruno Lima',
      initials: 'BL',
      role: 'LESSONS_USER',
      publishedLessonsCount: 4,
      votesReceivedCount: 11,
      viewsReceivedCount: 35,
      latestApprovedAt: '2026-11-11T10:00:00.000Z',
    },
    {
      position: 3,
      id: 'user-carla',
      displayName: 'Carla Dias',
      initials: 'CD',
      role: 'LESSONS_MODERATOR',
      publishedLessonsCount: 2,
      votesReceivedCount: 6,
      viewsReceivedCount: 20,
      latestApprovedAt: '2026-11-10T10:00:00.000Z',
    },
  ],
};

function makeLibraryLesson(overrides: Partial<LibraryLesson> = {}): LibraryLesson {
  return {
    id: 101,
    title: 'First Place Release Guide',
    authorId: 'user-ana',
    authorName: 'Ana Costa',
    updatedBy: 'local-pmo',
    status: 'Approved',
    version: 2,
    viewCount: 24,
    votesCount: 9,
    hasVoted: false,
    commentCount: 0,
    projectId: 'LOCAL-PROJECT-001',
    projectName: 'Atlas Modernization',
    projectCategory: 'Technology',
    projectPhase: 'Execution',
    situationObserved: 'Release handover lacked checklist.',
    rootCause: 'No owner assigned.',
    lessonType: 'Future Prevention',
    impact: 'Rework during deploy.',
    recommendation: 'Assign a checklist owner.',
    applicability: 'All releases.',
    latestReviewGuidance: null,
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
    approvedAt: '2026-11-12T10:00:00.000Z',
    ...overrides,
  };
}

function makeLessonDetails(lesson: LibraryLesson): LessonDetails {
  return {
    ...lesson,
    history: [],
  };
}

function makeProfileResponse(overrides: Partial<ContributorProfileResponse> = {}): ContributorProfileResponse {
  return {
    profile: {
      id: 'user-ana',
      displayName: 'Ana Costa',
      initials: 'AC',
      role: 'LESSONS_USER',
      publishedLessonsCount: 6,
      votesReceivedCount: 18,
      viewsReceivedCount: 60,
    },
    rankingPosition: 1,
    includesPrivateLessons: false,
    items: [makeLibraryLesson()],
    projects: [{ id: 'LOCAL-PROJECT-001', name: 'Atlas Modernization' }],
    ...overrides,
  };
}

function renderLibrary(localUserId = 'local-contributor', url = '/lessons-learned/?page=library') {
  window.localStorage.clear();
  window.history.replaceState(null, '', url);
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

describe('Rankings Podium (FT-024, D5, D7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onlineManager.setOnline(true);
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getLibrary).mockResolvedValue({
      items: [makeLibraryLesson()],
      page: { limit: 25, nextCursor: null },
    });
    vi.mocked(getLibraryProjectSnapshots).mockResolvedValue([]);
    vi.mocked(getRankings).mockResolvedValue(fullRankings);
    vi.mocked(getLibraryLessonDetails).mockResolvedValue(makeLessonDetails(makeLibraryLesson()));
    vi.mocked(recordLibraryView).mockResolvedValue({ viewCount: 25 });
    vi.mocked(getContributorProfile).mockResolvedValue(makeProfileResponse());
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/lessons-learned/');
  });

  it('displays Top 3 podium with 2nd on the left, 1st centered and highlighted, and 3rd on the right, and switches between Most Voted Lessons and Top Contributors', async () => {
    const user = userEvent.setup();
    renderLibrary();

    const rankingsSection = await screen.findByRole('region', { name: 'Rankings' });
    const podium = await within(rankingsSection).findByRole('list', { name: 'Most Voted Lessons podium' });
    const cards = within(podium).getAllByRole('listitem');

    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.getAttribute('data-podium-position'))).toEqual(['2', '1', '3']);
    expect(cards[1]).toHaveClass('podium-card--first');
    expect(within(cards[0]!).getByText('Second Place Incident Review')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('First Place Release Guide')).toBeInTheDocument();
    expect(within(cards[2]!).getByText('Third Place QA Checklist')).toBeInTheDocument();

    // Switch to Top Contributors mode
    const topContributorsBtn = within(rankingsSection).getByRole('button', { name: 'Top Contributors' });
    await user.click(topContributorsBtn);
    expect(topContributorsBtn).toHaveAttribute('aria-pressed', 'true');

    const contributorsPodium = within(rankingsSection).getByRole('list', { name: 'Top Contributors podium' });
    const contributorCards = within(contributorsPodium).getAllByRole('listitem');
    expect(contributorCards).toHaveLength(3);
    expect(contributorCards.map((card) => card.getAttribute('data-podium-position'))).toEqual(['2', '1', '3']);
    expect(within(contributorCards[0]!).getByText('Bruno Lima')).toBeInTheDocument();
    expect(within(contributorCards[1]!).getByText('Ana Costa')).toBeInTheDocument();
    expect(within(contributorCards[2]!).getByText('Carla Dias')).toBeInTheDocument();
  });

  it('hides empty podium positions when fewer than 3 items qualify and renders an empty state when 0 items qualify', async () => {
    const user = userEvent.setup();
    vi.mocked(getRankings).mockResolvedValue({
      mostVotedLessons: [fullRankings.mostVotedLessons[0]!, fullRankings.mostVotedLessons[1]!],
      topContributors: [],
    });

    renderLibrary();

    const rankingsSection = await screen.findByRole('region', { name: 'Rankings' });
    const podium = await within(rankingsSection).findByRole('list', { name: 'Most Voted Lessons podium' });
    const cards = within(podium).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.getAttribute('data-podium-position'))).toEqual(['2', '1']);

    await user.click(within(rankingsSection).getByRole('button', { name: 'Top Contributors' }));
    expect(within(rankingsSection).getByText('No contributors have published lessons yet.')).toBeInTheDocument();
  });

  it('opens Lesson Detail and increments views (D7) when selecting a lesson from Most Voted Lessons', async () => {
    const user = userEvent.setup();
    renderLibrary();

    const rankingsSection = await screen.findByRole('region', { name: 'Rankings' });
    const firstPlaceBtn = await within(rankingsSection).findByRole('button', { name: /First Place Release Guide/i });
    await user.click(firstPlaceBtn);

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('First Place Release Guide')).toBeInTheDocument();

    await waitFor(() => {
      expect(recordLibraryView).toHaveBeenCalledWith(
        'local-contributor',
        101,
        expect.objectContaining({ openingId: expect.any(String) }),
      );
    });
  });

  it('opens Contributor Profile with ranking position and returns to Lessons Library when selecting a contributor from Top Contributors', async () => {
    const user = userEvent.setup();
    renderLibrary();

    const rankingsSection = await screen.findByRole('region', { name: 'Rankings' });
    await user.click(within(rankingsSection).getByRole('button', { name: 'Top Contributors' }));
    await user.click(within(rankingsSection).getByRole('button', { name: /Ana Costa/i }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Ana Costa' })).toBeInTheDocument();
    expect(screen.getByText(/Rank #1/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Back to Lessons Library/i }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Lessons Library' })).toBeInTheDocument();
  });

  it('omits ranking position on Contributor Profile when rankingPosition is null', async () => {
    vi.mocked(getContributorProfile).mockResolvedValue(
      makeProfileResponse({ rankingPosition: null }),
    );
    renderLibrary('local-contributor', '/lessons-learned/?page=profiles&profile=user-ana');

    expect(await screen.findByRole('heading', { level: 1, name: 'Ana Costa' })).toBeInTheDocument();
    expect(screen.queryByText(/Rank #/)).not.toBeInTheDocument();
  });

  it('shows an error alert with retry when rankings fail to load', async () => {
    const user = userEvent.setup();
    vi.mocked(getRankings)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(fullRankings);

    renderLibrary();

    const rankingsSection = await screen.findByRole('region', { name: 'Rankings' });
    expect(await within(rankingsSection).findByText('Rankings could not be loaded.')).toBeInTheDocument();

    await user.click(within(rankingsSection).getByRole('button', { name: 'Retry' }));
    expect(await within(rankingsSection).findByText('First Place Release Guide')).toBeInTheDocument();
  });
});
