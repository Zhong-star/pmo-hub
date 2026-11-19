import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  getHome,
  getLessonDetails,
  getLessonProjects,
  getLibrary,
  getLibraryProjectSnapshots,
  getMyOpenDrafts,
  getMySubmissions,
  getNotifications,
  markNotificationAsRead,
  markNotificationsReadBatch,
  recordLibraryView,
  type LessonDetails,
  type LessonNotificationItem,
  type LessonNotificationPage,
} from '../src/api';

import { emptyHomeSections } from './homeFixtures';

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
  getNotifications: vi.fn(),
  getPmoDashboard: vi.fn(),
  getPmoDrafts: vi.fn(),
  getPmoEvaluationQueue: vi.fn(),
  getProfiles: vi.fn(),
  getContributorProfile: vi.fn(),
  hideLessonComment: vi.fn(),
  markNotificationAsRead: vi.fn(),
  markNotificationsReadBatch: vi.fn(),
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
  ...emptyHomeSections,
};

function makeNotification(overrides: Partial<LessonNotificationItem> = {}): LessonNotificationItem {
  return {
    id: 101,
    eventType: 'LESSON_APPROVED',
    actorUserId: 'local-pmo',
    actorDisplayName: 'Local PMO',
    lessonId: 42,
    lessonTitle: 'Improve release handover',
    summary: 'Local PMO approved your lesson.',
    createdAt: '2026-11-18T14:30:00.000Z',
    readAt: null,
    isRead: false,
    ...overrides,
  };
}

function makeLessonDetails(overrides: Partial<LessonDetails> = {}): LessonDetails {
  return {
    id: 42,
    title: 'Improve release handover',
    authorId: 'local-contributor',
    authorName: 'Local Contributor',
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
    votesCount: 2,
    hasVoted: false,
    commentCount: 1,
    history: [],
    ...overrides,
  };
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LessonsLearnedScreen />
    </QueryClientProvider>,
  );
}

