import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  onSave: (input: UpdateLessonDraftBody, draftId: number | null) => Promise<LessonDraft>;
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
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue('LOCAL-PROJECT-001|Fictional Atlas Modernization');
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

  it('preserves edits after a stale-version conflict and reloads only after the user chooses', async () => {
    const user = userEvent.setup();
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

    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Latest saved title');
    expect(onReload).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Reload latest version' })).not.toBeInTheDocument();
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
          {open && <DraftEditor draft={draft} projects={projects} onSave={onSave} onReload={async () => draft} onClose={() => setOpen(false)} />}
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
