import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { LessonDraft, LessonProject, UpdateLessonDraftBody } from '../src/api';
import { DraftEditor } from '../src/DraftEditor';

const draft: LessonDraft = {
  id: 7,
  title: 'Improve release handover',
  authorId: 'local-contributor',
  updatedBy: 'local-contributor',
  status: 'Open',
  version: 3,
  projectId: 'LOCAL-PROJECT-001',
  projectName: 'Fictional Atlas Modernization',
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
};

const projects: LessonProject[] = [
  { id: 'LOCAL-PROJECT-002', name: 'Fictional Harbor Migration' },
];

function renderEditor(overrides: Partial<{
  draft: LessonDraft | null;
  projects: LessonProject[];
  onSave: (input: UpdateLessonDraftBody, draftId: number | null) => Promise<LessonDraft>;
  onSubmit: (input: UpdateLessonDraftBody, draftId: number) => Promise<LessonDraft>;
  onReload: (draftId: number) => Promise<LessonDraft>;
  onClose: () => void;
}> = {}) {
  const startingDraft = Object.hasOwn(overrides, 'draft') ? overrides.draft ?? null : draft;
  const props = {
    draft: startingDraft,
    projects,
    onClose: vi.fn(),
    onSave: vi.fn(async (input: UpdateLessonDraftBody, draftId: number | null) => ({
      ...(startingDraft ?? draft),
      ...input,
      id: draftId ?? 8,
      updatedBy: (startingDraft ?? draft).authorId,
      version: input.version + 1,
      updatedAt: '2026-11-13T12:05:00.000Z',
    } as LessonDraft)),
    onSubmit: vi.fn(async (input: UpdateLessonDraftBody, draftId: number) => ({
      ...(startingDraft ?? draft),
      ...input,
      id: draftId,
      status: 'PMOEvaluation',
      updatedBy: (startingDraft ?? draft).authorId,
      version: input.version + 1,
      updatedAt: '2026-11-13T12:05:00.000Z',
    } as LessonDraft)),
    onReload: vi.fn(async (draftId: number) => ({ ...(startingDraft ?? draft), id: draftId, version: (startingDraft ?? draft).version + 1 })),
    ...overrides,
  };
  const view = render(<DraftEditor {...props} />);
  return { ...view, props };
}

