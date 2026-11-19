import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  castLessonVote,
  getHome,
  getLessonDetails,
  getLessonProjects,
  getLibrary,
  getLibraryLessonDetails,
  getLibraryProjectSnapshots,
  getRankings,
  getMySubmissions,
  recordLibraryView,
  removeLessonVote,
  type LessonDetails,
  type LessonDraft,
  type LessonVoteResponse,
  type LibraryLesson,
} from '../src/api';

vi.mock('../src/api', () => ({
  approveLesson: vi.fn(),
  cancelLesson: vi.fn(),
  castLessonVote: vi.fn(),
  closeLesson: vi.fn(),
  createLessonComment: vi.fn(),
  createLessonCommentReply: vi.fn(),
  createLessonDraft: vi.fn(),
  getEvaluationProjectSnapshots: vi.fn(),
  getHome: vi.fn(),
  getLessonComments: vi.fn().mockResolvedValue({ items: [], page: { limit: 20, nextCursor: null }, publicCommentCount: 0 }),
  getLessonDetails: vi.fn(),
  getLessonProjects: vi.fn(),
  getLibrary: vi.fn(),
  getLibraryLessonDetails: vi.fn(),
  getLibraryProjectSnapshots: vi.fn(),
  getMyOpenDrafts: vi.fn(),
  getMySubmissions: vi.fn(),
  getPmoDashboard: vi.fn(),
  getProfiles: vi.fn(),
  getContributorProfile: vi.fn(),
  getRankings: vi.fn().mockResolvedValue({ mostVotedLessons: [], topContributors: [] }),
  getPmoDrafts: vi.fn(),
  getPmoEvaluationQueue: vi.fn(),
  hideLessonComment: vi.fn(),
  recordLibraryView: vi.fn(),
  rejectLesson: vi.fn(),
  removeLessonVote: vi.fn(),
  returnLesson: vi.fn(),
  submitLesson: vi.fn(),
  updateLessonDraft: vi.fn(),
}));

const contributor = {
  profile: { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' as const },
  navigation: [{ id: 'home' as const, label: 'Home' as const, current: true as const }],
};

function baseLesson(overrides: Partial<LessonDraft> = {}): LessonDraft {
  return {
    id: 42,
    title: 'Improve release handover',
    authorId: 'local-contributor',
    updatedBy: 'local-pmo',
    status: 'Approved',
    version: 3,
    projectId: null,
    projectName: null,
    projectCategory: 'Technology',
    projectPhase: 'Execution',
    situationObserved: 'The handover omitted the runbook.',
    rootCause: 'No checklist owner had been assigned.',
    lessonType: 'Future Prevention',
    impact: 'The release team repeated verification work.',
    recommendation: 'Assign an owner to review the checklist.',
    applicability: 'Use for releases with shared ownership.',
    latestReviewGuidance: null,
    createdAt: '2026-11-13T12:00:00.000Z',
    updatedAt: '2026-11-15T12:00:00.000Z',
    approvedAt: '2026-11-14T12:00:00.000Z',
    ...overrides,
  };
}

function libraryLesson(overrides: Partial<LibraryLesson> = {}): LibraryLesson {
  return {
    ...baseLesson(overrides),
    authorName: overrides.authorName ?? 'Local Contributor',
    viewCount: overrides.viewCount ?? 2,
    votesCount: overrides.votesCount ?? 0,
    hasVoted: overrides.hasVoted ?? false,
    commentCount: overrides.commentCount ?? 0,
    ...overrides,
  };
}

function detailsFor(overrides: Partial<LessonDetails> = {}): LessonDetails {
  const lesson = baseLesson(overrides);
  return {
    ...lesson,
    authorName: 'Local Contributor',
    history: [],
    votesCount: overrides.votesCount ?? 0,
    hasVoted: overrides.hasVoted ?? false,
    commentCount: overrides.commentCount ?? 0,
    ...overrides,
  };
}

function renderScreen(path: string, profileId = 'local-contributor') {
  window.localStorage.clear();
  window.localStorage.setItem('pmo-hub.local-user-id', profileId);
  window.history.replaceState(null, '', path);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <LessonsLearnedScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getHome).mockResolvedValue(contributor);
  vi.mocked(getLibrary).mockResolvedValue({ items: [], page: { limit: 50, nextCursor: null } });
  vi.mocked(getLibraryProjectSnapshots).mockResolvedValue([]);
  vi.mocked(getRankings).mockResolvedValue({ mostVotedLessons: [], topContributors: [] });
  vi.mocked(getLessonProjects).mockResolvedValue([]);
  vi.mocked(getMySubmissions).mockResolvedValue([]);
  vi.mocked(recordLibraryView).mockResolvedValue({ viewCount: 3 });
});

afterEach(() => {
  cleanup();
});

