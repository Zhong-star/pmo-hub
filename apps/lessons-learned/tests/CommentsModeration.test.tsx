import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  createLessonComment,
  createLessonCommentReply,
  getEvaluationProjectSnapshots,
  getHome,
  getLessonComments,
  getLessonDetails,
  getLessonProjects,
  getLibrary,
  getLibraryLessonDetails,
  getLibraryProjectSnapshots,
  getMyOpenDrafts,
  getMySubmissions,
  getPmoDrafts,
  getPmoEvaluationQueue,
  hideLessonComment,
  recordLibraryView,
  type LessonCommentPage,
  type LessonDetails,
  type LibraryLesson,
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
  getLessonComments: vi.fn(),
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
};

const pmo = {
  profile: { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' as const },
  navigation: [{ id: 'home' as const, label: 'Home' as const, current: true as const }],
};

function libraryLesson(overrides: Partial<LibraryLesson> = {}): LibraryLesson {
  return {
    id: 42,
    title: 'Improve release handover',
    authorId: 'local-author',
    authorName: 'Lesson Author',
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
    viewCount: 5,
    votesCount: 0,
    hasVoted: false,
    commentCount: 2,
    ...overrides,
  };
}

function publishedDetails(overrides: Partial<LessonDetails> = {}): LessonDetails {
  const base = libraryLesson();
  return {
    id: base.id,
    title: base.title,
    authorId: base.authorId,
    authorName: base.authorName,
    updatedBy: base.updatedBy,
    status: base.status,
    version: base.version,
    projectId: base.projectId,
    projectName: base.projectName,
    projectCategory: base.projectCategory,
    projectPhase: base.projectPhase,
    situationObserved: base.situationObserved,
    rootCause: base.rootCause,
    lessonType: base.lessonType,
    impact: base.impact,
    recommendation: base.recommendation,
    applicability: base.applicability,
    latestReviewGuidance: base.latestReviewGuidance,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    approvedAt: base.approvedAt,
    votesCount: base.votesCount,
    hasVoted: base.hasVoted,
    commentCount: base.commentCount,
    history: [],
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
  vi.mocked(getLibrary).mockResolvedValue({
    items: [libraryLesson()],
    page: { limit: 50, nextCursor: null },
  });
  vi.mocked(getLibraryProjectSnapshots).mockResolvedValue([]);
  vi.mocked(recordLibraryView).mockResolvedValue({ viewCount: 6 });
  vi.mocked(getLibraryLessonDetails).mockResolvedValue(publishedDetails());
  vi.mocked(getLessonDetails).mockResolvedValue(publishedDetails());
  vi.mocked(getLessonProjects).mockResolvedValue([]);
  vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
  vi.mocked(getMySubmissions).mockResolvedValue([]);
  vi.mocked(getPmoDrafts).mockResolvedValue([]);
  vi.mocked(getPmoEvaluationQueue).mockResolvedValue([]);
  vi.mocked(getEvaluationProjectSnapshots).mockResolvedValue([]);
  vi.mocked(getLessonComments).mockResolvedValue({
    items: [],
    page: { limit: 20, nextCursor: null },
    publicCommentCount: 0,
  });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
});

describe('Lessons Learned comments, single-level replies, and PMO moderation', () => {
  it('shows Library comment count, supports root comments, single-level replies, validation, Load more, and hides moderation controls from Contributors', async () => {
    const user = userEvent.setup();
    const page1: LessonCommentPage = {
      publicCommentCount: 3,
      page: { limit: 20, nextCursor: 'cursor-page-2' },
      items: [
        {
          id: 20,
          lessonId: 42,
          parentCommentId: null,
          authorId: 'local-author',
          authorDisplayName: 'Lesson Author',
          body: 'Newest root comment',
          createdAt: '2026-11-16T10:00:00.000Z',
          isHidden: false,
          moderation: null,
          replies: [
            {
              id: 21,
              lessonId: 42,
              parentCommentId: 20,
              authorId: 'local-pmo',
              authorDisplayName: 'Local PMO',
              body: 'Chronological reply',
              createdAt: '2026-11-16T11:00:00.000Z',
              isHidden: false,
              moderation: null,
            },
          ],
        },
        {
          id: 10,
          lessonId: 42,
          parentCommentId: null,
          authorId: null,
          authorDisplayName: null,
          body: null,
          createdAt: '2026-11-15T10:00:00.000Z',
          isHidden: true,
          moderation: null,
          replies: [
            {
              id: 11,
              lessonId: 42,
              parentCommentId: 10,
              authorId: 'local-contributor',
              authorDisplayName: 'Local Contributor',
              body: 'Visible reply under hidden parent',
              createdAt: '2026-11-15T12:00:00.000Z',
              isHidden: false,
              moderation: null,
            },
          ],
        },
      ],
    };
    const page2: LessonCommentPage = {
      publicCommentCount: 3,
      page: { limit: 20, nextCursor: null },
      items: [
        {
          id: 5,
          lessonId: 42,
          parentCommentId: null,
          authorId: 'local-contributor',
          authorDisplayName: 'Local Contributor',
          body: 'Older root comment from page 2',
          createdAt: '2026-11-14T10:00:00.000Z',
          isHidden: false,
          moderation: null,
          replies: [],
        },
      ],
    };
    vi.mocked(getLessonComments).mockImplementation(async (_userId, _lessonId, query) => {
      if (query?.cursor === 'cursor-page-2') return page2;
      return page1;
    });
    vi.mocked(createLessonComment).mockRejectedValueOnce(new Error('Network error'));
    vi.mocked(createLessonComment).mockResolvedValueOnce({
      id: 30,
      lessonId: 42,
      parentCommentId: null,
      authorId: 'local-contributor',
      authorDisplayName: 'Local Contributor',
      body: 'New contributor insight',
      createdAt: '2026-11-16T12:00:00.000Z',
      isHidden: false,
      moderation: null,
      replies: [],
    });
    vi.mocked(createLessonCommentReply).mockResolvedValue({
      id: 31,
      lessonId: 42,
      parentCommentId: 20,
      authorId: 'local-contributor',
      authorDisplayName: 'Local Contributor',
      body: 'Follow-up reply',
      createdAt: '2026-11-16T12:05:00.000Z',
      isHidden: false,
      moderation: null,
    });

    renderScreen('/lessons-learned/?page=library');

    // Library shows Comments column with count
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Comments' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: '2' })).toBeInTheDocument();

    // Open lesson detail
    await user.click(screen.getByRole('link', { name: 'View Improve release handover' }));
    const dialog = await screen.findByRole('dialog', { name: 'Published lesson details' });

    // Contributor sees public comments, neutral placeholder for hidden parent with visible reply, no PMO toggle, no Hide buttons, no Edit buttons
    expect(await within(dialog).findByRole('heading', { name: /Comments \(3\)/i })).toBeInTheDocument();
    expect(within(dialog).getByText('Newest root comment')).toBeInTheDocument();
    expect(within(dialog).getByText('Chronological reply')).toBeInTheDocument();
    expect(within(dialog).getByText('Comment hidden by PMO')).toBeInTheDocument();
    expect(within(dialog).getByText('Visible reply under hidden parent')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Show hidden comments/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Hide/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Edit comment/i })).not.toBeInTheDocument();
    // Only 1 Reply button (for visible root comment #20; not for reply #21, not for hidden parent #10)
    expect(within(dialog).getAllByRole('button', { name: /^Reply/i })).toHaveLength(1);

    // Load more root comments
    await user.click(within(dialog).getByRole('button', { name: /Load more/i }));
    expect(await within(dialog).findByText('Older root comment from page 2')).toBeInTheDocument();

    // Empty comment validation
    const commentBox = within(dialog).getByLabelText(/Add a comment/i);
    await user.click(within(dialog).getByRole('button', { name: 'Post comment' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/enter a comment/i);
    expect(createLessonComment).not.toHaveBeenCalled();

    // > 2000 characters validation preserves text
    fireEvent.change(commentBox, { target: { value: 'x'.repeat(2001) } });
    await user.click(within(dialog).getByRole('button', { name: 'Post comment' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/2,000/i);
    expect((commentBox as HTMLTextAreaElement).value).toHaveLength(2001);
    expect(createLessonComment).not.toHaveBeenCalled();

    // Failed post preserves typed text
    fireEvent.change(commentBox, { target: { value: 'New contributor insight' } });
    await user.click(within(dialog).getByRole('button', { name: 'Post comment' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/could not be posted/i);
    expect((commentBox as HTMLTextAreaElement).value).toBe('New contributor insight');

    // Retry succeeds and clears textarea
    await user.click(within(dialog).getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(createLessonComment).toHaveBeenCalledWith('local-contributor', 42, {
      body: 'New contributor insight',
    }));
    await waitFor(() => expect((commentBox as HTMLTextAreaElement).value).toBe(''));

    // Single-level reply submission
    await user.click(within(dialog).getAllByRole('button', { name: /^Reply/i })[0]);
    const replyBox = within(dialog).getByLabelText(/Write a reply/i);
    await user.type(replyBox, 'Follow-up reply');
    await user.click(within(dialog).getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(createLessonCommentReply).toHaveBeenCalledWith('local-contributor', 42, 20, {
      body: 'Follow-up reply',
    }));
  });

  it('allows PMO to hide comments with mandatory reason + confirmation and audit hidden comments via inline toggle', async () => {
    const user = userEvent.setup();
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getLessonComments).mockImplementation(async (_userId, _lessonId, query) => {
      if (query?.includeHidden === 'true') {
        return {
          publicCommentCount: 0,
          page: { limit: 20, nextCursor: null },
          items: [
            {
              id: 20,
              lessonId: 42,
              parentCommentId: null,
              authorId: 'local-contributor',
              authorDisplayName: 'Local Contributor',
              body: 'Original hidden text',
              createdAt: '2026-11-16T10:00:00.000Z',
              isHidden: true,
              moderation: {
                hiddenAt: '2026-11-16T12:30:00.000Z',
                hiddenByUserId: 'local-pmo',
                hiddenByDisplayName: 'Local PMO',
                reason: 'Confidential client reference',
              },
              replies: [],
            },
          ],
        };
      }
      return {
        publicCommentCount: 1,
        page: { limit: 20, nextCursor: null },
        items: [
          {
            id: 20,
            lessonId: 42,
            parentCommentId: null,
            authorId: 'local-contributor',
            authorDisplayName: 'Local Contributor',
            body: 'Comment to moderate',
            createdAt: '2026-11-16T10:00:00.000Z',
            isHidden: false,
            moderation: null,
            replies: [],
          },
        ],
      };
    });
    vi.mocked(hideLessonComment).mockResolvedValue({
      id: 20,
      lessonId: 42,
      parentCommentId: null,
      authorId: 'local-contributor',
      authorDisplayName: 'Local Contributor',
      body: 'Comment to moderate',
      createdAt: '2026-11-16T10:00:00.000Z',
      isHidden: true,
      moderation: {
        hiddenAt: '2026-11-16T12:30:00.000Z',
        hiddenByUserId: 'local-pmo',
        hiddenByDisplayName: 'Local PMO',
        reason: 'Confidential client reference',
      },
    });

    renderScreen('/lessons-learned/?page=library&lesson=42', 'local-pmo');
    const dialog = await screen.findByRole('dialog', { name: 'Published lesson details' });

    // Inline toggle is off by default
    const toggle = await within(dialog).findByRole('checkbox', { name: /Show hidden comments/i });
    expect(toggle).not.toBeChecked();

    // Hide flow requires mandatory reason and confirmation
    await user.click(await within(dialog).findByRole('button', { name: /Hide comment/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm hide' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/enter a reason/i);
    expect(hideLessonComment).not.toHaveBeenCalled();

    const reasonInput = within(dialog).getByLabelText(/Reason for hiding/i);
    await user.type(reasonInput, 'Confidential client reference');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm hide' }));
    await waitFor(() => expect(hideLessonComment).toHaveBeenCalledWith('local-pmo', 42, 20, {
      reason: 'Confidential client reference',
    }));

    // Enable "Show hidden comments" toggle -> reveals original body, reason, moderator, and UTC timestamp
    await user.click(toggle);
    await waitFor(() => expect(getLessonComments).toHaveBeenCalledWith('local-pmo', 42, {
      includeHidden: 'true',
      limit: 20,
    }));
    expect(await within(dialog).findByText('Original hidden text')).toBeInTheDocument();
    expect(within(dialog).getByText(/Confidential client reference/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Local PMO/)).toBeInTheDocument();
    expect(dialog.querySelector('time[datetime="2026-11-16T12:30:00.000Z"]')).toBeInTheDocument();
  });
});