function apiError(status: number, code: string) {
  return Object.assign(new Error('Request failed'), { response: { status, data: { code } } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Lessons Learned draft editor', () => {
  it('renders the draft fields, text counters, and a saved project snapshot missing from the catalog', () => {
    renderEditor();

    expect(screen.getByRole('dialog', { name: 'Edit lesson' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Improve release handover');
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(JSON.stringify([
      'LOCAL-PROJECT-001', 'Fictional Atlas Modernization',
    ]));
    expect(screen.getByRole('option', { name: /Fictional Atlas Modernization.*saved project/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Project category' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Project phase' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Lesson type' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Situation observed' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Root cause' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Impact' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Recommendation' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Applicability' })).toBeInTheDocument();
    expect(screen.getAllByText('0/4000 characters')).toHaveLength(5);
    expect(screen.getByText('Improve release handover'.length + '/150 characters')).toBeInTheDocument();
  });

  it('keeps a legacy project snapshot available after choosing No project', async () => {
    const user = userEvent.setup();
    const catalog = [
      { id: 'A|B', name: 'C' },
      { id: 'A', name: 'B|C' },
      { id: 'LOCAL-PROJECT-002', name: 'Fictional Harbor Migration' },
    ];
    const { props } = renderEditor({ projects: catalog });
    const projectSelect = screen.getByRole('combobox', { name: 'Project' });
    const snapshotValue = JSON.stringify(['LOCAL-PROJECT-001', 'Fictional Atlas Modernization']);

    expect(screen.getByRole('option', { name: 'C' })).toHaveValue(JSON.stringify(['A|B', 'C']));
    expect(screen.getByRole('option', { name: 'B|C' })).toHaveValue(JSON.stringify(['A', 'B|C']));
    expect([...projectSelect.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'No project', 'C', 'B|C', 'Fictional Harbor Migration',
      'Fictional Atlas Modernization (saved project)',
    ]);

    await user.selectOptions(projectSelect, '');
    expect(projectSelect).toHaveValue('');
    expect(screen.getByRole('option', { name: /Fictional Atlas Modernization.*saved project/ })).toBeInTheDocument();
    expect([...projectSelect.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'No project', 'C', 'B|C', 'Fictional Harbor Migration',
      'Fictional Atlas Modernization (saved project)',
    ]);
    await user.selectOptions(projectSelect, snapshotValue);
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
    }), 7);
  });

  it('requires replacing a newly selected project that disappears from the catalog', async () => {
    const user = userEvent.setup();
    const selectedProject = { id: 'LOCAL-PROJECT-003', name: 'Fictional Forest Renewal' };
    const view = renderEditor({ draft: null, projects: [selectedProject] });
    const projectValue = JSON.stringify([selectedProject.id, selectedProject.name]);
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Keep the selection honest');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), projectValue);

    view.rerender(<DraftEditor {...view.props} projects={[]} />);

    const projectSelect = screen.getByRole('combobox', { name: 'Project' });
    expect(projectSelect).toHaveValue(projectValue);
    expect(screen.getByRole('option', { name: /Fictional Forest Renewal.*no longer available/i })).toBeInTheDocument();
    const projectError = screen.getByRole('alert');
    expect(projectError).toHaveTextContent('Choose a current project or No project before saving.');
    expect(projectSelect).toHaveAttribute('aria-invalid', 'true');

    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(projectSelect).toHaveFocus();
    expect(view.props.onSave).not.toHaveBeenCalled();

    await user.selectOptions(projectSelect, '');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(view.props.onSave).toHaveBeenCalledWith(expect.objectContaining({
      projectId: null,
      projectName: null,
    }), null);
  });

  it('saves a draft with only a title and keeps all other fields optional', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor();

    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Updated release handover');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Draft saved');
    expect(props.onSave).toHaveBeenCalledWith({
      version: 3,
      title: 'Updated release handover',
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
      projectCategory: null,
      projectPhase: null,
      situationObserved: null,
      rootCause: null,
      lessonType: null,
      impact: null,
      recommendation: null,
      applicability: null,
    }, 7);
  });

  it('creates a draft with only a title and opens the full editor in one save', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ draft: null });

    expect(screen.getByRole('dialog', { name: 'Create lesson' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Capture a lesson early');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Draft saved');
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({
      version: 0,
      title: 'Capture a lesson early',
      situationObserved: null,
    }), null);
    expect(screen.getByRole('dialog', { name: 'Edit lesson' })).toBeInTheDocument();
  });

  it('clears category, phase, and lesson type to null when creating a draft', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ draft: null });

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Draft without classifications');
    for (const [label, value] of [
      ['Project category', 'Technology'],
      ['Project phase', 'Execution'],
      ['Lesson type', 'Communication'],
    ]) {
      const select = screen.getByRole('combobox', { name: label });
      await user.selectOptions(select, value);
      await user.selectOptions(select, '');
    }
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({
      projectCategory: null,
      projectPhase: null,
      lessonType: null,
    }), null);
  });

  it('clears category, phase, and lesson type to null when editing a draft', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ draft: {
      ...draft,
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      lessonType: 'Communication',
    } });

    for (const label of ['Project category', 'Project phase', 'Lesson type']) {
      await user.selectOptions(screen.getByRole('combobox', { name: label }), '');
    }
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({
      projectCategory: null,
      projectPhase: null,
      lessonType: null,
    }), 7);
  });

  it('keeps the typed fields when a save fails', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValueOnce(new Error('Save failed'));
    renderEditor({ onSave });

    const situation = screen.getByRole('textbox', { name: 'Situation observed' });
    await user.type(situation, 'The current release note was missing.');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');
    expect(situation).toHaveValue('The current release note was missing.');
    expect(screen.queryByText('Draft saved.')).not.toBeInTheDocument();
  });

  it('associates submission validation errors with required fields, including category when there is no project', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ draft: { ...draft, projectId: null, projectName: null } });

    await user.click(screen.getByRole('button', { name: 'Submit for PMO Review' }));

    const category = screen.getByRole('combobox', { name: 'Project category' });
    expect(category).toHaveAttribute('aria-invalid', 'true');
    expect(category.getAttribute('aria-describedby')).toContain('lesson-project-category-error');
    expect(await screen.findByRole('alert', { name: 'Submission errors' })).toHaveTextContent('Project category is required.');
    expect(category).toHaveFocus();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('requires Root cause for Future Prevention and associates the error with that field', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ draft: {
      ...draft,
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      situationObserved: 'The handover omitted the current runbook.',
      lessonType: 'Future Prevention',
      impact: 'Operations followed an outdated procedure.',
      recommendation: 'Share the current runbook before release.',
      applicability: 'Use for releases with an operations handover.',
    } });

    await user.click(screen.getByRole('button', { name: 'Submit for PMO Review' }));

    const rootCause = screen.getByRole('textbox', { name: 'Root cause' });
    expect(rootCause).toHaveAttribute('aria-invalid', 'true');
    expect(rootCause.getAttribute('aria-describedby')).toContain('lesson-rootCause-error');
    expect(await screen.findByRole('alert', { name: 'Submission errors' })).toHaveTextContent(
      'Root cause is required for Future Prevention.',
    );
    expect(rootCause).toHaveFocus();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('submits a complete lesson with No project and becomes read-only after success', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ draft: { ...draft, projectId: null, projectName: null } });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project category' }), 'Technology');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project phase' }), 'Execution');
    await user.type(screen.getByRole('textbox', { name: 'Situation observed' }), 'The handover omitted the current runbook.');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lesson type' }), 'Communication');
    await user.type(screen.getByRole('textbox', { name: 'Impact' }), 'Operations followed an outdated procedure.');
    await user.type(screen.getByRole('textbox', { name: 'Recommendation' }), 'Share the current runbook before release.');
    await user.type(screen.getByRole('textbox', { name: 'Applicability' }), 'Use for releases with an operations handover.');

    await user.click(screen.getByRole('button', { name: 'Submit for PMO Review' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Lesson submitted for PMO review.');
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      version: 3,
      title: 'Improve release handover',
      projectId: null,
      projectName: null,
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      lessonType: 'Communication',
      rootCause: null,
    }), 7);
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Submit for PMO Review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Draft' })).not.toBeInTheDocument();
  });

  it('prevents a duplicate submit and field changes while submission is pending', async () => {
    const user = userEvent.setup();
    let resolveSubmission!: (lesson: LessonDraft) => void;
    const onSubmit = vi.fn(() => new Promise<LessonDraft>((resolve) => { resolveSubmission = resolve; }));
    const completeDraft = {
      ...draft,
      projectCategory: 'Technology' as const,
      projectPhase: 'Execution' as const,
      situationObserved: 'The handover omitted the current runbook.',
      lessonType: 'Communication' as const,
      impact: 'Operations followed an outdated procedure.',
      recommendation: 'Share the current runbook before release.',
      applicability: 'Use for releases with an operations handover.',
    };
    renderEditor({ draft: completeDraft, onSubmit });
    const submitButton = screen.getByRole('button', { name: 'Submit for PMO Review' });
    const recommendation = screen.getByRole('textbox', { name: 'Recommendation' });

    await user.click(submitButton);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(submitButton).toBeDisabled();
    expect(recommendation).toBeDisabled();

    await user.click(submitButton);
    await user.type(recommendation, ' A duplicate change');
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(recommendation).toHaveValue('Share the current runbook before release.');

    resolveSubmission({ ...completeDraft, status: 'PMOEvaluation', version: completeDraft.version + 1 });
    expect(await screen.findByRole('status')).toHaveTextContent('Lesson submitted for PMO review.');
  });

  it('preserves edited fields and shows no success when submission fails', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('Submit failed'));
    renderEditor({
      draft: {
        ...draft,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The handover omitted the current runbook.',
        lessonType: 'Communication',
        impact: 'Operations followed an outdated procedure.',
        recommendation: 'Share the current runbook before release.',
        applicability: 'Use for releases with an operations handover.',
      },
      onSubmit,
    });
    const recommendation = screen.getByRole('textbox', { name: 'Recommendation' });
    await user.clear(recommendation);
    await user.type(recommendation, 'Keep this recommendation if the request fails.');

    await user.click(screen.getByRole('button', { name: 'Submit for PMO Review' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be submitted');
    expect(recommendation).toHaveValue('Keep this recommendation if the request fails.');
    expect(screen.queryByText('Lesson submitted for PMO review.')).not.toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('preserves edits after a stale-version conflict and reloads only after the user chooses', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const latest = { ...draft, title: 'Latest saved title', version: 4 };
    const onSave = vi.fn().mockRejectedValueOnce(apiError(409, 'STALE_LESSON_VERSION'));
    const onReload = vi.fn().mockResolvedValue(latest);
    renderEditor({ onSave, onReload });

    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'My unsaved change');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('changed after you opened it');
    expect(title).toHaveValue('My unsaved change');
    await user.click(screen.getByRole('button', { name: 'Reload latest version' }));

    expect(confirm).toHaveBeenCalledWith('Reloading the latest version will discard your unsaved changes. Continue?');
    expect(onReload).not.toHaveBeenCalled();
    expect(title).toHaveValue('My unsaved change');
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Reload latest version' }));
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Latest saved title');
    expect(onReload).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Reload latest version' })).not.toBeInTheDocument();
  });

  it('freezes fields while reloading and keeps edits when the reload fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSave = vi.fn().mockRejectedValueOnce(apiError(409, 'STALE_LESSON_VERSION'));
    let rejectReload!: (error: Error) => void;
    const onReload = vi.fn(() => new Promise<LessonDraft>((_resolve, reject) => { rejectReload = reject; }));
    renderEditor({ onSave, onReload });

    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Unsaved title');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    await user.click(await screen.findByRole('button', { name: 'Reload latest version' }));
    await vi.waitFor(() => expect(onReload).toHaveBeenCalledOnce());

    expect(title).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Project category' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Situation observed' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close editor' })).toBeDisabled();
    await act(async () => { rejectReload(new Error('Request failed')); });

    expect(await screen.findByRole('alert')).toHaveTextContent('latest version could not be loaded');
    expect(title).toHaveValue('Unsaved title');
    expect(title).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Situation observed' })).toBeEnabled();
  });

  it('focuses the title and announces its validation error after an empty Save Draft', async () => {
    const user = userEvent.setup();
    const { props } = renderEditor({ draft: null });
    const title = screen.getByRole('textbox', { name: 'Title' });

    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a title to save this draft.');
    expect(title).toHaveFocus();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('focuses the title initially and confirms dirty close on Escape before returning focus', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onSave = vi.fn(async (input: UpdateLessonDraftBody) => ({ ...draft, ...input } as LessonDraft));

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open editor</button>
          {open && <DraftEditor draft={draft} projects={projects} onSave={onSave} onSubmit={async () => draft} onReload={async () => draft} onClose={() => setOpen(false)} />}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open editor' });
    await user.click(opener);
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
    await user.type(screen.getByRole('textbox', { name: 'Situation observed' }), 'Unsaved change');
    await user.keyboard('{Escape}');
    expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes?');
    expect(screen.getByRole('dialog', { name: 'Edit lesson' })).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Edit lesson' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('contains keyboard focus and makes the background inert while the dialog is open', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <main className="app-shell">
          <button type="button" onClick={() => setOpen(true)}>Open editor</button>
          {open && <DraftEditor
            draft={draft}
            projects={projects}
            onSave={async (input) => ({ ...draft, ...input } as LessonDraft)}
            onSubmit={async () => draft}
            onReload={async () => draft}
            onClose={() => setOpen(false)}
          />}
        </main>
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open editor' }));
    expect(screen.getByRole('main')).toHaveAttribute('inert');
    const first = screen.getByRole('button', { name: 'Close editor' });
    const last = screen.getByRole('button', { name: /^Close$/ });

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();

    await user.click(last);
    expect(screen.queryByRole('dialog', { name: 'Edit lesson' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
  });
});
