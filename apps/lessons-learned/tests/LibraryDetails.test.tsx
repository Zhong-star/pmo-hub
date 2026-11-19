import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  getHome,
  getLibrary,
  getLibraryLessonDetails,
  getLibraryProjectSnapshots,
  getLessonDetails,
  getLessonProjects,
  getMyOpenDrafts,
  getMySubmissions,
  getPmoDrafts,
  getPmoEvaluationQueue,
  getEvaluationProjectSnapshots,
  recordLibraryView,
  type LessonDraft,
  type LibraryLesson,
  type LessonDetails,
} from '../src/api';

vi.mock('../src/api', () => ({
  approveLesson: vi.fn(),
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
  getLessonComments: vi.fn().mockResolvedValue({ items: [], page: { limit: 20, nextCursor: null }, publicCommentCount: 0 }),
  getLessonDetails: vi.fn(),
  getLessonProjects: vi.fn(),
  getMyOpenDrafts: vi.fn(),
  getMySubmissions: vi.fn(),
  getPmoDrafts: vi.fn(),
  getPmoDashboard: vi.fn(),
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

function publishedLesson(overrides: Partial<LessonDraft> = {}): LessonDraft {
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
    ...publishedLesson(overrides),
    authorName: overrides.authorName ?? 'Local Contributor',
    viewCount: overrides.viewCount ?? 0,
    commentCount: overrides.commentCount ?? 0,
    ...overrides,
  };
}

function publishedDetails(overrides: Partial<LessonDetails> = {}): LessonDetails {
  const lesson = publishedLesson(overrides);
  return {
    ...lesson,
    authorName: 'Local Contributor',
    history: [],
    commentCount: overrides.commentCount ?? 0,
    ...overrides,
  };
}

function renderLibrary(path: string, profileId = 'local-contributor', gcTime = 0) {
  window.localStorage.clear();
  window.localStorage.setItem('pmo-hub.local-user-id', profileId);
  window.history.replaceState(null, '', path);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime } } })}>
      <LessonsLearnedScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getHome).mockResolvedValue(contributor);
  vi.mocked(getLibrary).mockResolvedValue([]);
  vi.mocked(getLibraryProjectSnapshots).mockResolvedValue([]);
  vi.mocked(recordLibraryView).mockResolvedValue({ viewCount: 1 });
  vi.mocked(getLibraryLessonDetails).mockImplementation(async (_profileId, lessonId) => publishedDetails({ id: lessonId }));
  vi.mocked(getLessonProjects).mockResolvedValue([]);
  vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
  vi.mocked(getMySubmissions).mockResolvedValue([]);
  vi.mocked(getPmoDrafts).mockResolvedValue([]);
  vi.mocked(getPmoEvaluationQueue).mockResolvedValue([]);
  vi.mocked(getEvaluationProjectSnapshots).mockResolvedValue([]);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
});

