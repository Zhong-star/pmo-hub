import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  closeLesson,
  getHome,
  getLibrary,
  getLibraryLessonDetails,
  getLibraryProjectSnapshots,
  recordLibraryView,
  type LessonDetails,
  type LessonDraft,
  type LibraryLesson,
} from '../src/api';

import { emptyHomeSections } from './homeFixtures';

vi.mock('../src/api', () => ({
  castLessonVote: vi.fn(),
  closeLesson: vi.fn(),
  createLessonComment: vi.fn(),
  createLessonCommentReply: vi.fn(),
  getHome: vi.fn(),
  getLessonComments: vi.fn().mockResolvedValue({ items: [], page: { limit: 20, nextCursor: null }, publicCommentCount: 0 }),
  getLibrary: vi.fn(),
  getLibraryLessonDetails: vi.fn(),
  getLibraryProjectSnapshots: vi.fn(),
  getNotifications: vi.fn().mockResolvedValue({ items: [], page: { limit: 20, nextCursor: null }, unreadCount: 0 }),
  getPmoDashboard: vi.fn(),
  getProfiles: vi.fn(),
  getContributorProfile: vi.fn(),
  hideLessonComment: vi.fn(),
  markNotificationAsRead: vi.fn(),
  markNotificationsReadBatch: vi.fn(),
  recordLibraryView: vi.fn(),
  removeLessonVote: vi.fn(),
}));

const pmo = {
  profile: { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' as const },
  navigation: [{ id: 'home' as const, label: 'Home' as const, current: true as const }],
  ...emptyHomeSections,
};

function lessonDraft(overrides: Partial<LessonDraft> = {}): LessonDraft {
  return {
    id: 94,
    title: 'Close a published lesson',
    authorId: 'local-contributor',
    updatedBy: 'local-pmo',
    status: 'Approved',
    version: 6,
    projectId: null,
    projectName: null,
    projectCategory: 'Technology',
    projectPhase: 'Execution',
    situationObserved: 'The handover omitted the current runbook.',
    rootCause: 'No checklist owner had been assigned.',
    lessonType: 'Future Prevention',
    impact: 'The release team repeated verification work.',
    recommendation: 'Assign an owner to review the checklist.',
    applicability: 'Use for releases with shared operational ownership.',
    latestReviewGuidance: null,
    createdAt: '2026-11-13T12:00:00.000Z',
    updatedAt: '2026-11-14T15:30:00.000Z',
    approvedAt: '2026-11-14T15:30:00.000Z',
    ...overrides,
  };
}

function libraryLesson(overrides: Partial<LibraryLesson> = {}): LibraryLesson {
  return {
    ...lessonDraft(overrides),
    authorName: overrides.authorName ?? 'Local Contributor',
    viewCount: overrides.viewCount ?? 0,
    votesCount: overrides.votesCount ?? 0,
    hasVoted: overrides.hasVoted ?? false,
    commentCount: overrides.commentCount ?? 0,
    ...overrides,
  };
}

function renderLibrary() {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/lessons-learned/?page=library');
  window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LessonsLearnedScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLibraryProjectSnapshots).mockResolvedValue([]);
  vi.mocked(recordLibraryView).mockResolvedValue({ viewCount: 1 });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('PMO closure from the Lessons Library', () => {
  it('requires explicit confirmation and refreshes the Library with the original approval date', async () => {
    const approved = libraryLesson();
    const closed = libraryLesson({ status: 'Closed', version: 7 });
    const history: LessonDetails['history'] = [{
      id: 1,
      actorId: 'local-pmo',
      eventType: 'Approved',
      previousStatus: 'PMOEvaluation',
      newStatus: 'Approved',
      reason: null,
      occurredAt: approved.approvedAt!,
    }];
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getLibrary).mockResolvedValueOnce([approved]).mockResolvedValue([closed]);
    vi.mocked(getLibraryLessonDetails).mockResolvedValue({ ...approved, history });
    vi.mocked(closeLesson).mockResolvedValue(closed);
    const user = userEvent.setup();

    renderLibrary();

    const row = await screen.findByRole('row', { name: /Close a published lesson/ });
    expect(within(row).getByText('Approved')).toBeInTheDocument();
    await user.click(within(row).getByRole('link', { name: 'View Close a published lesson' }));
    const details = await screen.findByRole('dialog', { name: 'Published lesson details' });
    await user.click(within(details).getByRole('button', { name: 'Close lesson' }));

    const confirmation = await screen.findByRole('dialog', { name: 'Close lesson' });
    expect(within(confirmation).getByText(/version 6 of “Close a published lesson”/)).toBeInTheDocument();
    await user.click(within(confirmation).getByRole('button', { name: 'Confirm closure' }));

    await waitFor(() => expect(closeLesson).toHaveBeenCalledWith('local-pmo', approved.id, { version: 6 }));
    await waitFor(() => expect(within(screen.getByRole('row', { name: /Close a published lesson/ })).getByText('Closed')).toBeInTheDocument());
    expect(within(screen.getByRole('row', { name: /Close a published lesson/ })).getByRole('time'))
      .toHaveAttribute('datetime', approved.approvedAt);
    expect(screen.queryByRole('dialog', { name: 'Close lesson' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Published lesson details' })).not.toBeInTheDocument();
  });

  it('requires reloading the current lesson after a closure version conflict', async () => {
    const approved = libraryLesson();
    const latest = lessonDraft({ version: 7, title: 'Close a published lesson, current version' });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getLibrary).mockResolvedValue([approved]);
    vi.mocked(getLibraryLessonDetails)
      .mockResolvedValueOnce({ ...approved, history: [] })
      .mockResolvedValueOnce({ ...latest, history: [], votesCount: 0, hasVoted: false, commentCount: 0 });
    vi.mocked(closeLesson).mockRejectedValue({
      response: { status: 409, data: { code: 'STALE_LESSON_VERSION' } },
    });
    const user = userEvent.setup();

    renderLibrary();

    const row = await screen.findByRole('row', { name: /Close a published lesson/ });
    await user.click(within(row).getByRole('link', { name: 'View Close a published lesson' }));
    const details = await screen.findByRole('dialog', { name: 'Published lesson details' });
    await user.click(within(details).getByRole('button', { name: 'Close lesson' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Close lesson' });
    await user.click(within(confirmation).getByRole('button', { name: 'Confirm closure' }));

    expect(await within(confirmation).findByRole('alert')).toHaveTextContent(/Reload the current version/);
    expect(within(confirmation).getByRole('button', { name: 'Confirm closure' })).toBeDisabled();
    await user.click(within(confirmation).getByRole('button', { name: 'Reload current version' }));

    expect(await screen.findByText('Close a published lesson, current version')).toBeInTheDocument();
    expect(getLibraryLessonDetails).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog', { name: 'Close lesson' })).not.toBeInTheDocument();
    expect(closeLesson).toHaveBeenCalledTimes(1);
  });
});
