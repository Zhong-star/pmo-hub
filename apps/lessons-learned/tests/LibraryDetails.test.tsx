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
  getHome: vi.fn(),
  getLibrary: vi.fn(),
  getLibraryLessonDetails: vi.fn(),
  getLibraryProjectSnapshots: vi.fn(),
  recordLibraryView: vi.fn(),
  getLessonDetails: vi.fn(),
  getLessonProjects: vi.fn(),
  getMyOpenDrafts: vi.fn(),
  getMySubmissions: vi.fn(),
  getPmoDrafts: vi.fn(),
  getPmoEvaluationQueue: vi.fn(),
  getEvaluationProjectSnapshots: vi.fn(),
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
    ...overrides,
  };
}

function publishedDetails(overrides: Partial<LessonDetails> = {}): LessonDetails {
  const lesson = publishedLesson(overrides);
  return {
    ...lesson,
    authorName: 'Local Contributor',
    history: [],
    ...overrides,
  };
}

function renderLibrary(path: string, profileId = 'local-contributor') {
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
    expect(getLibraryLessonDetails).toHaveBeenCalledWith('local-contributor', 42);
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