describe('published Library lesson details', () => {
  it('revalidates a direct lesson URL and returns its close action to the Library', async () => {
    renderLibrary('/lessons-learned/?page=library&lesson=42');

    expect(await screen.findByRole('dialog', { name: 'Published lesson details' })).toBeInTheDocument();
    await waitFor(() => expect(getLibraryLessonDetails).toHaveBeenCalledWith('local-contributor', 42));
    expect(recordLibraryView).not.toHaveBeenCalled();
    expect(await screen.findByText('No checklist owner had been assigned.')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: 'Published lesson details' })).getByText('Local Contributor')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: 'Published lesson details' })).getByText('Approved', { selector: 'dd' })).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-11-14T12:00:00.000Z"]')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'History' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve|close lesson/i })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Close published lesson details' }));
    await waitFor(() => expect(window.location.search).toBe('?page=library'));
    expect(screen.queryByRole('dialog', { name: 'Published lesson details' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lessons Library' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lessons Library' })).toHaveFocus();
  });

  it('keeps the Library usable with the previous API and limits its detail fallback to published lessons', async () => {
    vi.mocked(getLibraryProjectSnapshots).mockRejectedValue({ response: { status: 404 } });
    vi.mocked(getLibrary).mockResolvedValue([libraryLesson()]);
    vi.mocked(getLessonDetails).mockResolvedValue(publishedDetails({
      history: [{
        id: 7,
        eventType: 'Approved',
        previousStatus: 'PMOEvaluation',
        newStatus: 'Approved',
        actorId: 'local-pmo',
        occurredAt: '2026-11-14T12:30:00.000Z',
        reason: null,
      }],
    }));
    renderLibrary('/lessons-learned/?page=library');

    const lessonLink = await screen.findByRole('link', { name: 'View Improve release handover' });
    expect(getLibrary).toHaveBeenCalledWith('local-contributor', { paged: 'true', cursor: undefined });
    expect(screen.queryByRole('searchbox', { name: 'Search title or ID' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Lesson type' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Sort by' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Views' })).not.toBeInTheDocument();

    await userEvent.setup().click(lessonLink);
    const details = await screen.findByRole('dialog', { name: 'Published lesson details' });
    expect(getLessonDetails).toHaveBeenCalledWith('local-contributor', 42);
    expect(getLibraryLessonDetails).not.toHaveBeenCalled();
    expect(recordLibraryView).not.toHaveBeenCalled();
    expect(within(details).getByText('No checklist owner had been assigned.')).toBeVisible();
    expect(within(details).getByRole('heading', { name: 'History' })).toBeVisible();
    expect(document.querySelector('time[datetime="2026-11-14T12:00:00.000Z"]')).toBeInTheDocument();
  });

  it('does not render legacy details unless they are approved or closed with an approval date', async () => {
    vi.mocked(getLibraryProjectSnapshots).mockRejectedValue({ response: { status: 404 } });
    vi.mocked(getLessonDetails).mockResolvedValue(publishedDetails({
      status: 'Open',
      approvedAt: null,
      situationObserved: 'PRIVATE DRAFT CONTENT',
    }));
    renderLibrary('/lessons-learned/?page=library&lesson=42');

    expect(await screen.findByRole('dialog', { name: 'Published lesson details' })).toBeInTheDocument();
    expect(await screen.findByText('Lesson details and history could not be loaded.')).toBeVisible();
    expect(screen.queryByText('PRIVATE DRAFT CONTENT')).not.toBeInTheDocument();
    expect(getLessonDetails).toHaveBeenCalledWith('local-contributor', 42);
    expect(getLibraryLessonDetails).not.toHaveBeenCalled();
    expect(recordLibraryView).not.toHaveBeenCalled();
  });

  it('keeps permission failures on the current Library API path', async () => {
    vi.mocked(getLibraryProjectSnapshots).mockRejectedValue({ response: { status: 403 } });
    vi.mocked(getLibrary).mockResolvedValue([libraryLesson()]);
    renderLibrary('/lessons-learned/?page=library');

    expect(await screen.findByRole('link', { name: 'View Improve release handover' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search title or ID' })).toBeInTheDocument();
    expect(getLibrary).toHaveBeenCalledWith('local-contributor', {
      paged: 'true',
      cursor: undefined,
    });
    expect(getLibraryProjectSnapshots).toHaveBeenCalledWith('local-contributor');
    expect(screen.getByText('Published project filter options could not be loaded.')).toBeVisible();
  });

  it('uses only the dedicated detail route on the current API, including for 404 responses', async () => {
    vi.mocked(getLibraryLessonDetails).mockRejectedValue({ response: { status: 404 } });
    vi.mocked(getLessonDetails).mockResolvedValue(publishedDetails({ situationObserved: 'PRIVATE FALLBACK CONTENT' }));
    renderLibrary('/lessons-learned/?page=library&lesson=42');

    expect(await screen.findByRole('dialog', { name: 'Published lesson details' })).toBeInTheDocument();
    expect(await screen.findByText('Lesson details and history could not be loaded.')).toBeVisible();
    expect(screen.queryByText('PRIVATE FALLBACK CONTENT')).not.toBeInTheDocument();
    expect(getLibraryLessonDetails).toHaveBeenCalledWith('local-contributor', 42);
    expect(getLessonDetails).not.toHaveBeenCalled();
  });

  it('opens a shareable Library URL and closes with browser history while restoring focus', async () => {
    vi.mocked(getLibrary).mockResolvedValue([libraryLesson()]);
    renderLibrary('/lessons-learned/?page=library');
    const user = userEvent.setup();
    const lessonLink = await screen.findByRole('link', { name: 'View Improve release handover' });

    await user.click(lessonLink);
    expect(window.location.search).toBe('?page=library&lesson=42');
    expect(await screen.findByRole('dialog', { name: 'Published lesson details' })).toBeInTheDocument();
    expect(getLibraryLessonDetails).toHaveBeenCalledWith('local-contributor', 42);
    await waitFor(() => expect(recordLibraryView).toHaveBeenCalledWith(
      'local-contributor', 42, { openingId: expect.stringMatching(/^[0-9a-f-]{36}$/i) },
    ));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(window.location.search).toBe('?page=library'));
    expect(screen.getByRole('link', { name: 'View Improve release handover' })).toHaveFocus();
  });

  it('hides cached content and history while revalidating a reopened detail after access is revoked', async () => {
    const accessDenied = { response: { status: 403, data: { code: 'ACCESS_DENIED' } } };
    const historyReason = 'Private review guidance.';
    const historyText = /Private review guidance/;
    let rejectRevalidation: (error: unknown) => void = () => {
      throw new Error('The detail must be requested again.');
    };
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getLibrary).mockResolvedValue([libraryLesson()]);
    vi.mocked(getLibraryLessonDetails)
      .mockResolvedValueOnce(publishedDetails({
        history: [{
          id: 1,
          actorId: 'local-pmo',
          eventType: 'Returned',
          previousStatus: 'PMOEvaluation',
          newStatus: 'Open',
          reason: historyReason,
          occurredAt: '2026-11-13T13:00:00.000Z',
        }],
      }))
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectRevalidation = reject; }));
    renderLibrary('/lessons-learned/?page=library', 'local-pmo', 5 * 60_000);
    const user = userEvent.setup();
    const lessonLink = await screen.findByRole('link', { name: 'View Improve release handover' });
    const dialogName = 'Published lesson details';

    await user.click(lessonLink);
    const initialDialog = await screen.findByRole('dialog', { name: dialogName });
    expect(await within(initialDialog).findByText(historyText)).toBeVisible();
    await waitFor(() => expect(recordLibraryView).toHaveBeenCalledTimes(1));
    await user.click(within(initialDialog).getByRole('button', { name: 'Close published lesson details' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: dialogName })).not.toBeInTheDocument());

    vi.mocked(getHome).mockRejectedValue(accessDenied);
    await user.click(lessonLink);
    await waitFor(() => expect(getLibraryLessonDetails).toHaveBeenCalledTimes(2));
    const reopenedDialog = within(await screen.findByRole('dialog', { name: dialogName }));
    expect(reopenedDialog.queryByText(historyText)).not.toBeInTheDocument();
    expect(reopenedDialog.queryByText('The handover omitted the runbook.')).not.toBeInTheDocument();
    expect(reopenedDialog.queryByRole('button', { name: /^Close lesson$/ })).not.toBeInTheDocument();
    expect(reopenedDialog.getByRole('status')).toHaveTextContent('Loading lesson details');

    rejectRevalidation(accessDenied);
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: dialogName })).not.toBeInTheDocument();
    expect(screen.queryByText(historyText)).not.toBeInTheDocument();
    expect(recordLibraryView).toHaveBeenCalledTimes(1);
  });

  it('keeps the PMO closure action available from a published Library detail', async () => {
    vi.mocked(getHome).mockResolvedValue(pmo);
    renderLibrary('/lessons-learned/?page=library&lesson=42', 'local-pmo');

    expect(await screen.findByRole('button', { name: 'Close lesson' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close lesson' }));
    expect(await screen.findByRole('dialog', { name: 'Close lesson' })).toBeInTheDocument();
  });

  it('keeps the detail and confirmed view count available when recording needs a retry', async () => {
    vi.mocked(getLibrary).mockResolvedValue([libraryLesson({ viewCount: 7 })]);
    vi.mocked(recordLibraryView)
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ viewCount: 8 });
    renderLibrary('/lessons-learned/?page=library');
    const lessonLink = await screen.findByRole('link', { name: 'View Improve release handover' });
    const row = lessonLink.closest('tr')!;
    const user = userEvent.setup();
    await user.click(lessonLink);

    const details = await screen.findByRole('dialog', { name: 'Published lesson details' });
    expect(await within(details).findByText('The handover omitted the runbook.')).toBeVisible();
    await waitFor(() => expect(recordLibraryView).toHaveBeenCalledTimes(1));
    expect(within(row).getByRole('cell', { name: '7' })).toBeInTheDocument();

    await waitFor(() => expect(recordLibraryView).toHaveBeenCalledTimes(2), { timeout: 3000 });
    const [firstAttempt, retry] = vi.mocked(recordLibraryView).mock.calls;
    expect(retry).toEqual(firstAttempt);
    expect(details).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(within(row).getByRole('cell', { name: '8' })).toBeInTheDocument());
  });
});
