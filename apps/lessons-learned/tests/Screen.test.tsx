import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonsLearnedScreen } from '../src/LessonsLearnedScreen';
import {
  cancelLesson,
  createLessonDraft,
  getHome,
  getLessonProjects,
  getMyOpenDrafts,
  getMySubmissions,
  updateLessonDraft,
  type LessonDraft,
  type UpdateLessonDraftBody,
} from '../src/api';

vi.mock('../src/api', () => ({
  cancelLesson: vi.fn(),
  createLessonDraft: vi.fn(),
  getHome: vi.fn(),
  getLessonProjects: vi.fn(),
  getMyOpenDrafts: vi.fn(),
  getMySubmissions: vi.fn(),
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
    createdAt: '2026-11-13T12:00:00.000Z',
    updatedAt: '2026-11-13T12:00:00.000Z',
    ...overrides,
  };
}

function renderScreen(localUserId?: string, gcTime = 0) {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/lessons-learned/');
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
  return Object.assign(new Error('Request failed'), { response: { status, data: { code } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLessonProjects).mockResolvedValue([
    { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' },
  ]);
  vi.mocked(getMyOpenDrafts).mockResolvedValue([]);
  vi.mocked(getMySubmissions).mockImplementation((profileId) => getMyOpenDrafts(profileId));
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

  it('requires an explicit reason before cancelling and keeps the Archived lesson in read-only submissions', async () => {
    const openDraft = lessonDraft({ title: 'Cancel the outdated rollout lesson' });
    const archivedDraft = lessonDraft({ title: openDraft.title, status: 'Archived', version: 2 });
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockResolvedValueOnce([openDraft]).mockResolvedValueOnce([archivedDraft]);
    vi.mocked(cancelLesson).mockResolvedValue(archivedDraft);
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
    expect(within(details).getByText('Archived')).toBeInTheDocument();
    expect(within(details).getByText('No project')).toBeInTheDocument();
    expect(within(details).queryByRole('button', { name: /^Cancel / })).not.toBeInTheDocument();
    expect(within(details).queryByRole('button', { name: /^Reopen / })).not.toBeInTheDocument();
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
    vi.mocked(getHome).mockResolvedValue(contributor);
    vi.mocked(getMySubmissions).mockResolvedValueOnce([openDraft]).mockResolvedValueOnce([archivedDraft]);
    vi.mocked(getMyOpenDrafts).mockResolvedValue([latestDraft]);
    vi.mocked(cancelLesson)
      .mockRejectedValueOnce(apiError(409, 'STALE_LESSON_VERSION'))
      .mockResolvedValueOnce(archivedDraft);
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
    await user.click(within(dialog).getByRole('button', { name: 'Confirm cancellation' }));

    expect(cancelLesson).toHaveBeenNthCalledWith(2, 'local-contributor', openDraft.id, {
      version: latestDraft.version,
      reason: 'This is still the intended reason.',
    });
    expect(await screen.findByText(`Lesson #${archivedDraft.id} · Archived`)).toBeInTheDocument();
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
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue('');

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
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(JSON.stringify([
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
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }),
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
    expect(getMyOpenDrafts).toHaveBeenCalledTimes(2);

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
    expect(getMyOpenDrafts).toHaveBeenCalledTimes(2);
    expect(getMyOpenDrafts).toHaveBeenNthCalledWith(1, 'local-contributor');
    expect(getMyOpenDrafts).toHaveBeenNthCalledWith(2, 'local-pmo');
    expect(vi.mocked(getHome).mock.calls.map(([profileId]) => profileId)).toEqual([
      'local-contributor',
      'local-pmo',
      'local-contributor',
    ]);

    await act(async () => { resolveContributorAgain(contributor); });
    expect(await screen.findByRole('heading', { name: 'My Submissions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create lesson' })).toBeVisible();
    expect(screen.getByText('Private contributor draft')).toBeInTheDocument();
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
