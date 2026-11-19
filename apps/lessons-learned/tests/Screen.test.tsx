import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  approveLesson,
  cancelLesson,
  createLessonDraft,
  getHome,
  getLibrary,
  getLibraryLessonDetails,
  getLibraryProjectSnapshots,
  getRankings,
  recordLibraryView,
  getLessonDetails,
  getLessonProjects,
  getMyOpenDrafts,
  getMySubmissions,
  getPmoDrafts,
  getPmoEvaluationQueue,
  getEvaluationProjectSnapshots,
  returnLesson,
  rejectLesson,
  updateLessonDraft,
  type LessonDraft,
  type LibraryLesson,
  type LessonDetails,
  type UpdateLessonDraftBody,
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
  getRankings: vi.fn().mockResolvedValue({ mostVotedLessons: [], topContributors: [] }),
  getPmoEvaluationQueue: vi.fn(),
  getEvaluationProjectSnapshots: vi.fn(),
  hideLessonComment: vi.fn(),
  markNotificationAsRead: vi.fn(),
  markNotificationsReadBatch: vi.fn(),
  returnLesson: vi.fn(),
  rejectLesson: vi.fn(),
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

function lessonDraft(overrides: Partial<LessonDraft> = {}): LessonDraft {
  return {
    id: 7,
    title: 'Improve release handover',
    authorId: 'local-contributor',
    updatedBy: 'local-contributor',
    status: 'Open',
    version: 1,
    projectId: null,
    projectName: null,
    projectCategory: null,
    projectPhase: null,
    situationObserved: null,
    rootCause: null,
    lessonType: null,
    impact: null,
    recommendation: null,
    applicability: null,
    latestReviewGuidance: null,
    createdAt: '2026-11-13T12:00:00.000Z',
    updatedAt: '2026-11-13T12:00:00.000Z',
    approvedAt: null,
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

function lessonDetails(overrides: Partial<LessonDetails> = {}): LessonDetails {
  const draft = lessonDraft(overrides);
  return {
    ...draft,
    history: [{
      id: 1,
      actorId: draft.authorId,
      eventType: 'Created',
      previousStatus: null,
      newStatus: 'Open',
      reason: null,
      occurredAt: draft.createdAt,
    }],
    votesCount: overrides.votesCount ?? 0,
    hasVoted: overrides.hasVoted ?? false,
    commentCount: overrides.commentCount ?? 0,
    ...overrides,
  };
}

function renderScreen(localUserId?: string, gcTime = 0, page?: 'my-submissions' | 'pmo-drafts' | 'evaluation-queue' | 'library') {
  window.localStorage.clear();
  window.history.replaceState(null, '', page ? `/lessons-learned/?page=${page}` : '/lessons-learned/');
  if (localUserId) window.localStorage.setItem('pmo-hub.local-user-id', localUserId);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <LessonsLearnedScreen />
    </QueryClientProvider>,
  );
}

function apiError(status: number, code: string) {
  return Object.assign(new Error('Request failed'), {
    code: 'ERR_BAD_REQUEST',
    response: { status, data: { code } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLessonProjects).mockResolvedValue([
    { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' },
  ]);
  vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
  vi.mocked(getMySubmissions).mockImplementation((profileId) => getMyOpenDrafts(profileId));
  vi.mocked(getPmoDrafts).mockResolvedValue([]);
  vi.mocked(getPmoEvaluationQueue).mockResolvedValue([]);
  vi.mocked(getEvaluationProjectSnapshots).mockResolvedValue([]);
  vi.mocked(getLibraryProjectSnapshots).mockResolvedValue([]);
  vi.mocked(getRankings).mockResolvedValue({ mostVotedLessons: [], topContributors: [] });
  vi.mocked(returnLesson).mockImplementation(async (_profileId, lessonId) => lessonDraft({
    id: lessonId,
    status: 'Open',
    updatedBy: 'local-pmo',
  }));
  vi.mocked(getLibrary).mockResolvedValue([]);
  vi.mocked(recordLibraryView).mockResolvedValue({ viewCount: 1 });
  vi.mocked(getLibraryLessonDetails).mockImplementation(async (_profileId, lessonId) => ({
    ...lessonDetails({ id: lessonId }),
    history: [],
  }));
  vi.mocked(getLessonDetails).mockImplementation(async (_profileId, lessonId) => lessonDetails({ id: lessonId }));
  vi.mocked(updateLessonDraft).mockImplementation(async (_profileId, _draftId, input) => lessonDraft({
    ...input,
    updatedBy: 'local-contributor',
    version: input.version + 1,
  }));
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
});

describe('Lessons Learned access check', () => {
  it('returns to the Hub profile selector when no local profile is selected', () => {
    renderScreen();

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PMO Hub' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('heading', { name: 'Access check' })).toBeInTheDocument();
    expect(screen.getByText(/No local profile is selected/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Select a local profile' })).toHaveAttribute('href', '/');
    expect(getHome).not.toHaveBeenCalled();
  });

  it('lists the current profile’s open drafts and reopens a saved draft after navigation', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([lessonDraft()]);
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));

    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reopen Improve release handover' }));
    expect(screen.getByRole('dialog', { name: 'Edit lesson' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Improve release handover');
    expect(getMySubmissions).toHaveBeenCalledWith('local-contributor');
  });

  it('shows PMO Drafts with an Open default and rows that identify each lesson', async () => {
    const openDraft = lessonDraft({
      id: 41,
      title: 'PMO review handover',
      projectName: 'Fictional Atlas Modernization',
      projectId: 'LOCAL-PROJECT-001',
      lessonType: 'Communication',
      updatedAt: '2026-11-13T15:30:00.000Z',
    });
    const closedDraft = lessonDraft({ id: 42, title: 'PMO closed lesson', status: 'Closed' });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoDrafts).mockImplementation(async (_profileId, filters = {}) => (
      filters.status === 'Open' ? [openDraft] : [openDraft, closedDraft]
    ));
    const user = userEvent.setup();

    renderScreen('local-pmo');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'PMO Drafts' }));

    expect(await screen.findByRole('heading', { name: 'PMO Drafts' })).toBeInTheDocument();
    expect(getPmoDrafts).toHaveBeenCalledWith('local-pmo', { status: 'Open' });
    const row = screen.getByRole('row', { name: /PMO review handover/ });
    expect(within(row).getByText('#41')).toBeInTheDocument();
    expect(within(row).getByText('local-contributor')).toBeInTheDocument();
    expect(within(row).getByText('Fictional Atlas Modernization')).toBeInTheDocument();
    expect(within(row).getByText('Communication')).toBeInTheDocument();
    expect(within(row).getByText('Open')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'View PMO review handover' })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), '');
    await screen.findByRole('row', { name: /PMO closed lesson/ });
    expect(getPmoDrafts).toHaveBeenCalledWith('local-pmo', {});
  });

  it('does not expose PMO Drafts or request the private list for a Contributor deep link', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);

    renderScreen('local-contributor', 0, 'pmo-drafts');

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'PMO Drafts' })).not.toBeInTheDocument();
    expect(getPmoDrafts).not.toHaveBeenCalled();
  });

  it('shows the PMO evaluation queue and opens its history using the keyboard', async () => {
    const oldestSubmission = lessonDraft({ id: 80, title: 'Oldest submitted lesson', status: 'PMOEvaluation' });
    const newestSubmission = lessonDraft({ id: 81, title: 'Newest submitted lesson', status: 'PMOEvaluation' });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockResolvedValue([oldestSubmission, newestSubmission]);
    vi.mocked(getLessonDetails).mockResolvedValue({
      ...lessonDetails(oldestSubmission),
      history: [
        { id: 1, actorId: 'local-contributor', eventType: 'Created', previousStatus: null, newStatus: 'Open', reason: null, occurredAt: oldestSubmission.createdAt },
        { id: 2, actorId: 'local-contributor', eventType: 'Submitted', previousStatus: 'Open', newStatus: 'PMOEvaluation', reason: null, occurredAt: oldestSubmission.updatedAt },
      ],
    });
    const user = userEvent.setup();

    renderScreen('local-pmo');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'Evaluation Queue' }));

    expect(await screen.findByRole('heading', { name: 'Evaluation Queue' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Evaluation Queue' })).toHaveAttribute('aria-current', 'page');
    expect(getPmoEvaluationQueue).toHaveBeenCalledWith('local-pmo', {}, { paged: 'true', cursor: undefined });

    const table = screen.getByRole('table', { name: 'Lessons awaiting PMO evaluation, oldest submission first' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Oldest submitted lesson');
    expect(rows[2]).toHaveTextContent('Newest submitted lesson');

    const viewButton = within(rows[1]!).getByRole('button', { name: 'View Oldest submitted lesson' });
    viewButton.focus();
    await user.keyboard('{Enter}');
    const details = await screen.findByRole('dialog', { name: 'Lesson details' });
    expect(within(details).getByText('Submitted')).toBeInTheDocument();
    const closeButton = within(details).getByRole('button', { name: 'Close lesson details' });
    await waitFor(() => expect(closeButton).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Lesson details' })).not.toBeInTheDocument();
    expect(viewButton).toHaveFocus();
  });

  it('requires guidance before PMO confirms returning an evaluation queue lesson', async () => {
    const lesson = lessonDraft({ id: 83, title: 'PMO return decision', status: 'PMOEvaluation' });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockResolvedValue([lesson]);
    vi.mocked(getLessonDetails).mockResolvedValue(lessonDetails(lesson));
    const user = userEvent.setup();

    renderScreen('local-pmo', 0, 'evaluation-queue');

    await user.click(await screen.findByRole('button', { name: 'View PMO return decision' }));
    const details = await screen.findByRole('dialog', { name: 'Lesson details' });
    await user.click(within(details).getByRole('button', { name: 'Return for changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Return lesson' });

    await user.click(within(dialog).getByRole('button', { name: 'Confirm return' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter guidance for the author.');

    const guidance = 'Please link the revised checklist.';
    await user.type(within(dialog).getByRole('textbox', { name: 'Guidance for author' }), guidance);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm return' }));

    expect(returnLesson).toHaveBeenCalledWith('local-pmo', lesson.id, { version: lesson.version, guidance });
    expect(await screen.findByRole('heading', { name: 'Evaluation Queue' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Return lesson' })).not.toBeInTheDocument();
  });

  it('lets PMO edit an evaluation from its details without offering another submission', async () => {
    const evaluation = lessonDraft({
      id: 82,
      title: 'Evaluation awaiting PMO edits',
      authorId: 'local-contributor',
      status: 'PMOEvaluation',
      version: 4,
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      situationObserved: 'The release handover omitted the current runbook.',
      rootCause: 'No checklist owner had been assigned.',
      lessonType: 'Future Prevention',
      impact: 'The release team repeated verification work.',
      recommendation: 'Assign an owner to review the checklist.',
      applicability: 'Use for releases with shared operational ownership.',
    });
    const saved = lessonDraft({ ...evaluation, title: 'Evaluation corrected by PMO', updatedBy: 'local-pmo', version: 5 });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockResolvedValue([evaluation]);
    vi.mocked(getLessonDetails).mockResolvedValue(lessonDetails(evaluation));
    vi.mocked(updateLessonDraft).mockResolvedValue(saved);
    const user = userEvent.setup();

    renderScreen('local-pmo');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'Evaluation Queue' }));
    await user.click(await screen.findByRole('button', { name: `View ${evaluation.title}` }));
    const details = await screen.findByRole('dialog', { name: 'Lesson details' });
    await user.click(within(details).getByRole('button', { name: 'Edit lesson' }));

    const editor = await screen.findByRole('dialog', { name: 'Edit lesson' });
    expect(within(editor).queryByRole('button', { name: 'Submit for PMO Review' })).not.toBeInTheDocument();
    await user.clear(within(editor).getByRole('textbox', { name: 'Title' }));
    await user.type(within(editor).getByRole('textbox', { name: 'Title' }), 'Evaluation corrected by PMO');
    await user.click(within(editor).getByRole('button', { name: 'Save Draft' }));

    expect(await within(editor).findByText('Draft saved.', { exact: true })).toBeInTheDocument();
    expect(updateLessonDraft).toHaveBeenCalledWith('local-pmo', evaluation.id, expect.objectContaining({
      version: evaluation.version,
      title: 'Evaluation corrected by PMO',
      situationObserved: evaluation.situationObserved,
    } satisfies Partial<UpdateLessonDraftBody>));
  });

  it('keeps PMO evaluation edits in the editor and shows API field errors after validation fails', async () => {
    const evaluation = lessonDraft({
      id: 83,
      title: 'Evaluation validation keeps entered edits',
      status: 'PMOEvaluation',
      version: 2,
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      situationObserved: 'The release handover omitted the current runbook.',
      rootCause: null,
      lessonType: 'Communication',
      impact: 'The release team repeated verification work.',
      recommendation: 'Assign an owner to review the checklist.',
      applicability: 'Use for releases with shared operational ownership.',
    });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockResolvedValue([evaluation]);
    vi.mocked(getLessonDetails).mockResolvedValue(lessonDetails(evaluation));
    vi.mocked(updateLessonDraft).mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          code: 'INVALID_LESSON_EDIT',
          message: 'Correct the indicated fields before saving.',
          fieldErrors: { impact: 'Impact is required.' },
        },
      },
    });
    const user = userEvent.setup();

    renderScreen('local-pmo');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'Evaluation Queue' }));
    await user.click(await screen.findByRole('button', { name: `View ${evaluation.title}` }));
    const details = await screen.findByRole('dialog', { name: 'Lesson details' });
    await user.click(within(details).getByRole('button', { name: 'Edit lesson' }));

    const editor = await screen.findByRole('dialog', { name: 'Edit lesson' });
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'PMO typed corrections remain after rejection');
    const situation = within(editor).getByRole('textbox', { name: 'Situation observed' });
    await user.clear(situation);
    await user.type(situation, 'The approved runbook was absent from the handover.');
    await user.click(within(editor).getByRole('button', { name: 'Save Draft' }));

    expect(await within(editor).findByText('Correct the indicated fields before saving. Your changes are still here.'))
      .toBeInTheDocument();
    expect(title).toHaveValue('PMO typed corrections remain after rejection');
    expect(situation).toHaveValue('The approved runbook was absent from the handover.');
    expect(within(editor).getByText('Impact is required.')).toBeInTheDocument();
  });

  it('lets PMO confirm a rejection with a required reason and removes the lesson from the queue', async () => {
    const submitted = lessonDraft({ id: 83, title: 'Duplicate rollout guidance', status: 'PMOEvaluation' });
    const archived = lessonDraft({ ...submitted, status: 'Archived', updatedBy: 'local-pmo', version: submitted.version + 1 });
    let isRejected = false;
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockImplementation(async () => isRejected ? [] : [submitted]);
    vi.mocked(rejectLesson).mockImplementation(async () => {
      isRejected = true;
      return archived;
    });
    const user = userEvent.setup();

    renderScreen('local-pmo', 0, 'evaluation-queue');
    const table = await screen.findByRole('table', { name: 'Lessons awaiting PMO evaluation, oldest submission first' });
    const row = within(table).getByRole('row', { name: /Duplicate rollout guidance/ });
    await user.click(within(row).getByRole('button', { name: 'Reject Duplicate rollout guidance' }));

    const dialog = screen.getByRole('dialog', { name: 'Reject lesson' });
    const reason = within(dialog).getByRole('textbox', { name: 'Reason for rejection' });
    expect(reason).toHaveAttribute('maxLength', '1000');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm rejection' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a reason for rejecting this lesson.');
    expect(rejectLesson).not.toHaveBeenCalled();

    await user.type(reason, 'This guidance is already recorded.');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm rejection' }));

    expect(rejectLesson).toHaveBeenCalledWith('local-pmo', submitted.id, {
      version: submitted.version,
      reason: 'This guidance is already recorded.',
    });
    expect(await screen.findByText('No lessons are awaiting PMO evaluation.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Reject lesson' })).not.toBeInTheDocument();
  });

  it('shows the rejection reason in the author’s My Submissions history', async () => {
    const archived = lessonDraft({ id: 84, title: 'Rejected lesson in My Submissions', status: 'Archived', updatedBy: 'local-pmo', version: 3 });
    const reason = 'This lesson duplicates existing guidance.';
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockResolvedValue([archived]);
    vi.mocked(getLessonDetails).mockResolvedValue({
      ...lessonDetails(archived),
      history: [
        { id: 1, actorId: archived.authorId, eventType: 'Created', previousStatus: null, newStatus: 'Open', reason: null, occurredAt: archived.createdAt },
        { id: 2, actorId: archived.authorId, eventType: 'Submitted', previousStatus: 'Open', newStatus: 'PMOEvaluation', reason: null, occurredAt: archived.updatedAt },
        { id: 3, actorId: 'local-pmo', eventType: 'Rejected', previousStatus: 'PMOEvaluation', newStatus: 'Archived', reason, occurredAt: archived.updatedAt },
      ],
    });
    const user = userEvent.setup();

    renderScreen('local-contributor', 0, 'my-submissions');
    await screen.findByRole('heading', { name: 'My Submissions' });
    await user.click(await screen.findByRole('button', { name: `View ${archived.title}` }));

    const details = await screen.findByRole('dialog', { name: 'Lesson details' });
    expect(await within(details).findByText(`Rejection reason: ${reason}`)).toBeInTheDocument();
  });

  it('does not expose the evaluation queue or call its API for a Contributor deep link', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);

    renderScreen('local-contributor', 0, 'evaluation-queue');

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Evaluation Queue' })).not.toBeInTheDocument();
    expect(getPmoEvaluationQueue).not.toHaveBeenCalled();
  });

  it('shows the initial Library to Contributors and opens published content without full history', async () => {
    const published = libraryLesson({
      id: 91,
      title: 'Published release verification',
      status: 'Approved',
      approvedAt: '2026-11-14T15:30:00.000Z',
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      situationObserved: 'The handover omitted the current runbook.',
    });
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getLibrary).mockResolvedValue([published]);
    vi.mocked(getLibraryLessonDetails).mockResolvedValue({ ...lessonDetails(published), history: [] });
    const user = userEvent.setup();

    renderScreen('local-contributor', 0, 'library');

    expect(await screen.findByRole('heading', { name: 'Lessons Library' })).toBeInTheDocument();
    await waitFor(() => expect(getLibrary).toHaveBeenCalledWith('local-contributor', { paged: 'true', cursor: undefined }));
    expect(screen.getByRole('link', { name: 'Lessons Library' })).toHaveAttribute('aria-current', 'page');
    const table = await screen.findByRole('table', { name: 'Published lessons, newest approval first' });
    const row = within(table).getByRole('row', { name: /Published release verification/ });
    expect(within(row).getByText('Approved')).toBeInTheDocument();
    expect(within(row).getAllByRole('cell', { name: '0' })).toHaveLength(2);
    await user.click(within(row).getByRole('link', { name: 'View Published release verification' }));

    const details = await screen.findByRole('dialog', { name: 'Published lesson details' });
    expect(window.location.search).toBe('?page=library&lesson=91');
    expect(getLibraryLessonDetails).toHaveBeenCalledWith('local-contributor', 91);
    await waitFor(() => expect(recordLibraryView).toHaveBeenCalledWith(
      'local-contributor', 91, { openingId: expect.stringMatching(/^[0-9a-f-]{36}$/i) },
    ));
    await waitFor(() => expect(within(screen.getByRole('row', { name: /Published release verification/ }))
      .getByRole('cell', { name: '1' })).toBeInTheDocument());
    expect(within(details).getByText('The handover omitted the current runbook.')).toBeInTheDocument();
    expect(within(details).queryByRole('heading', { name: 'History' })).not.toBeInTheDocument();
    await user.click(within(details).getByRole('button', { name: 'Back to Lessons Library' }));
    await waitFor(() => expect(window.location.search).toBe('?page=library'));
    expect(within(table).getByRole('link', { name: 'View Published release verification' })).toHaveFocus();
  });

  it('changes the Library order, starts from the first page, and keeps loaded order when details close', async () => {
    const newest = libraryLesson({
      id: 90,
      title: 'Newest published result',
      status: 'Approved',
      approvedAt: '2026-11-15T15:30:00.000Z',
    });
    const titleFirst = libraryLesson({
      id: 91,
      title: 'Alpha sorted result',
      status: 'Approved',
      approvedAt: '2026-11-14T15:30:00.000Z',
    });
    const titleSecond = libraryLesson({
      id: 92,
      title: 'Beta sorted result',
      status: 'Closed',
      approvedAt: '2026-11-13T15:30:00.000Z',
    });
    const page = (items: LibraryLesson[], nextCursor: string | null) => ({
      items,
      page: { limit: 1, nextCursor },
    });
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getLibrary).mockImplementation(async (_profileId, request) => {
      if (request?.sort === 'title') {
        return request.cursor ? page([titleSecond], null) : page([titleFirst], 'title-next');
      }
      return page([newest], null);
    });
    vi.mocked(getLibraryLessonDetails).mockResolvedValue({ ...lessonDetails(titleSecond), history: [] });
    const user = userEvent.setup();

    renderScreen('local-contributor', 0, 'library');

    expect(await screen.findByRole('row', { name: /Newest published result/ })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'title');
    await waitFor(() => expect(getLibrary).toHaveBeenLastCalledWith('local-contributor', {
      paged: 'true',
      cursor: undefined,
      sort: 'title',
    }));
    expect(await screen.findByRole('row', { name: /Alpha sorted result/ })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    const table = screen.getByRole('table', { name: 'Published lessons, title order' });
    const secondRow = await within(table).findByRole('row', { name: /Beta sorted result/ });
    await user.click(within(secondRow).getByRole('link', { name: 'View Beta sorted result' }));
    const details = await screen.findByRole('dialog', { name: 'Published lesson details' });
    await user.click(within(details).getByRole('button', { name: 'Close published lesson details' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Published lesson details' })).not.toBeInTheDocument());
    const visibleTitles = within(table).getAllByRole('row').slice(1).map((row) => row.textContent);
    expect(visibleTitles).toHaveLength(2);
    expect(visibleTitles[0]).toContain('Alpha sorted result');
    expect(visibleTitles[1]).toContain('Beta sorted result');
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveValue('title');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'newest');
    await waitFor(() => expect(getLibrary).toHaveBeenLastCalledWith('local-contributor', {
      paged: 'true',
      cursor: undefined,
    }));
    expect(await screen.findByRole('row', { name: /Newest published result/ })).toBeInTheDocument();
  });

  it('searches and filters the published Library while preserving loaded pages when details close', async () => {
    const first = libraryLesson({
      id: 91,
      title: 'Gestão de riscos',
      authorName: 'Local Contributor',
      status: 'Approved',
      approvedAt: '2026-11-14T15:30:00.000Z',
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
      lessonType: 'Communication',
      situationObserved: 'The team did not record its risk decision.',
    });
    const second = libraryLesson({
      id: 92,
      title: 'Older published handover',
      authorName: 'Other Contributor',
      status: 'Closed',
      approvedAt: '2026-11-13T15:30:00.000Z',
      situationObserved: 'The handover missed an owner.',
    });
    const page = (items: LibraryLesson[], nextCursor: string | null) => ({
      items,
      page: { limit: 1, nextCursor },
    });
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getLibraryProjectSnapshots).mockResolvedValue([
      { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' },
    ]);
    vi.mocked(getLibrary).mockImplementation(async (_profileId, request) => {
      if (request?.cursor) return page([second], null);
      if (request?.search === 'no-match') return page([], null);
      return page([first], request?.search ? null : 'next-cursor');
    });
    vi.mocked(getLibraryLessonDetails).mockResolvedValue({
      ...lessonDetails(second),
      authorName: 'Other Contributor',
      history: [],
    });
    const user = userEvent.setup();

    renderScreen('local-contributor', 0, 'library');

    const firstRow = await screen.findByRole('row', { name: /Gestão de riscos/ });
    expect(within(firstRow).getByText('Local Contributor')).toBeInTheDocument();
    expect(within(firstRow).getByText('The team did not record its risk decision.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    const secondRow = await screen.findByRole('row', { name: /Older published handover/ });
    await user.click(within(secondRow).getByRole('link', { name: 'View Older published handover' }));
    const details = await screen.findByRole('dialog', { name: 'Published lesson details' });
    expect(getLibraryLessonDetails).toHaveBeenCalledWith('local-contributor', 92);
    await user.click(within(details).getByRole('button', { name: 'Close published lesson details' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Published lesson details' })).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /Gestão de riscos/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Older published handover/ })).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search title or ID' }), 'gestao');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'without-project');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lesson type' }), 'Communication');
    await waitFor(() => expect(getLibrary).toHaveBeenLastCalledWith('local-contributor', expect.objectContaining({
      paged: 'true',
      cursor: undefined,
      search: 'gestao',
      withoutProject: true,
      lessonType: 'Communication',
    })));
    expect(screen.getByRole('status')).toHaveTextContent('Project: No project');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(getLibrary).toHaveBeenLastCalledWith('local-contributor', {
      paged: 'true',
      cursor: undefined,
    }));
    await user.type(screen.getByRole('searchbox', { name: 'Search title or ID' }), 'no-match');
    expect(await screen.findByText('No published lessons match these filters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create lesson' }));
    expect(await screen.findByRole('dialog', { name: 'Create lesson' })).toBeInTheDocument();
  });

  it('lets PMO approve the exact version shown in lesson details after explicit confirmation', async () => {
    const submitted = lessonDraft({
      id: 92,
      title: 'Approval review lesson',
      status: 'PMOEvaluation',
      version: 6,
    });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockResolvedValue([submitted]);
    vi.mocked(getLessonDetails).mockResolvedValue(lessonDetails(submitted));
    vi.mocked(approveLesson).mockResolvedValue(lessonDraft({
      ...submitted,
      status: 'Approved',
      version: 7,
      updatedBy: 'local-pmo',
      approvedAt: '2026-11-14T15:30:00.000Z',
    }));
    const user = userEvent.setup();

    renderScreen('local-pmo', 0, 'evaluation-queue');
    await screen.findByRole('heading', { name: 'Evaluation Queue' });
    await user.click(await screen.findByRole('button', { name: 'View Approval review lesson' }));
    const details = await screen.findByRole('dialog', { name: 'Lesson details' });
    await user.click(within(details).getByRole('button', { name: 'Approve and publish' }));

    const confirmation = await screen.findByRole('dialog', { name: 'Approve lesson' });
    expect(within(confirmation).getByText(/version 6 of “Approval review lesson”/)).toBeInTheDocument();
    await user.click(within(confirmation).getByRole('button', { name: 'Confirm approval' }));

    await waitFor(() => expect(approveLesson).toHaveBeenCalledWith('local-pmo', 92, { version: 6 }));
    expect(await screen.queryByRole('dialog', { name: 'Approve lesson' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Lesson details' })).not.toBeInTheDocument();
  });

  it('requires reloading current details after an approval version conflict', async () => {
    const submitted = lessonDraft({ id: 93, title: 'Changed approval lesson', status: 'PMOEvaluation', version: 2 });
    const latest = lessonDetails({ ...submitted, version: 3, title: 'Changed approval lesson, current version' });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockResolvedValue([submitted]);
    vi.mocked(getLessonDetails)
      .mockResolvedValueOnce(lessonDetails(submitted))
      .mockResolvedValueOnce(latest);
    vi.mocked(approveLesson).mockRejectedValue(apiError(409, 'STALE_LESSON_VERSION'));
    const user = userEvent.setup();

    renderScreen('local-pmo', 0, 'evaluation-queue');
    await screen.findByRole('heading', { name: 'Evaluation Queue' });
    await user.click(await screen.findByRole('button', { name: 'View Changed approval lesson' }));
    const details = await screen.findByRole('dialog', { name: 'Lesson details' });
    await user.click(within(details).getByRole('button', { name: 'Approve and publish' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Approve lesson' });
    await user.click(within(confirmation).getByRole('button', { name: 'Confirm approval' }));

    const alert = await within(confirmation).findByRole('alert');
    expect(alert).toHaveTextContent('Reload the current version before deciding again.');
    expect(within(confirmation).getByRole('button', { name: 'Confirm approval' })).toBeDisabled();
    await user.click(within(confirmation).getByRole('button', { name: 'Reload current version' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Approve lesson' })).not.toBeInTheDocument());
    expect(getLessonDetails).toHaveBeenCalledTimes(2);
    const refreshedDetails = await screen.findByRole('dialog', { name: 'Lesson details' });
    expect(within(refreshedDetails).getByText('Changed approval lesson, current version')).toBeInTheDocument();
    await user.click(within(refreshedDetails).getByRole('button', { name: 'Approve and publish' }));
    expect(await screen.findByText(/version 3 of “Changed approval lesson, current version”/)).toBeInTheDocument();
    expect(approveLesson).toHaveBeenCalledTimes(1);
  });

  it('shows an empty message when there are no lessons awaiting evaluation', async () => {
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockResolvedValue([]);

    renderScreen('local-pmo', 0, 'evaluation-queue');

    expect(await screen.findByText('No lessons are awaiting PMO evaluation.')).toBeInTheDocument();
  });

  it('highlights the latest PMO guidance on an Open returned submission and keeps it in history', async () => {
    const guidance = 'Please include the decision date and link the updated checklist.';
    const returnedLesson = lessonDraft({ id: 82, title: 'Returned release lesson', latestReviewGuidance: guidance });
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockResolvedValue([returnedLesson]);
    vi.mocked(getLessonDetails).mockResolvedValue({
      ...lessonDetails(returnedLesson),
      history: [
        { id: 1, actorId: 'local-contributor', eventType: 'Created', previousStatus: null, newStatus: 'Open', reason: null, occurredAt: returnedLesson.createdAt },
        { id: 2, actorId: 'local-contributor', eventType: 'Submitted', previousStatus: 'Open', newStatus: 'PMOEvaluation', reason: null, occurredAt: returnedLesson.updatedAt },
        { id: 3, actorId: 'local-pmo', eventType: 'Returned', previousStatus: 'PMOEvaluation', newStatus: 'Open', reason: guidance, occurredAt: returnedLesson.updatedAt },
      ],
    });
    const user = userEvent.setup();

    renderScreen('local-contributor', 0, 'my-submissions');

    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(await screen.findByText('Latest PMO guidance')).toBeInTheDocument();
    expect(screen.getByText(guidance)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View Returned release lesson' }));
    const details = await screen.findByRole('dialog', { name: 'Lesson details' });
    expect(within(details).getByText('Returned', { exact: true })).toBeInTheDocument();
    expect(within(details).getByText(`PMO guidance: ${guidance}`)).toBeInTheDocument();
  });

  it('shows an error and retry control when the evaluation queue cannot be loaded', async () => {
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockImplementation(async (_profileId, filters) => {
      if (filters === undefined) return [];
      throw apiError(503, 'SERVICE_UNAVAILABLE');
    });

    renderScreen('local-pmo', 0, 'evaluation-queue');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The evaluation queue could not be loaded.')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('combines evaluation queue search, project, and lesson type filters', async () => {
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockResolvedValue([]);
    const user = userEvent.setup();

    renderScreen('local-pmo', 0, 'evaluation-queue');
    await screen.findByRole('heading', { name: 'Evaluation Queue' });
    await user.type(screen.getByRole('searchbox', { name: 'Search title or ID' }), 'Operations');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'project:LOCAL-PROJECT-001');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lesson type' }), 'Communication');

    await waitFor(() => expect(getPmoEvaluationQueue).toHaveBeenCalledWith('local-pmo', {
      search: 'Operations',
      projectId: 'LOCAL-PROJECT-001',
      lessonType: 'Communication',
    }, { paged: 'true', cursor: undefined }));
    expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
  });

  it('appends an evaluation page and discards loaded pages after filtering', async () => {
    const first = lessonDraft({ id: 90, title: 'First evaluation', status: 'PMOEvaluation' });
    const second = lessonDraft({ id: 91, title: 'Second evaluation', status: 'PMOEvaluation' });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoEvaluationQueue).mockImplementation(async (_profile, filters, page) => {
      if (!page) return [first, second];
      if (filters.search) return { items: [second], page: { limit: 50, nextCursor: null } };
      return page.cursor
        ? { items: [second], page: { limit: 50, nextCursor: null } }
        : { items: [first], page: { limit: 50, nextCursor: 'next' } };
    });
    const user = userEvent.setup();
    renderScreen('local-pmo', 0, 'evaluation-queue');
    expect(await screen.findByRole('button', { name: 'View First evaluation' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: 'View Second evaluation' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'View First evaluation' })).toBeVisible();
    await user.type(screen.getByRole('searchbox', { name: 'Search title or ID' }), 'Second');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'View First evaluation' })).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'View Second evaluation' })).toBeVisible();
  });

  it('lets PMO edit a third-party Open draft without Submit and preserves edits after a stale-version conflict', async () => {
    const draft = lessonDraft({ id: 44, title: 'Author draft for PMO assistance' });
    let latest = draft;
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoDrafts).mockImplementation(async () => [latest]);
    vi.mocked(updateLessonDraft).mockRejectedValueOnce(apiError(409, 'STALE_LESSON_VERSION'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    renderScreen('local-pmo');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'PMO Drafts' }));
    await user.click(await screen.findByRole('button', { name: 'Edit Author draft for PMO assistance' }));

    const editor = screen.getByRole('dialog', { name: 'Edit lesson' });
    expect(within(editor).queryByRole('button', { name: 'Submit for PMO Review' })).not.toBeInTheDocument();
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'PMO changes stay in the form');
    await user.click(within(editor).getByRole('button', { name: 'Save Draft' }));
    expect(await within(editor).findByRole('alert')).toHaveTextContent('Your edits are still here');
    expect(title).toHaveValue('PMO changes stay in the form');
    expect(within(editor).getByRole('button', { name: 'Reload latest version' })).toBeInTheDocument();

    latest = lessonDraft({ id: draft.id, title: 'Author saved a newer version', version: draft.version + 1 });
    await user.click(within(editor).getByRole('button', { name: 'Reload latest version' }));
    expect(confirm).toHaveBeenCalledWith('Reloading the latest version will discard your unsaved changes. Continue?');
    await waitFor(() => expect(title).toHaveValue('Author saved a newer version'));
    expect(within(editor).queryByRole('button', { name: 'Submit for PMO Review' })).not.toBeInTheDocument();
  });

  it('asks before internal navigation closes a dirty editor and keeps its text when navigation is cancelled', async () => {
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoDrafts).mockResolvedValue([lessonDraft()]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen('local-pmo');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'PMO Drafts' }));
    await user.click(await screen.findByRole('button', { name: 'Edit Improve release handover' }));
    const editor = screen.getByRole('dialog', { name: 'Edit lesson' });
    const situation = within(editor).getByRole('textbox', { name: 'Situation observed' });
    await user.type(situation, 'Unsaved navigation draft');

    await user.click(screen.getByRole('link', { name: 'My Submissions' }));

    expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes?');
    expect(screen.getByRole('dialog', { name: 'Edit lesson' })).toBeInTheDocument();
    expect(situation).toHaveValue('Unsaved navigation draft');
    expect(screen.getByRole('heading', { name: 'PMO Drafts' })).toBeInTheDocument();
  });

  it('opens current detail and history after LESSON_NOT_OPEN without losing the editor text', async () => {
    const draft = lessonDraft({ id: 48, title: 'Concurrent lesson update' });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoDrafts).mockResolvedValue([draft]);
    vi.mocked(updateLessonDraft).mockRejectedValueOnce(apiError(409, 'LESSON_NOT_OPEN'));
    vi.mocked(getLessonDetails).mockResolvedValue(lessonDetails({
      ...draft,
      status: 'PMOEvaluation',
      version: 2,
      updatedBy: 'local-contributor',
      history: [
        { id: 1, actorId: 'local-contributor', eventType: 'Created', previousStatus: null, newStatus: 'Open', reason: null, occurredAt: draft.createdAt },
        { id: 2, actorId: 'local-contributor', eventType: 'Submitted', previousStatus: 'Open', newStatus: 'PMOEvaluation', reason: null, occurredAt: draft.updatedAt },
      ],
    }));
    const user = userEvent.setup();
    renderScreen('local-pmo');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'PMO Drafts' }));
    await user.click(await screen.findByRole('button', { name: `Edit ${draft.title}` }));
    const editor = screen.getByRole('dialog', { name: 'Edit lesson' });
    const title = within(editor).getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Unsaved title remains visible');
    await user.click(within(editor).getByRole('button', { name: 'Save Draft' }));

    expect(await within(editor).findByRole('alert')).toHaveTextContent('no longer Open');
    await user.click(within(editor).getByRole('button', { name: 'View current lesson details and history' }));
    const details = screen.getByRole('dialog', { name: 'Lesson details' });
    expect(await within(details).findByText('PMOEvaluation')).toBeInTheDocument();
    expect(within(details).getByText('Submitted')).toBeInTheDocument();
    expect(title).toHaveValue('Unsaved title remains visible');
    await user.click(within(details).getByRole('button', { name: 'Close details' }));
    expect(screen.getByRole('dialog', { name: 'Edit lesson' })).toBeInTheDocument();
    expect(title).toHaveValue('Unsaved title remains visible');
  });

  it('restores the Open status filter after switching profiles on PMO Drafts', async () => {
    const openDraft = lessonDraft({ id: 41, title: 'PMO open draft' });
    const closedDraft = lessonDraft({ id: 42, title: 'PMO closed lesson', status: 'Closed' });
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoDrafts).mockImplementation(async (_profileId, filters = {}) => (
      filters.status === 'Open' ? [openDraft] : [openDraft, closedDraft]
    ));
    const user = userEvent.setup();
    renderScreen('local-pmo');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'PMO Drafts' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), '');
    await screen.findByRole('row', { name: /PMO closed lesson/ });

    window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo-next');
    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key: 'pmo-hub.local-user-id',
      newValue: 'local-pmo-next',
    })));

    expect(await screen.findByRole('combobox', { name: 'Status' })).toHaveValue('Open');
    await waitFor(() => expect(getPmoDrafts).toHaveBeenCalledWith('local-pmo-next', { status: 'Open' }));
  });

  it('confirms PMO cancellation of a third-party Open draft and refreshes PMO Drafts', async () => {
    const openDraft = lessonDraft({ id: 45, title: 'Draft PMO is closing' });
    const archivedDraft = lessonDraft({ ...openDraft, status: 'Archived', updatedBy: 'local-pmo', version: 2 });
    let isCancelled = false;
    vi.mocked(getHome).mockResolvedValue(pmo);
    vi.mocked(getPmoDrafts).mockImplementation(async (_profileId, filters = {}) => (
      isCancelled && filters.status === 'Open' ? [] : [isCancelled ? archivedDraft : openDraft]
    ));
    vi.mocked(cancelLesson).mockImplementation(async () => {
      isCancelled = true;
      return { ...archivedDraft, updatedAt: new Date().toISOString() };
    });
    const user = userEvent.setup();

    renderScreen('local-pmo');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'PMO Drafts' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel Draft PMO is closing' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel lesson' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason for cancellation' }), 'The author approved closing it.');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));

    expect(cancelLesson).toHaveBeenCalledWith('local-pmo', openDraft.id, {
      version: openDraft.version,
      reason: 'The author approved closing it.',
    });
    expect(await screen.findByText('No lessons match these filters.')).toBeInTheDocument();
  });

  it('shows all own submission states, applies combined filters, and restores focus and filter state after details', async () => {
    const open = lessonDraft({ id: 10, title: 'Open release checklist' });
    const submitted = lessonDraft({ id: 11, title: 'Submitted release handover', status: 'PMOEvaluation', lessonType: 'Future Prevention' });
    const approved = lessonDraft({
      id: 12,
      title: 'Approved deployment lesson',
      status: 'Approved',
      projectId: 'REMOVED-PROJECT-001',
      projectName: 'Removed project snapshot',
    });
    const closed = lessonDraft({ id: 13, title: 'Closed migration lesson', status: 'Closed' });
    const archived = lessonDraft({
      id: 14,
      title: 'Archived cancelled lesson',
      status: 'Archived',
      updatedBy: 'local-contributor',
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      situationObserved: 'The release handover omitted its runbook.',
      rootCause: 'The checklist had no owner.',
      lessonType: 'Communication',
      impact: 'Operators repeated the checks.',
      recommendation: 'Assign a checklist owner.',
      applicability: 'Use for releases with an operations handover.',
    });
    const projectIdNone = lessonDraft({ id: 15, title: 'Project ID none lesson', projectId: 'none', projectName: 'Project None' });
    const rows = [open, submitted, approved, closed, archived, projectIdNone];
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockImplementation(async (_profileId, filters) => {
      if (filters?.status === 'Archived') return [archived];
      if (filters?.status === 'PMOEvaluation') return [submitted];
      return rows;
    });
    vi.mocked(getLessonDetails).mockImplementation(async (_profileId, lessonId) => lessonDetails(
      lessonId === archived.id
        ? {
            ...archived,
            history: [
              { id: 1, actorId: archived.authorId, eventType: 'Created', previousStatus: null, newStatus: 'Open', reason: null, occurredAt: archived.createdAt },
              { id: 2, actorId: archived.authorId, eventType: 'Cancelled', previousStatus: 'Open', newStatus: 'Archived', reason: 'The project scope changed.', occurredAt: archived.updatedAt },
            ],
          }
        : {
            ...submitted,
            history: [
              { id: 3, actorId: submitted.authorId, eventType: 'Created', previousStatus: null, newStatus: 'Open', reason: null, occurredAt: submitted.createdAt },
              { id: 4, actorId: submitted.authorId, eventType: 'Submitted', previousStatus: 'Open', newStatus: 'PMOEvaluation', reason: null, occurredAt: submitted.updatedAt },
            ],
          },
    ));
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));

    for (const row of rows) expect(await screen.findByText(`${row.status === 'Open' ? 'Draft' : 'Lesson'} #${row.id} · ${row.status}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Reopen ${open.title}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `View ${submitted.title}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Reopen ${submitted.title}` })).not.toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search title or ID' }), 'Archived');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'without-project');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lesson type' }), 'Communication');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Archived');
    await vi.waitFor(() => expect(getMySubmissions).toHaveBeenLastCalledWith('local-contributor', {
      search: 'Archived',
      withoutProject: true,
      lessonType: 'Communication',
      status: 'Archived',
    }));

    const projectFilter = screen.getByRole('combobox', { name: 'Project' });
    expect(within(projectFilter).getByRole('option', { name: 'Removed project snapshot' }))
      .toHaveValue('project:REMOVED-PROJECT-001');
    expect(within(projectFilter).getByRole('option', { name: 'Project None' })).toHaveValue('project:none');
    expect(within(projectFilter).getByRole('option', { name: 'No project' })).toHaveValue('without-project');

    const archivedView = await screen.findByRole('button', { name: `View ${archived.title}` });
    await user.click(archivedView);
    const details = screen.getByRole('dialog', { name: 'Lesson details' });
    expect(await within(details).findByText('Cancellation reason: The project scope changed.')).toBeInTheDocument();
    expect(within(details).getByText('Archived cancelled lesson')).toBeInTheDocument();
    expect(within(details).getByText('Technology')).toBeInTheDocument();
    expect(within(details).getByText('Execution')).toBeInTheDocument();
    expect(within(details).getByText('The release handover omitted its runbook.')).toBeInTheDocument();
    expect(within(details).getByText('The checklist had no owner.')).toBeInTheDocument();
    expect(within(details).getByText('Communication')).toBeInTheDocument();
    expect(within(details).getByText('Operators repeated the checks.')).toBeInTheDocument();
    expect(within(details).getByText('Assign a checklist owner.')).toBeInTheDocument();
    expect(within(details).getByText('Use for releases with an operations handover.')).toBeInTheDocument();
    expect(within(details).getByText('Last updated')).toBeInTheDocument();
    expect(within(details).getAllByText(/UTC$/).length).toBeGreaterThanOrEqual(4);
    expect(within(details).getAllByText('local-contributor').length).toBeGreaterThan(1);
    expect(within(details).getAllByText('Created').length).toBeGreaterThan(1);
    expect(within(details).getByText('Cancelled')).toBeInTheDocument();
    await user.click(within(details).getByRole('button', { name: 'Close details' }));
    expect(archivedView).toHaveFocus();
    expect(screen.getByRole('searchbox', { name: 'Search title or ID' })).toHaveValue('Archived');
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue('without-project');
    expect(screen.getByRole('combobox', { name: 'Lesson type' })).toHaveValue('Communication');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('Archived');

    await user.clear(screen.getByRole('searchbox', { name: 'Search title or ID' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), '');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lesson type' }), '');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'PMOEvaluation');
    const submittedView = await screen.findByRole('button', { name: `View ${submitted.title}` });
    await user.click(submittedView);
    const submittedDetails = screen.getByRole('dialog', { name: 'Lesson details' });
    expect(await within(submittedDetails).findByText('PMOEvaluation')).toBeInTheDocument();
    expect(within(submittedDetails).getByText('Submitted')).toBeInTheDocument();
  });

  it('clears My Submissions filters when switching to a profile without the selected historical project', async () => {
    const historicalSubmission = lessonDraft({
      title: 'Contributor A historical project lesson',
      projectId: 'LEGACY-PROJECT-A',
      projectName: 'Contributor A archived project',
    });
    const profileBSubmission = lessonDraft({
      id: 22,
      title: 'Contributor B current lesson',
      authorId: 'local-pmo',
      updatedBy: 'local-pmo',
    });
    vi.mocked(getHome).mockImplementation(async (profileId) => (
      profileId === 'local-pmo' ? pmo : contributor
    ));
    vi.mocked(getMySubmissions).mockImplementation(async (profileId, filters) => {
      if (profileId === 'local-pmo') return Object.keys(filters ?? {}).length ? [] : [profileBSubmission];
      return [historicalSubmission];
    });
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    expect(await screen.findByText(historicalSubmission.title)).toBeInTheDocument();

    const projectFilter = screen.getByRole('combobox', { name: 'Project' });
    const historicalProject = await within(projectFilter).findByRole('option', { name: 'Contributor A archived project' });
    expect(historicalProject).toHaveValue('project:LEGACY-PROJECT-A');
    await user.selectOptions(projectFilter, 'project:LEGACY-PROJECT-A');
    await user.type(screen.getByRole('searchbox', { name: 'Search title or ID' }), 'historical');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lesson type' }), 'Communication');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Open');
    await vi.waitFor(() => expect(getMySubmissions).toHaveBeenCalledWith('local-contributor', expect.objectContaining({
      projectId: 'LEGACY-PROJECT-A',
      search: 'historical',
      lessonType: 'Communication',
      status: 'Open',
    })));

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
      window.dispatchEvent(new StorageEvent('storage', { key: 'pmo-hub.local-user-id', newValue: 'local-pmo' }));
    });

    expect(await screen.findByRole('button', { name: 'Local PMO' })).toBeInTheDocument();
    expect(await screen.findByText(profileBSubmission.title)).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search title or ID' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Lesson type' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('');
    expect(within(screen.getByRole('combobox', { name: 'Project' })).queryByRole('option', {
      name: 'Contributor A archived project',
    })).not.toBeInTheDocument();
    expect(getMySubmissions).toHaveBeenCalledWith('local-pmo');
    expect(vi.mocked(getMySubmissions).mock.calls.filter(([profileId]) => profileId === 'local-pmo').every(([, filters]) => (
      filters?.projectId !== 'LEGACY-PROJECT-A'
    ))).toBe(true);
  });

  it('shows a retry for failed historical project options while keeping submissions usable', async () => {
    const ownSubmission = lessonDraft({
      title: 'Submission remains available without historical filters',
      projectId: 'LEGACY-PROJECT-A',
      projectName: 'Contributor A archived project',
    });
    let unfilteredCalls = 0;
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockImplementation(async (_profileId, filters) => {
      if (Object.keys(filters ?? {}).length) return [ownSubmission];
      unfilteredCalls += 1;
      if (unfilteredCalls === 2) throw new Error('Historical project options unavailable');
      return [ownSubmission];
    });
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));

    expect(await screen.findByText(ownSubmission.title)).toBeInTheDocument();
    expect(await screen.findByText('Past project filter options could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry project filters' })).toBeVisible();
    const projectFilter = screen.getByRole('combobox', { name: 'Project' });
    expect(await within(projectFilter).findByRole('option', { name: 'Fictional Atlas Modernization' })).toBeInTheDocument();

    await user.selectOptions(projectFilter, 'project:LOCAL-PROJECT-001');
    await vi.waitFor(() => expect(getMySubmissions).toHaveBeenCalledWith('local-contributor', {
      projectId: 'LOCAL-PROJECT-001',
    }));
    expect(screen.getByText(ownSubmission.title)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry project filters' }));
    await vi.waitFor(() => expect(getMySubmissions).toHaveBeenCalledTimes(4));
    expect(await within(projectFilter).findByRole('option', { name: 'Contributor A archived project' }))
      .toHaveValue('project:LEGACY-PROJECT-A');
  });

  it('requires an explicit reason before cancelling and keeps the Archived lesson in read-only submissions', async () => {
    const openDraft = lessonDraft({ title: 'Cancel the outdated rollout lesson' });
    const archivedDraft = lessonDraft({ title: openDraft.title, status: 'Archived', version: 2 });
    let isCancelled = false;
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockImplementation(async () => [isCancelled ? archivedDraft : openDraft]);
    vi.mocked(cancelLesson).mockImplementation(async () => {
      isCancelled = true;
      return archivedDraft;
    });
    vi.mocked(getLessonDetails).mockResolvedValue(lessonDetails({
      ...archivedDraft,
      history: [
        { id: 1, actorId: archivedDraft.authorId, eventType: 'Created', previousStatus: null, newStatus: 'Open', reason: null, occurredAt: archivedDraft.createdAt },
        { id: 2, actorId: archivedDraft.authorId, eventType: 'Cancelled', previousStatus: 'Open', newStatus: 'Archived', reason: 'The project scope changed.', occurredAt: archivedDraft.updatedAt },
      ],
    }));
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: `Cancel ${openDraft.title}` }));

    const dialog = screen.getByRole('dialog', { name: 'Cancel lesson' });
    const reason = within(dialog).getByRole('textbox', { name: 'Reason for cancellation' });
    expect(reason).toHaveAttribute('maxLength', '1000');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a reason for cancelling this lesson.');
    expect(cancelLesson).not.toHaveBeenCalled();

    await user.type(reason, 'The project scope changed.');
    expect(within(dialog).getByText('26/1,000 characters')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));

    expect(cancelLesson).toHaveBeenCalledWith('local-contributor', openDraft.id, {
      version: openDraft.version,
      reason: 'The project scope changed.',
    });
    const viewButton = await screen.findByRole('button', { name: `View ${archivedDraft.title}` });
    expect(screen.getByText(`Lesson #${archivedDraft.id} · Archived`)).toBeInTheDocument();
    await user.click(viewButton);

    const details = screen.getByRole('dialog', { name: 'Lesson details' });
    expect(await within(details).findByText('Archived')).toBeInTheDocument();
    expect(within(details).getByText('No project')).toBeInTheDocument();
    expect(within(details).getByRole('heading', { name: 'History' })).toBeInTheDocument();
    expect(within(details).getByText('Cancelled')).toBeInTheDocument();
    expect(within(details).getByText('Cancellation reason: The project scope changed.')).toBeInTheDocument();
    expect(within(details).queryByRole('button', { name: /^Cancel / })).not.toBeInTheDocument();
    expect(within(details).queryByRole('button', { name: /^Reopen / })).not.toBeInTheDocument();
    await user.click(within(details).getByRole('button', { name: 'Close details' }));
    expect(viewButton).toHaveFocus();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('');
  });

  it('does not show cached details when reopening after cancellation and a failed refetch', async () => {
    const openDraft = lessonDraft({ title: 'Refresh details after cancellation' });
    const archivedDraft = lessonDraft({ ...openDraft, status: 'Archived', version: 2 });
    let isCancelled = false;
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockImplementation(async () => [isCancelled ? archivedDraft : openDraft]);
    vi.mocked(cancelLesson).mockImplementation(async () => {
      isCancelled = true;
      return archivedDraft;
    });
    vi.mocked(getLessonDetails)
      .mockResolvedValueOnce(lessonDetails(openDraft))
      .mockRejectedValueOnce(new Error('The details service is unavailable.'));
    const user = userEvent.setup();

    renderScreen('local-contributor', 60_000);
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));

    await user.click(await screen.findByRole('button', { name: `View ${openDraft.title}` }));
    const firstDetails = screen.getByRole('dialog', { name: 'Lesson details' });
    expect(await within(firstDetails).findByText('Open', { exact: true })).toBeInTheDocument();
    await user.click(within(firstDetails).getByRole('button', { name: 'Close details' }));

    await user.click(await screen.findByRole('button', { name: `Cancel ${openDraft.title}` }));
    const cancelDialog = screen.getByRole('dialog', { name: 'Cancel lesson' });
    await user.type(within(cancelDialog).getByRole('textbox', { name: 'Reason for cancellation' }), 'No longer needed.');
    await user.click(within(cancelDialog).getByRole('button', { name: 'Confirm cancellation' }));
    await screen.findByRole('button', { name: `View ${archivedDraft.title}` });

    await user.click(screen.getByRole('button', { name: `View ${archivedDraft.title}` }));
    const refreshedDetails = screen.getByRole('dialog', { name: 'Lesson details' });
    expect(await within(refreshedDetails).findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(within(refreshedDetails).queryByText('Open', { exact: true })).not.toBeInTheDocument();
    expect(within(refreshedDetails).queryByRole('heading', { name: 'History' })).not.toBeInTheDocument();
  });

  it('keeps the cancellation reason and Open draft visible when the API fails', async () => {
    const openDraft = lessonDraft({ title: 'Preserve cancellation context' });
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockResolvedValue([openDraft]);
    vi.mocked(cancelLesson).mockRejectedValueOnce(new Error('Service unavailable'));
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: `Cancel ${openDraft.title}` }));

    const dialog = screen.getByRole('dialog', { name: 'Cancel lesson' });
    const reason = within(dialog).getByRole('textbox', { name: 'Reason for cancellation' });
    await user.type(reason, 'This work has been superseded.');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not be cancelled');
    expect(reason).toHaveValue('This work has been superseded.');
    expect(within(screen.getByRole('listitem')).getByText(`Draft #${openDraft.id} · Open`)).toBeInTheDocument();
    expect(screen.queryByText(`Lesson #${openDraft.id} · Archived`)).not.toBeInTheDocument();
  });

  it('reloads a stale Open draft before retrying cancellation and preserves its reason', async () => {
    const openDraft = lessonDraft({ title: 'Cancel after another edit' });
    const latestDraft = lessonDraft({ title: 'Updated cancellation context', version: openDraft.version + 1 });
    const archivedDraft = lessonDraft({ title: latestDraft.title, status: 'Archived', version: latestDraft.version + 1 });
    let isCancelled = false;
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockImplementation(async () => [isCancelled ? archivedDraft : openDraft]);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([latestDraft]);
    vi.mocked(cancelLesson)
      .mockRejectedValueOnce(apiError(409, 'STALE_LESSON_VERSION'))
      .mockImplementationOnce(async () => {
        isCancelled = true;
        return archivedDraft;
      });
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: `Cancel ${openDraft.title}` }));

    const dialog = screen.getByRole('dialog', { name: 'Cancel lesson' });
    const reason = within(dialog).getByRole('textbox', { name: 'Reason for cancellation' });
    await user.type(reason, 'This is still the intended reason.');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('changed after you opened it');
    expect(reason).toHaveValue('This is still the intended reason.');
    const reload = within(dialog).getByRole('button', { name: 'Reload current version' });
    await user.click(reload);

    expect(await within(dialog).findByText(/Review the current lesson and confirm cancellation again/)).toBeInTheDocument();
    expect(within(dialog).getByText(`Draft #${latestDraft.id} · Open`)).toBeInTheDocument();
    expect(reason).toHaveValue('This is still the intended reason.');
    expect(reason).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));

    expect(cancelLesson).toHaveBeenNthCalledWith(2, 'local-contributor', openDraft.id, {
      version: latestDraft.version,
      reason: 'This is still the intended reason.',
    });
    expect(await screen.findByText(`Lesson #${archivedDraft.id} · Archived`)).toBeInTheDocument();
  });

  it('stops cancellation when the draft is no longer Open after a version conflict', async () => {
    const openDraft = lessonDraft({ title: 'Do not cancel after a state change' });
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockResolvedValue([openDraft]);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    vi.mocked(cancelLesson).mockRejectedValueOnce(apiError(409, 'STALE_LESSON_VERSION'));
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: `Cancel ${openDraft.title}` }));

    const dialog = screen.getByRole('dialog', { name: 'Cancel lesson' });
    const reason = within(dialog).getByRole('textbox', { name: 'Reason for cancellation' });
    await user.type(reason, 'This reason should not be lost.');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));
    await user.click(within(dialog).getByRole('button', { name: 'Reload current version' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no longer Open and cannot be cancelled');
    expect(reason).toHaveValue('This reason should not be lost.');
    expect(reason).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Confirm cancellation' })).toBeDisabled();
    expect(cancelLesson).toHaveBeenCalledOnce();
  });

  it('confirms discarding a cancellation reason and restores focus to the opener', async () => {
    const openDraft = lessonDraft({ title: 'Confirm before discarding the reason' });
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockResolvedValue([openDraft]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    const opener = await screen.findByRole('button', { name: `Cancel ${openDraft.title}` });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Cancel lesson' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason for cancellation' }), 'Keep this reason unless confirmed.');

    await user.keyboard('{Escape}');
    expect(confirm).toHaveBeenCalledWith('Discard your cancellation reason?');
    expect(screen.getByRole('dialog', { name: 'Cancel lesson' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Keep draft' }));
    expect(screen.getByRole('dialog', { name: 'Cancel lesson' })).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.click(within(dialog).getByRole('button', { name: 'Close cancellation' }));
    expect(screen.queryByRole('dialog', { name: 'Cancel lesson' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('creates a title-only draft and keeps the entered title when saving fails', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    vi.mocked(createLessonDraft).mockRejectedValueOnce(new Error('Save failed'));
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await screen.findByRole('heading', { name: 'My Submissions' });
    await user.click(screen.getByRole('button', { name: 'Create lesson' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Improve release handover');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Improve release handover');
    expect(screen.queryByRole('status', { name: /saved/i })).not.toBeInTheDocument();
  });

  it('saves a title-only Open draft for the selected profile', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    vi.mocked(createLessonDraft).mockResolvedValue(lessonDraft());
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await screen.findByRole('heading', { name: 'My Submissions' });
    await user.click(screen.getByRole('button', { name: 'Create lesson' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Improve release handover');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Draft saved');
    expect(createLessonDraft).toHaveBeenCalledWith('local-contributor', {
      title: 'Improve release handover',
      projectId: null,
      projectName: null,
      projectCategory: null,
      projectPhase: null,
      situationObserved: null,
      rootCause: null,
      lessonType: null,
      impact: null,
      recommendation: null,
      applicability: null,
    });
  });

  it('keeps title-only Create available while project options are pending or unavailable', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    vi.mocked(createLessonDraft).mockResolvedValue(lessonDraft({ id: 23, title: 'Title-only while offline' }));
    let rejectProjects!: (error: Error) => void;
    vi.mocked(getLessonProjects).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectProjects = reject;
    }));
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: 'Create lesson' }));

    const dialog = screen.getByRole('dialog', { name: 'Create lesson' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Loading project options');
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Title-only while offline');
    await act(async () => { rejectProjects(new Error('Catalog unavailable')); });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Project options could not be loaded');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Project' })).toHaveValue('');

    await user.click(within(dialog).getByRole('button', { name: 'Retry project options' }));
    await vi.waitFor(() => expect(getLessonProjects).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Title-only while offline');
    await vi.waitFor(() => expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(await screen.findByText('Draft #23 · Open')).toBeInTheDocument();
    expect(createLessonDraft).toHaveBeenCalledWith('local-contributor', expect.objectContaining({
      title: 'Title-only while offline',
      projectId: null,
      projectName: null,
    }));
  });

  it('keeps an edit form available when project options cannot be loaded', async () => {
    const savedProjectDraft = lessonDraft({
      projectId: 'LEGACY-PROJECT-001',
      projectName: 'Removed fictional project',
    });
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([savedProjectDraft]);
    vi.mocked(getLessonProjects).mockRejectedValueOnce(new Error('Catalog unavailable'));
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: 'Reopen Improve release handover' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit lesson' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Project options could not be loaded');
    expect(within(dialog).getByRole('combobox', { name: 'Project' })).toHaveValue(JSON.stringify([
      'LEGACY-PROJECT-001', 'Removed fictional project',
    ]));
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(updateLessonDraft).toHaveBeenCalledWith('local-contributor', 7, expect.objectContaining({
      projectId: 'LEGACY-PROJECT-001',
      projectName: 'Removed fictional project',
    }));
  });

  it('creates a complete draft in the accessible editor using the selected project snapshot', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    vi.mocked(createLessonDraft).mockResolvedValue(lessonDraft({
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
      projectCategory: 'Technology',
      situationObserved: 'The current handover was missing the runbook.',
    }));
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(screen.getByRole('button', { name: 'Create lesson' }));
    await screen.findByRole('dialog', { name: 'Create lesson' });
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Complete project lesson');
    await user.selectOptions(within(screen.getByRole('dialog', { name: 'Create lesson' })).getByRole('combobox', { name: 'Project' }),
      JSON.stringify(['LOCAL-PROJECT-001', 'Fictional Atlas Modernization']));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project category' }), 'Technology');
    await user.type(screen.getByRole('textbox', { name: 'Situation observed' }),
      'The current handover was missing the runbook.');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(createLessonDraft).toHaveBeenCalledWith('local-contributor', {
      title: 'Complete project lesson',
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
      projectCategory: 'Technology',
      projectPhase: null,
      situationObserved: 'The current handover was missing the runbook.',
      rootCause: null,
      lessonType: null,
      impact: null,
      recommendation: null,
      applicability: null,
    });
  });

  it('updates the selected Open draft with its last-read version', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([lessonDraft({ version: 4 })]);
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: 'Reopen Improve release handover' }));
    await user.type(screen.getByRole('textbox', { name: 'Situation observed' }), 'The release note was missing.');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project phase' }), 'Execution');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(updateLessonDraft).toHaveBeenCalledWith('local-contributor', 7, expect.objectContaining({
      version: 4,
      title: 'Improve release handover',
      projectPhase: 'Execution',
      situationObserved: 'The release note was missing.',
    } satisfies Partial<UpdateLessonDraftBody>));
  });

  it('prevents duplicate submits and form changes while a save is pending', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    let resolveCreate!: (draft: LessonDraft) => void;
    vi.mocked(createLessonDraft).mockImplementation(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await screen.findByRole('heading', { name: 'My Submissions' });
    await user.click(screen.getByRole('button', { name: 'Create lesson' }));
    const titleInput = screen.getByRole('textbox', { name: 'Title' });
    await user.type(titleInput, 'First draft title');
    const form = titleInput.closest('form');
    expect(form).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(titleInput).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create lesson' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    fireEvent.submit(form!);
    expect(createLessonDraft).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate(lessonDraft({ title: 'First draft title' }));
    });

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('First draft title');
    expect(screen.getByRole('heading', { name: 'Edit lesson' })).toBeInTheDocument();
    expect(createLessonDraft).toHaveBeenCalledTimes(1);
  });

  it('clears the previous profile draft UI when storage or pageshow selects another profile', async () => {
    const contributorDraft = lessonDraft({ title: 'Contributor private draft' });
    const pmoDraft = lessonDraft({ id: 9, title: 'PMO private draft', authorId: 'local-pmo', updatedBy: 'local-pmo' });
    vi.mocked(getHome).mockImplementation((profileId) => Promise.resolve(
      profileId === 'local-pmo' ? pmo : contributor,
    ));
    vi.mocked(getMyOpenDrafts).mockImplementation((profileId) => Promise.resolve(
      profileId === 'local-pmo' ? [pmoDraft] : [contributorDraft],
    ));
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: 'Reopen Contributor private draft' }));
    expect(screen.getByRole('dialog', { name: 'Edit lesson' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Contributor private draft');

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'pmo-hub.local-user-id',
        newValue: 'local-pmo',
      }));
    });

    expect(await screen.findByRole('button', { name: 'Local PMO' })).toBeInTheDocument();
    expect(await screen.findByText('PMO private draft')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Edit lesson' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create lesson' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Unsaved PMO title');
    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
      window.dispatchEvent(new PageTransitionEvent('pageshow'));
    });

    expect(await screen.findByRole('button', { name: 'Local Contributor' })).toBeInTheDocument();
    expect(await screen.findByText('Contributor private draft')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
    expect(screen.queryByText('Unsaved PMO title')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Edit lesson' })).not.toBeInTheDocument();
  });

  it('keeps a newly selected profile’s form unchanged when the previous profile save completes', async () => {
    vi.mocked(getHome).mockImplementation((profileId) => Promise.resolve(
      profileId === 'local-pmo' ? pmo : contributor,
    ));
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    let resolveCreate!: (draft: LessonDraft) => void;
    vi.mocked(createLessonDraft).mockImplementation((profileId) => {
      if (profileId === 'local-contributor') return new Promise((resolve) => {
        resolveCreate = resolve;
      });
      return Promise.resolve(lessonDraft({
        id: 9,
        title: 'New PMO title',
        authorId: 'local-pmo',
        updatedBy: 'local-pmo',
      }));
    });
    window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
    window.history.replaceState(null, '', '/lessons-learned/');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient}>
        <LessonsLearnedScreen />
      </QueryClientProvider>,
    );
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await screen.findByRole('heading', { name: 'My Submissions' });
    await user.click(screen.getByRole('button', { name: 'Create lesson' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Pending contributor title');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'pmo-hub.local-user-id',
        newValue: 'local-pmo',
      }));
    });
    expect(await screen.findByRole('button', { name: 'Local PMO' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create lesson' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'New PMO title');

    await act(async () => {
      resolveCreate(lessonDraft({ title: 'Pending contributor title' }));
    });

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('New PMO title');
    expect(screen.getByRole('heading', { name: 'Create lesson' })).toBeInTheDocument();
    expect(screen.queryByText('Draft saved.')).not.toBeInTheDocument();
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['lessons-learned-my-submissions', 'local-contributor'],
    });
  });

  it('shows the selected identity while the API checks access without showing Home data', () => {
    vi.mocked(getHome).mockReturnValue(new Promise(() => undefined));

    renderScreen('local-contributor');

    expect(screen.getByRole('heading', { name: 'Access check' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('local-contributor');
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(getHome).toHaveBeenCalledWith('local-contributor');
  });

  it('opens Home for Contributor only after API authorization', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);

    renderScreen('local-contributor');

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('Welcome, Local Contributor')).toBeInTheDocument();
    expect(screen.getByText('Contributor', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Lessons Learned navigation' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Lessons Learned' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Back to PMO Hub' })).toHaveAttribute('href', '/');
  });

  it('opens the module menu with the keyboard and closes it after choosing Home', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    const user = userEvent.setup();

    renderScreen('local-contributor');

    const menuButton = await screen.findByRole('button', { name: 'Module menu' });
    const navigation = screen.getByRole('navigation', { name: 'Lessons Learned' });
    const homeLink = screen.getByRole('link', { name: 'Home' });

    expect(menuButton).toHaveAttribute('aria-controls', 'module-navigation');
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(homeLink).toHaveAttribute('href', '/lessons-learned/');
    expect(navigation).toHaveAttribute('id', 'module-navigation');

    menuButton.focus();
    await user.keyboard('{Enter}');
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Enter}');
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    await user.click(menuButton);
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    homeLink.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await user.click(homeLink);

    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
  });

  it('switches the shared header theme from the keyboard and keeps the choice in this session', async () => {
    vi.mocked(getHome).mockResolvedValue(contributor);
    const user = userEvent.setup();
    const view = renderScreen('local-contributor');

    await screen.findByRole('navigation', { name: 'Lessons Learned' });
    const profileTrigger = screen.getByRole('button', { name: 'Local Contributor' });
    await user.click(profileTrigger);
    const lightTheme = screen.getByRole('button', { name: 'Light' });
    const darkTheme = screen.getByRole('button', { name: 'Dark' });
    expect(lightTheme).toHaveAttribute('aria-pressed', 'true');
    expect(darkTheme).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('group', { name: 'Color theme' })).toBeInTheDocument();
    expect(document.querySelector('.module-sidebar .theme-controls')).toBeNull();

    await user.tab();
    await user.tab();
    expect(darkTheme).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(darkTheme).toHaveAttribute('aria-pressed', 'true');
    expect(lightTheme).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.sessionStorage.getItem('pmo-hub.theme')).toBe('dark');

    view.unmount();
    renderScreen('local-contributor');
    await screen.findByRole('navigation', { name: 'Lessons Learned' });
    await user.click(screen.getByRole('button', { name: 'Local Contributor' }));
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the PMO role returned by the API', async () => {
    vi.mocked(getHome).mockResolvedValue(pmo);

    renderScreen('local-pmo');

    expect(await screen.findByText('Welcome, Local PMO')).toBeInTheDocument();
    expect(screen.getByText('PMO', { selector: 'strong' })).toBeInTheDocument();
  });

  it('denies a profile without access and recommends contacting the PMO', async () => {
    vi.mocked(getHome).mockRejectedValue(apiError(403, 'ACCESS_DENIED'));

    renderScreen('local-no-access');

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'local-no-access' })).toBeInTheDocument();
    expect(screen.getByText(/Contact the PMO/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
  });

  it('shows a configuration error for a duplicate or invalid module profile', async () => {
    vi.mocked(getHome).mockRejectedValue(apiError(500, 'ACCESS_CONFIGURATION_ERROR'));

    renderScreen('local-pmo');

    expect(await screen.findByRole('heading', { name: 'Access configuration error' })).toBeInTheDocument();
    expect(screen.getByText(/Contact the responsible team/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('retries a temporary access-check failure and opens Home after recovery', async () => {
    vi.mocked(getHome)
      .mockRejectedValueOnce(new Error('API unavailable'))
      .mockResolvedValueOnce(contributor);

    renderScreen('local-contributor');

    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(getHome).toHaveBeenCalledTimes(2);
  });

  it('offers Retry when the browser goes offline before checking access', async () => {
    onlineManager.setOnline(false);
    vi.mocked(getHome).mockRejectedValueOnce(new Error('Network unavailable'));

    renderScreen('local-contributor');

    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Home' })).not.toBeInTheDocument();
  });

  it('revalidates Home when the tab regains focus and hides data after access is revoked', async () => {
    vi.mocked(getHome)
      .mockResolvedValueOnce(contributor)
      .mockRejectedValueOnce(apiError(403, 'ACCESS_DENIED'));

    renderScreen('local-contributor');
    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: 'Create lesson' }));
    expect(screen.getByRole('dialog', { name: 'Create lesson' })).toBeInTheDocument();

    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      window.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Create lesson' })).not.toBeInTheDocument();
    expect(getHome).toHaveBeenCalledTimes(2);
  });

  it('keeps a draft editor mounted while a focus recheck is pending or temporarily unavailable', async () => {
    let rejectRecheck!: (error: Error) => void;
    vi.mocked(getHome)
      .mockResolvedValueOnce(contributor)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRecheck = reject; }))
      .mockResolvedValueOnce(contributor);
    vi.mocked(createLessonDraft).mockResolvedValue(lessonDraft({ id: 19, title: 'Saved draft' }));
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByRole('heading', { name: 'Home' });
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: 'Create lesson' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.type(title, 'Saved draft');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(await screen.findByText('Draft #19 · Open')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Situation observed' }), 'Unsaved editor text');

    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.waitFor(() => expect(getHome).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('dialog', { name: 'Edit lesson' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Situation observed' })).toHaveValue('Unsaved editor text');
    await act(async () => { rejectRecheck(new Error('API unavailable')); });

    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(screen.getByRole('dialog', { name: 'Edit lesson' })).toBeInTheDocument();
    expect(screen.getByText('Draft #19 · Open')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Situation observed' })).toHaveValue('Unsaved editor text');
    const dialog = screen.getByRole('dialog', { name: 'Edit lesson' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Access check temporarily unavailable' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('#page-title')).toHaveLength(1);
    expect(within(dialog).getByRole('alert', { name: 'Home access check temporarily unavailable' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Retry access check' }));
    expect(getHome).toHaveBeenCalledTimes(3);
  });

  it('does not keep the previous profile Home visible while a changed profile is checked', async () => {
    let resolvePmo!: (value: typeof pmo) => void;
    let resolveContributorAgain!: (value: typeof contributor) => void;
    let contributorRequests = 0;
    vi.mocked(getHome).mockImplementation((localUserId) => {
      if (localUserId === 'local-contributor') {
        contributorRequests += 1;
        if (contributorRequests === 1) return Promise.resolve(contributor);
        return new Promise((resolve) => { resolveContributorAgain = resolve; });
      }
      return new Promise((resolve) => { resolvePmo = resolve; });
    });

    renderScreen('local-contributor');
    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'pmo-hub.local-user-id',
        newValue: 'local-pmo',
      }));
    });

    expect(await screen.findByRole('status')).toHaveTextContent('local-pmo');
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
    resolvePmo(pmo);
    expect(await screen.findByText('Welcome, Local PMO')).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'pmo-hub.local-user-id',
        newValue: 'local-contributor',
      }));
    });

    expect(await screen.findByRole('status')).toHaveTextContent('local-contributor');
    expect(screen.queryByText('Welcome, Local PMO')).not.toBeInTheDocument();
    resolveContributorAgain(contributor);
    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();
  });

  it('rechecks a cached profile before showing its Home or submissions', async () => {
    let resolveContributorAgain!: (value: typeof contributor) => void;
    vi.mocked(getHome).mockImplementation((localUserId) => {
      if (localUserId === 'local-pmo') return Promise.resolve(pmo);
      if (vi.mocked(getHome).mock.calls.filter(([id]) => id === 'local-contributor').length === 1) {
        return Promise.resolve(contributor);
      }
      return new Promise((resolve) => { resolveContributorAgain = resolve; });
    });
    vi.mocked(getMyOpenDrafts).mockImplementation(async (localUserId) => (
      localUserId === 'local-contributor'
        ? [lessonDraft({ title: 'Private contributor draft' })]
        : []
    ));

    renderScreen('local-contributor', 60_000);
    expect(await screen.findByText('Welcome, Local Contributor')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await screen.findByRole('heading', { name: 'My Submissions' });
    expect(await screen.findByText('Private contributor draft')).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
      window.dispatchEvent(new StorageEvent('storage', { key: 'pmo-hub.local-user-id', newValue: 'local-pmo' }));
    });
    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(getMyOpenDrafts).toHaveBeenCalledTimes(4);

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
      window.dispatchEvent(new StorageEvent('storage', { key: 'pmo-hub.local-user-id', newValue: 'local-contributor' }));
    });

    expect(await screen.findByRole('status')).toHaveTextContent('local-contributor');
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'My Submissions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create lesson' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Lessons Learned' })).not.toBeInTheDocument();
    expect(screen.queryByText('Private contributor draft')).not.toBeInTheDocument();
    expect(getMyOpenDrafts).toHaveBeenCalledTimes(4);
    expect(vi.mocked(getMyOpenDrafts).mock.calls.map(([profileId]) => profileId)).toEqual([
      'local-contributor',
      'local-contributor',
      'local-pmo',
      'local-pmo',
    ]);
    expect(vi.mocked(getHome).mock.calls.map(([profileId]) => profileId)).toEqual([
      'local-contributor',
      'local-pmo',
      'local-contributor',
    ]);

    await act(async () => { resolveContributorAgain(contributor); });
    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create lesson' })).toBeVisible();
    expect(screen.getByText('Private contributor draft')).toBeInTheDocument();
    expect(getMyOpenDrafts).toHaveBeenCalledTimes(6);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.querySelectorAll('#page-title')).toHaveLength(1);
  });

  it('does not authorize a reselection from an older pending Home check', async () => {
    let resolveStaleContributor!: (value: typeof contributor) => void;
    let resolveFreshContributor!: (value: typeof contributor) => void;
    let contributorRequests = 0;
    vi.mocked(getHome).mockImplementation((localUserId) => {
      if (localUserId === 'local-pmo') return Promise.resolve(pmo);
      contributorRequests += 1;
      if (contributorRequests === 1) return Promise.resolve(contributor);
      if (contributorRequests === 2) {
        return new Promise((resolve) => { resolveStaleContributor = resolve; });
      }
      return new Promise((resolve) => { resolveFreshContributor = resolve; });
    });
    vi.mocked(getMyOpenDrafts).mockImplementation(async (localUserId) => (
      localUserId === 'local-contributor'
        ? [lessonDraft({ title: 'Private contributor draft' })]
        : []
    ));
    const user = userEvent.setup();

    renderScreen('local-contributor', 60_000);
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    expect(await screen.findByText('Private contributor draft')).toBeInTheDocument();

    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.waitFor(() => expect(getHome).toHaveBeenCalledTimes(2));
    expect(getHome).toHaveBeenNthCalledWith(2, 'local-contributor');

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-pmo');
      window.dispatchEvent(new StorageEvent('storage', { key: 'pmo-hub.local-user-id', newValue: 'local-pmo' }));
    });
    expect(await screen.findByRole('button', { name: 'Local PMO' })).toBeInTheDocument();
    expect(screen.queryByText('Private contributor draft')).not.toBeInTheDocument();

    act(() => {
      window.localStorage.setItem('pmo-hub.local-user-id', 'local-contributor');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'pmo-hub.local-user-id',
        newValue: 'local-contributor',
      }));
    });

    expect(await screen.findByRole('status')).toHaveTextContent('local-contributor');
    await vi.waitFor(() => expect(getHome).toHaveBeenCalledTimes(4));
    expect(vi.mocked(getHome).mock.calls.map(([profileId]) => profileId)).toEqual([
      'local-contributor',
      'local-contributor',
      'local-pmo',
      'local-contributor',
    ]);
    expect(screen.queryByRole('heading', { name: 'Home' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'My Submissions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create lesson' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Lessons Learned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Private contributor draft')).not.toBeInTheDocument();

    await act(async () => { resolveStaleContributor(contributor); });

    expect(screen.getByRole('status')).toHaveTextContent('local-contributor');
    expect(screen.queryByRole('heading', { name: 'Home' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'My Submissions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create lesson' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Lessons Learned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Private contributor draft')).not.toBeInTheDocument();

    await act(async () => { resolveFreshContributor(contributor); });

    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create lesson' })).toBeVisible();
    expect(screen.getByText('Private contributor draft')).toBeInTheDocument();
  });

  it('hides cached private data after authentication is required on a background recheck', async () => {
    vi.mocked(getHome)
      .mockResolvedValueOnce(contributor)
      .mockRejectedValueOnce(apiError(401, 'AUTHENTICATION_REQUIRED'))
      .mockResolvedValueOnce(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByText('Welcome, Local Contributor');
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: 'Create lesson' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Private unsaved title');

    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      window.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByRole('heading', { name: 'Authentication required' })).toBeInTheDocument();
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Create lesson' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Select a local profile' })).toHaveAttribute('href', '/');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Create lesson' })).not.toBeInTheDocument();
    expect(getHome).toHaveBeenCalledTimes(3);
  });

  it('keeps revoked profile data hidden after a transient retry failure until Home succeeds', async () => {
    vi.mocked(getHome)
      .mockResolvedValueOnce(contributor)
      .mockRejectedValueOnce(apiError(401, 'AUTHENTICATION_REQUIRED'))
      .mockRejectedValueOnce(apiError(502, 'SERVICE_UNAVAILABLE'))
      .mockResolvedValueOnce(contributor);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
    const user = userEvent.setup();

    renderScreen('local-contributor');
    await screen.findByText('Welcome, Local Contributor');
    await user.click(screen.getByRole('link', { name: 'My Submissions' }));
    await user.click(await screen.findByRole('button', { name: 'Create lesson' }));
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Private unsaved title');

    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      window.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByRole('heading', { name: 'Authentication required' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Create lesson' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Access check temporarily unavailable' })).toBeInTheDocument();
    expect(screen.queryByText('Welcome, Local Contributor')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Lessons Learned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'My Submissions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create lesson' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create lesson' })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(getHome).toHaveBeenCalledTimes(4);
  });
});