describe('Lessons Learned voting', () => {
  it('votes and removes a vote from Lessons Library and keeps state synchronized with Lesson Detail while preventing rapid duplicate requests', async () => {
    const user = userEvent.setup();
    const lesson = libraryLesson({ id: 42, title: 'Improve release handover', votesCount: 1, hasVoted: false });
    vi.mocked(getLibrary).mockResolvedValue({ items: [lesson], page: { limit: 50, nextCursor: null } });
    vi.mocked(getLibraryLessonDetails).mockResolvedValue(detailsFor({ id: 42, votesCount: 2, hasVoted: true }));

    let resolveVote!: (value: LessonVoteResponse) => void;
    vi.mocked(castLessonVote).mockReturnValue(new Promise((resolve) => {
      resolveVote = resolve;
    }));
    vi.mocked(removeLessonVote).mockResolvedValue({ lessonId: 42, votesCount: 1, hasVoted: false });

    renderScreen('/lessons-learned/?page=library');

    const voteButton = await screen.findByRole('button', { name: /vote for improve release handover/i });
    expect(voteButton).toHaveAttribute('aria-pressed', 'false');
    expect(voteButton).toHaveTextContent('1');

    // Rapid double click triggers only one PUT request while in flight
    await user.click(voteButton);
    expect(voteButton).toBeDisabled();
    await user.click(voteButton);
    expect(castLessonVote).toHaveBeenCalledTimes(1);
    expect(castLessonVote).toHaveBeenCalledWith('local-contributor', 42);

    resolveVote({ lessonId: 42, votesCount: 2, hasVoted: true });
    await waitFor(() => expect(voteButton).not.toBeDisabled());
    expect(voteButton).toHaveAttribute('aria-pressed', 'true');
    expect(voteButton).toHaveTextContent('2');

    // Open Lesson Detail and remove vote from inside the modal
    await user.click(screen.getByRole('link', { name: 'View Improve release handover' }));
    const dialog = await screen.findByRole('dialog');
    const detailVoteButton = await within(dialog).findByRole('button', { name: /remove vote for improve release handover/i });
    expect(detailVoteButton).toHaveAttribute('aria-pressed', 'true');
    expect(detailVoteButton).toHaveTextContent('2');

    await user.click(detailVoteButton);
    await waitFor(() => expect(removeLessonVote).toHaveBeenCalledWith('local-contributor', 42));
    await waitFor(() => expect(detailVoteButton).toHaveAttribute('aria-pressed', 'false'));
    expect(detailVoteButton).toHaveTextContent('1');

    // Close modal and confirm Library row is synchronized with Detail
    await user.click(within(dialog).getByRole('button', { name: 'Back to Lessons Library' }));
    const syncedRowButton = screen.getByRole('button', { name: /vote for improve release handover/i });
    expect(syncedRowButton).toHaveAttribute('aria-pressed', 'false');
    expect(syncedRowButton).toHaveTextContent('1');
  });

  it('restores previous vote state and shows an alert when voting fails without false confirmation', async () => {
    const user = userEvent.setup();
    const lesson = libraryLesson({ id: 51, title: 'Failure rollback lesson', votesCount: 4, hasVoted: false });
    vi.mocked(getLibrary).mockResolvedValue({ items: [lesson], page: { limit: 50, nextCursor: null } });
    vi.mocked(castLessonVote).mockRejectedValue(new Error('Network error'));

    renderScreen('/lessons-learned/?page=library');

    const voteButton = await screen.findByRole('button', { name: /vote for failure rollback lesson/i });
    expect(voteButton).toHaveAttribute('aria-pressed', 'false');
    expect(voteButton).toHaveTextContent('4');

    await user.click(voteButton);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/vote could not be updated/i));
    expect(voteButton).toHaveAttribute('aria-pressed', 'false');
    expect(voteButton).toHaveTextContent('4');
  });

  it('does not expose voting controls for Open, PMOEvaluation, or Archived lessons in Lesson Detail', async () => {
    const user = userEvent.setup();
    const openDraft = baseLesson({ id: 60, title: 'Draft still open', status: 'Open', approvedAt: null });
    vi.mocked(getMySubmissions).mockResolvedValue([openDraft]);
    vi.mocked(getLessonDetails).mockResolvedValue(detailsFor({
      id: 60,
      title: 'Draft still open',
      status: 'Open',
      approvedAt: null,
      votesCount: 0,
      hasVoted: false,
    }));

    renderScreen('/lessons-learned/?page=my-submissions');

    await user.click(await screen.findByRole('button', { name: 'View Draft still open' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Draft still open');
    expect(within(dialog).queryByRole('button', { name: /vote/i })).not.toBeInTheDocument();
  });

  it('sorts Lessons Library by Most voted while preserving active filters and Load more pagination', async () => {
    const user = userEvent.setup();
    const firstPageItem = libraryLesson({ id: 70, title: 'Alpha most voted', votesCount: 5, hasVoted: true });
    const secondPageItem = libraryLesson({ id: 71, title: 'Alpha second voted', votesCount: 2, hasVoted: false });
    vi.mocked(getLibrary).mockImplementation(async (_profileId, params) => {
      if (params?.sort === 'most-voted') {
        if (params.cursor === 'cursor-2') {
          return { items: [secondPageItem], page: { limit: 50, nextCursor: null } };
        }
        return { items: [firstPageItem], page: { limit: 50, nextCursor: 'cursor-2' } };
      }
      return { items: [secondPageItem], page: { limit: 50, nextCursor: null } };
    });

    renderScreen('/lessons-learned/?page=library');
    await screen.findByText('Alpha second voted');

    await user.type(screen.getByLabelText('Search title or ID'), 'Alpha');
    await user.selectOptions(screen.getByLabelText('Sort by'), 'most-voted');

    await screen.findByText('Alpha most voted');
    expect(getLibrary).toHaveBeenCalledWith('local-contributor', expect.objectContaining({
      search: 'Alpha',
      sort: 'most-voted',
      paged: 'true',
      cursor: undefined,
    }));

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Alpha second voted');
    expect(getLibrary).toHaveBeenCalledWith('local-contributor', expect.objectContaining({
      search: 'Alpha',
      sort: 'most-voted',
      paged: 'true',
      cursor: 'cursor-2',
    }));
  });
});