describe('Notifications menu and D7/D8 behaviors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
    window.history.replaceState(null, '', '/lessons-learned/');
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    vi.mocked(getMySubmissions).mockResolvedValue([]);
    vi.mocked(getLessonProjects).mockResolvedValue([]);
    vi.mocked(getLibrary).mockResolvedValue({ items: [], page: { limit: 20, nextCursor: null } });
    vi.mocked(getLibraryProjectSnapshots).mockResolvedValue([]);
    vi.mocked(getNotifications).mockResolvedValue({
      items: [],
      page: { limit: 20, nextCursor: null },
      unreadCount: 0,
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('shows unread badge on load, reloads on menu open and navigation, and renders empty state', async () => {
    const user = userEvent.setup();
    vi.mocked(getNotifications)
      .mockResolvedValueOnce({ items: [], page: { limit: 20, nextCursor: null }, unreadCount: 0 })
      .mockResolvedValueOnce({ items: [], page: { limit: 20, nextCursor: null }, unreadCount: 0 })
      .mockResolvedValueOnce({
        items: [makeNotification()],
        page: { limit: 20, nextCursor: null },
        unreadCount: 1,
      });

    renderScreen();

    const trigger = await screen.findByRole('button', { name: /Notifications/i });
    await user.click(trigger);

    const menu = await screen.findByRole('region', { name: 'Notifications' });
    expect(within(menu).getByText(/No notifications yet/i)).toBeInTheDocument();

    // Close and navigate to Lessons Library -> badge updates via HTTP reload on navigation
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('link', { name: 'Lessons Library' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Notifications \(1 unread\)/i })).toBeInTheDocument();
    });
    expect(vi.mocked(getNotifications).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('displays notification fields, supports Load more, single mark-as-read, and loaded-only Mark loaded as read', async () => {
    const user = userEvent.setup();
    const page1: LessonNotificationPage = {
      items: [
        makeNotification({
          id: 201,
          eventType: 'LESSON_RETURNED',
          actorDisplayName: 'Local PMO',
          lessonId: 10,
          lessonTitle: 'Deployment checklist',
          summary: 'Local PMO returned your lesson for changes: Add metrics.',
          isRead: false,
        }),
        makeNotification({
          id: 202,
          eventType: 'COMMENT_ADDED',
          actorUserId: 'local-peer',
          actorDisplayName: 'Peer Reviewer',
          lessonId: 11,
          lessonTitle: 'Cutover plan',
          summary: 'Peer Reviewer commented: Great checklist.',
          isRead: false,
        }),
      ],
      page: { limit: 2, nextCursor: 'cursor-page-2' },
      unreadCount: 3,
    };
    const page2: LessonNotificationPage = {
      items: [
        makeNotification({
          id: 203,
          eventType: 'REPLY_ADDED',
          actorUserId: 'local-peer',
          actorDisplayName: 'Peer Reviewer',
          lessonId: 11,
          lessonTitle: 'Cutover plan',
          summary: 'Peer Reviewer replied: Thanks!',
          isRead: false,
        }),
      ],
      page: { limit: 2, nextCursor: null },
      unreadCount: 1,
    };

    vi.mocked(getNotifications).mockImplementation(async (_profileId, query) => {
      if (query?.cursor === 'cursor-page-2') return page2;
      return page1;
    });
    vi.mocked(markNotificationsReadBatch).mockResolvedValue({
      updatedIds: [201, 202],
      unreadCount: 1,
    });
    vi.mocked(markNotificationAsRead).mockResolvedValue({
      notification: { ...page2.items[0], isRead: true, readAt: '2026-11-18T15:00:00.000Z' },
      unreadCount: 0,
    });

    renderScreen();

    const trigger = await screen.findByRole('button', { name: /Notifications \(3 unread\)/i });
    await user.click(trigger);

    const menu = await screen.findByRole('region', { name: 'Notifications' });
    expect(within(menu).getByText('Lesson returned')).toBeInTheDocument();
    expect(within(menu).getByText(/#10/)).toBeInTheDocument();
    expect(within(menu).getByText(/Deployment checklist/)).toBeInTheDocument();
    expect(within(menu).getByText(/Local PMO returned your lesson for changes/)).toBeInTheDocument();

    // Batch mark ONLY the 2 loaded notifications (201, 202), NOT unloaded 203!
    await user.click(within(menu).getByRole('button', { name: 'Mark loaded as read' }));
    await waitFor(() => {
      expect(markNotificationsReadBatch).toHaveBeenCalledWith('local-contributor', {
        notificationIds: [201, 202],
      });
    });
    expect(screen.getByRole('button', { name: /Notifications \(1 unread\)/i })).toBeInTheDocument();

    // Load more brings item 203 (still unread), then single mark as read
    await user.click(within(menu).getByRole('button', { name: 'Load more' }));
    expect(await within(menu).findByText(/Peer Reviewer replied: Thanks!/)).toBeInTheDocument();

    await user.click(within(menu).getByRole('button', { name: /Mark notification for #11 as read/i }));
    await waitFor(() => {
      expect(markNotificationAsRead).toHaveBeenCalledWith('local-contributor', 203);
    });
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('opens Lesson Detail from a notification with fresh access revalidation and WITHOUT incrementing views (D7)', async () => {
    const user = userEvent.setup();
    vi.mocked(getNotifications).mockResolvedValue({
      items: [makeNotification({ id: 301, lessonId: 42, lessonTitle: 'Improve release handover' })],
      page: { limit: 20, nextCursor: null },
      unreadCount: 1,
    });
    vi.mocked(getLessonDetails).mockResolvedValue(makeLessonDetails({ id: 42 }));

    renderScreen();

    await user.click(await screen.findByRole('button', { name: /Notifications \(1 unread\)/i }));
    const menu = await screen.findByRole('region', { name: 'Notifications' });
    await user.click(within(menu).getByRole('button', { name: /Open lesson #42: Improve release handover/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Improve release handover')).toBeInTheDocument();
    expect(getLessonDetails).toHaveBeenCalledWith('local-contributor', 42);
    expect(recordLibraryView).not.toHaveBeenCalled();
  });

  it('blocks access when a notification points to a lesson whose access was revoked', async () => {
    const user = userEvent.setup();
    vi.mocked(getNotifications).mockResolvedValue({
      items: [makeNotification({ id: 401, lessonId: 99, lessonTitle: 'Restricted lesson' })],
      page: { limit: 20, nextCursor: null },
      unreadCount: 1,
    });
    vi.mocked(getLessonDetails).mockRejectedValue({
      response: { status: 404, data: { code: 'NOT_FOUND', message: 'Lesson not found.' } },
    });

    renderScreen();

    await user.click(await screen.findByRole('button', { name: /Notifications \(1 unread\)/i }));
    const menu = await screen.findByRole('region', { name: 'Notifications' });
    await user.click(within(menu).getByRole('button', { name: /Open lesson #99: Restricted lesson/i }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(within(dialog).queryByText('The handover omitted the runbook.')).not.toBeInTheDocument();
    expect(recordLibraryView).not.toHaveBeenCalled();
  });
});
