import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  castLessonVote,
  getContributorProfile,
  getHome,
  getLessonDetails,
  getLibrary,
  getLibraryLessonDetails,
  getLibraryProjectSnapshots,
  getProfiles,
  recordLibraryView,
  removeLessonVote,
  type ContributorProfileResponse,
  type LessonDetails,
  type LibraryLesson,
  type ProfileSummary,
} from '../src/api';

import { emptyHomeSections } from './homeFixtures';

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

const contributor = {
  profile: { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' as const },
  navigation: [{ id: 'home' as const, label: 'Home' as const, current: true as const }],
  ...emptyHomeSections,
};

const profilesList: ProfileSummary[] = [
  {
    id: 'user-ana',
    displayName: 'Ana Costa',
    initials: 'AC',
    role: 'LESSONS_USER',
    publishedLessonsCount: 2,
    votesReceivedCount: 3,
    viewsReceivedCount: 7,
  },
  {
    id: 'user-zero',
    displayName: 'Bruno Zero',
    initials: 'BZ',
    role: 'LESSONS_USER',
    publishedLessonsCount: 0,
    votesReceivedCount: 0,
    viewsReceivedCount: 0,
  },
];

function publishedLesson(overrides: Partial<LibraryLesson> = {}): LibraryLesson {
  return {
    id: 10,
    title: 'Published Release Guide',
    authorId: 'user-ana',
    authorName: 'Ana Costa',
    updatedBy: 'local-pmo',
    status: 'Approved',
    version: 2,
    viewCount: 5,
    votesCount: 2,
    hasVoted: false,
    commentCount: 0,
    projectId: 'LOCAL-PROJECT-001',
    projectName: 'Fictional Atlas Modernization',
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

function contributorProfileResponse(
  overrides: Partial<ContributorProfileResponse> = {},
): ContributorProfileResponse {
  return {
    profile: profilesList[0]!,
    rankingPosition: null,
    includesPrivateLessons: false,
    items: [publishedLesson()],
    projects: [{ id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' }],
    ...overrides,
  };
}

function lessonDetailsFromLibrary(lesson: LibraryLesson): LessonDetails {
  return {
    ...lesson,
    history: [],
  };
}

function renderScreen(localUserId: string, url = '/lessons-learned/') {
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

beforeEach(() => {
  onlineManager.setOnline(true);
  vi.clearAllMocks();
  vi.mocked(getHome).mockResolvedValue(contributor);
  vi.mocked(getProfiles).mockResolvedValue(profilesList);
  vi.mocked(getContributorProfile).mockResolvedValue(contributorProfileResponse());
  vi.mocked(getLibrary).mockResolvedValue({
    items: [publishedLesson()],
    page: { limit: 20, nextCursor: null },
  });
  vi.mocked(getLibraryProjectSnapshots).mockResolvedValue([
    { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' },
  ]);
  vi.mocked(getLibraryLessonDetails).mockResolvedValue(lessonDetailsFromLibrary(publishedLesson()));
  vi.mocked(getLessonDetails).mockResolvedValue(lessonDetailsFromLibrary(publishedLesson({
    id: 11,
    title: 'Private Open Draft',
    status: 'Open',
    approvedAt: null,
    votesCount: 0,
    hasVoted: false,
    viewCount: 0,
  })));
  vi.mocked(recordLibraryView).mockResolvedValue({ viewCount: 6 });
  vi.mocked(castLessonVote).mockResolvedValue({ lessonId: 10, votesCount: 3, hasVoted: true });
  vi.mocked(removeLessonVote).mockResolvedValue({ lessonId: 10, votesCount: 2, hasVoted: false });
});

afterEach(() => {
  cleanup();
});

describe('Profile Search and Contributor Profile screens', () => {
  it('navigates to Profile Search, lists authorized users including zero published lessons, and searches by name', async () => {
    const user = userEvent.setup();
    renderScreen('local-contributor');

    const profilesNav = await screen.findByRole('link', { name: 'Profiles' });
    await user.click(profilesNav);

    expect(await screen.findByRole('heading', { name: 'Profiles' })).toBeInTheDocument();
    expect(await screen.findByText('Ana Costa')).toBeInTheDocument();
    expect(screen.getByText('Bruno Zero')).toBeInTheDocument();
    expect(screen.getByText('AC')).toBeInTheDocument();
    expect(screen.getByText('BZ')).toBeInTheDocument();

    const searchInput = screen.getByLabelText('Search profiles by name');
    await user.type(searchInput, 'Ana');

    await waitFor(() => {
      expect(vi.mocked(getProfiles)).toHaveBeenCalledWith('local-contributor', { search: 'Ana' });
    });
  });

  it('opens Contributor Profile, filters by project/type, increments views for published lessons (D7), syncs votes, and returns to origin', async () => {
    const user = userEvent.setup();
    renderScreen('local-contributor', '/lessons-learned/?page=profiles');

    const viewAnaButton = await screen.findByRole('button', { name: /View profile of Ana Costa/i });
    await user.click(viewAnaButton);

    expect(await screen.findByRole('heading', { name: 'Ana Costa' })).toBeInTheDocument();
    expect(screen.getByText('Published Release Guide')).toBeInTheDocument();

    // Filter by No project and Lesson type
    await user.selectOptions(screen.getByLabelText('Project'), 'without-project');
    await waitFor(() => {
      expect(vi.mocked(getContributorProfile)).toHaveBeenCalledWith(
        'local-contributor',
        'user-ana',
        expect.objectContaining({ withoutProject: true }),
      );
    });

    await user.selectOptions(screen.getByLabelText('Lesson type'), 'Future Prevention');
    await waitFor(() => {
      expect(vi.mocked(getContributorProfile)).toHaveBeenCalledWith(
        'local-contributor',
        'user-ana',
        expect.objectContaining({ withoutProject: true, lessonType: 'Future Prevention' }),
      );
    });

    // Open published lesson detail from Contributor Profile -> records view (D7)
    await user.click(screen.getByRole('button', { name: 'View Published Release Guide' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Published Release Guide')).toBeInTheDocument();

    await waitFor(() => {
      expect(vi.mocked(recordLibraryView)).toHaveBeenCalledWith(
        'local-contributor',
        10,
        { openingId: expect.stringMatching(/^[0-9a-f-]{36}$/i) },
      );
    });

    // Vote inside Lesson Detail -> syncs with Contributor Profile
    const dialogVoteButton = within(dialog).getByRole('button', { name: /Vote for Published Release Guide/i });
    await user.click(dialogVoteButton);
    await waitFor(() => {
      expect(vi.mocked(castLessonVote)).toHaveBeenCalledWith('local-contributor', 10);
    });

    // Close dialog and verify vote button on Contributor Profile is synced
    await user.click(within(dialog).getByRole('button', { name: 'Close details' }));
    expect(screen.getByRole('button', { name: /Remove vote for Published Release Guide \(3\)/i })).toBeInTheDocument();

    // Return to Profiles
    await user.click(screen.getByRole('button', { name: /Back to Profiles/i }));
    expect(await screen.findByRole('heading', { name: 'Profiles' })).toBeInTheDocument();
  });

  it('does not record a view or show vote action for private lessons on own Contributor Profile', async () => {
    const user = userEvent.setup();
    vi.mocked(getContributorProfile).mockResolvedValue(contributorProfileResponse({
      includesPrivateLessons: true,
      items: [
        publishedLesson({
          id: 11,
          title: 'Private Open Draft',
          authorId: 'local-contributor',
          authorName: 'Local Contributor',
          status: 'Open',
          approvedAt: null,
          votesCount: 0,
          hasVoted: false,
          viewCount: 0,
        }),
      ],
    }));

    renderScreen('local-contributor', '/lessons-learned/?page=profiles&profile=local-contributor');

    expect(await screen.findByText('Private Open Draft')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Vote for Private Open Draft/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'View Private Open Draft' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Private Open Draft')).toBeInTheDocument();
    expect(vi.mocked(getLessonDetails)).toHaveBeenCalledWith('local-contributor', 11);
    expect(vi.mocked(recordLibraryView)).not.toHaveBeenCalled();
  });

  it('opens Contributor Profile from author link in Lessons Library and Lesson Detail and returns to Library', async () => {
    const user = userEvent.setup();
    renderScreen('local-contributor', '/lessons-learned/?page=library');

    const authorLink = await screen.findByRole('button', { name: /View profile of Ana Costa/i });
    await user.click(authorLink);

    expect(await screen.findByRole('heading', { name: 'Ana Costa' })).toBeInTheDocument();
    const backButton = screen.getByRole('button', { name: /Back to Lessons Library/i });
    await user.click(backButton);

    expect(await screen.findByRole('heading', { name: 'Lessons Library' })).toBeInTheDocument();

    // Open Lesson Detail and click author link inside dialog
    await user.click(screen.getByRole('link', { name: 'View Published Release Guide' }));
    const dialog = await screen.findByRole('dialog');
    const detailAuthorLink = await within(dialog).findByRole('button', { name: /View profile of Ana Costa/i });
    await user.click(detailAuthorLink);

    expect(await screen.findByRole('heading', { name: 'Ana Costa' })).toBeInTheDocument();
  });
});
