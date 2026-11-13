import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { LessonDraft, LessonProject, UpdateLessonDraftBody } from './api';
import './DraftEditor.css';

type DraftFields = Required<Omit<UpdateLessonDraftBody, 'version'>>;

type DraftEditorProps = {
  draft: LessonDraft | null;
  projects: LessonProject[];
  onClose: () => void;
  onSave: (input: UpdateLessonDraftBody, draftId: number | null) => Promise<LessonDraft>;
  onReload: (draftId: number) => Promise<LessonDraft>;
};

const categories = ['Technology', 'Business', 'Infrastructure', 'Data'] as const;
const phases = ['Initiation', 'Planning', 'Execution', 'Closure', 'Not Applicable'] as const;
const types = ['Future Prevention', 'Success to Repeat', 'Risk Avoided', 'Communication'] as const;

const longFields = [
  { name: 'situationObserved', label: 'Situation observed' },
  { name: 'rootCause', label: 'Root cause' },
  { name: 'impact', label: 'Impact' },
  { name: 'recommendation', label: 'Recommendation' },
  { name: 'applicability', label: 'Applicability' },
] as const;

function toFormValues(draft: LessonDraft | null): DraftFields {
  if (!draft) {
    return {
      title: '',
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
    };
  }
  return {
    title: draft.title,
    projectId: draft.projectId,
    projectName: draft.projectName,
    projectCategory: draft.projectCategory,
    projectPhase: draft.projectPhase,
    situationObserved: draft.situationObserved,
    rootCause: draft.rootCause,
    lessonType: draft.lessonType,
    impact: draft.impact,
    recommendation: draft.recommendation,
    applicability: draft.applicability,
  };
}

function projectKey(project: LessonProject): string {
  return JSON.stringify([project.id, project.name]);
}

function getApiErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return null;
  const data = response.data;
  if (typeof data !== 'object' || data === null || !('code' in data)) return null;
  return typeof data.code === 'string' ? data.code : null;
}

export function DraftEditor({ draft, projects, onClose, onSave, onReload }: DraftEditorProps) {
  const [fields, setFields] = useState(() => toFormValues(draft));
  const [savedFields, setSavedFields] = useState(() => toFormValues(draft));
  const [draftId, setDraftId] = useState(draft?.id ?? null);
  const [version, setVersion] = useState(draft?.version ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [hasConflict, setHasConflict] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const savingRef = useRef(false);

  const isDirty = JSON.stringify(fields) !== JSON.stringify(savedFields);
  const selectedProjectValue = fields.projectId !== null && fields.projectName !== null
    ? projectKey({ id: fields.projectId, name: fields.projectName })
    : '';
  const savedProject = savedFields.projectId && savedFields.projectName
    ? { id: savedFields.projectId, name: savedFields.projectName }
    : null;
  const projectChoices = [
    ...projects.map((project) => ({ ...project, isSavedSnapshot: false })),
    ...(savedProject && !projects.some((project) => projectKey(project) === projectKey(savedProject))
      ? [{ ...savedProject, isSavedSnapshot: true }]
      : []),
  ];

  useEffect(() => {
    const activeElement = document.activeElement;
    returnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    const dialog = dialogRef.current;
    const appShell = document.querySelector<HTMLElement>('.app-shell');
    if (appShell) appShell.setAttribute('inert', '');
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else dialog?.setAttribute('open', '');
    titleRef.current?.focus();
    return () => {
      if (dialog?.open && typeof dialog.close === 'function') dialog.close();
      else dialog?.removeAttribute('open');
      if (appShell) appShell.removeAttribute('inert');
      returnFocusRef.current?.focus();
    };
  }, []);

  function requestClose() {
    if (isSaving || isReloading) return;
    if (isDirty && !window.confirm('Discard your unsaved changes?')) return;
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
      return;
    }

    if (event.key !== 'Tab') return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function updateField<Key extends keyof DraftFields>(key: Key, value: DraftFields[Key]) {
    setFields((current) => ({ ...current, [key]: value }));
    setError(null);
    setTitleError(null);
    setIsSaved(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) return;
    const title = fields.title.trim();
    if (!title) {
      setTitleError('Enter a title to save this draft.');
      titleRef.current?.focus();
      return;
    }
    if (title.length > 150) {
      setTitleError('Title must be 150 characters or fewer.');
      titleRef.current?.focus();
      return;
    }

    setIsSaving(true);
    savingRef.current = true;
    setError(null);
    setTitleError(null);
    setHasConflict(false);
    try {
      const updated = await onSave({ ...fields, title, version }, draftId);
      const nextFields = toFormValues(updated);
      setFields(nextFields);
      setSavedFields(nextFields);
      setDraftId(updated.id);
      setVersion(updated.version);
      setIsSaved(true);
    } catch (saveError) {
      if (getApiErrorCode(saveError) === 'STALE_LESSON_VERSION') {
        setHasConflict(true);
        setError('This draft changed after you opened it. Your edits are still here; reload the latest version to continue.');
      } else {
        setError('The draft could not be saved. Your changes are still here; try again.');
      }
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  async function reloadLatestVersion() {
    if (draftId === null || isReloading) return;
    if (isDirty && !window.confirm('Reloading the latest version will discard your unsaved changes. Continue?')) return;
    setIsReloading(true);
    try {
      const latest = await onReload(draftId);
      const latestFields = toFormValues(latest);
      setFields(latestFields);
      setSavedFields(latestFields);
      setDraftId(latest.id);
      setVersion(latest.version);
      setError(null);
      setHasConflict(false);
      setIsSaved(false);
    } catch {
      setError('The latest version could not be loaded. Your edits are still here; try again.');
    } finally {
      setIsReloading(false);
    }
  }

  function setProject(value: string) {
    if (value === '') {
      updateField('projectId', null);
      updateField('projectName', null);
      return;
    }
    const project = projectChoices.find((choice) => projectKey(choice) === value);
    if (project) {
      setFields((current) => ({ ...current, projectId: project.id, projectName: project.name }));
      setError(null);
      setIsSaved(false);
    }
  }

  return createPortal(
    <dialog
        ref={dialogRef}
        className="draft-editor-dialog"
        aria-modal="true"
        aria-labelledby="draft-editor-title"
        onKeyDown={handleKeyDown}
        onCancel={(event) => {
          event.preventDefault();
          requestClose();
        }}
      >
        <form className="draft-editor-form" noValidate onSubmit={save}>
          <div className="draft-editor-heading">
            <div>
              {draftId !== null && <p className="draft-editor-eyebrow">Draft #{draftId} · Open</p>}
              <h2 id="draft-editor-title">{draftId === null ? 'Create lesson' : 'Edit lesson'}</h2>
            </div>
            <button className="draft-editor-close" type="button" aria-label="Close editor" disabled={isSaving || isReloading} onClick={requestClose}>
              ×
            </button>
          </div>

          <div className="draft-editor-field">
            <label htmlFor="lesson-title">Title</label>
            <input
              ref={titleRef}
              id="lesson-title"
              type="text"
              required
              maxLength={150}
              disabled={isSaving || isReloading}
              value={fields.title}
              aria-invalid={titleError ? 'true' : undefined}
              aria-describedby={titleError ? 'lesson-title-error' : 'lesson-title-count'}
              onChange={(event) => updateField('title', event.target.value)}
            />
            {titleError ? (
              <p id="lesson-title-error" className="draft-editor-error" role="alert" aria-live="assertive">{titleError}</p>
            ) : (
              <p id="lesson-title-count" className="draft-editor-counter">{fields.title.length}/150 characters</p>
            )}
          </div>

          <div className="draft-editor-field">
            <label htmlFor="lesson-project">Project</label>
            <select
              id="lesson-project"
              disabled={isSaving || isReloading}
              value={selectedProjectValue}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">No project</option>
              {projectChoices.map((project) => (
                <option key={projectKey(project)} value={projectKey(project)}>
                  {project.name}{project.isSavedSnapshot ? ' (saved project)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="draft-editor-grid">
            <div className="draft-editor-field">
              <label htmlFor="lesson-project-category">Project category</label>
              <select
                id="lesson-project-category"
                disabled={isSaving || isReloading}
                value={fields.projectCategory ?? ''}
                onChange={(event) => updateField('projectCategory', (event.target.value || null) as DraftFields['projectCategory'])}
              >
                <option value="">Select category</option>
                {categories.map((category) => <option key={category}>{category}</option>)}
              </select>
            </div>
            <div className="draft-editor-field">
              <label htmlFor="lesson-project-phase">Project phase</label>
              <select
                id="lesson-project-phase"
                disabled={isSaving || isReloading}
                value={fields.projectPhase ?? ''}
                onChange={(event) => updateField('projectPhase', (event.target.value || null) as DraftFields['projectPhase'])}
              >
                <option value="">Select phase</option>
                {phases.map((phase) => <option key={phase}>{phase}</option>)}
              </select>
            </div>
          </div>

          {longFields.slice(0, 2).map((field) => (
            <div className="draft-editor-field" key={field.name}>
              <label htmlFor={`lesson-${field.name}`}>{field.label}</label>
              <textarea
                id={`lesson-${field.name}`}
                rows={4}
                maxLength={4000}
                disabled={isSaving || isReloading}
                value={fields[field.name] ?? ''}
                aria-describedby={`lesson-${field.name}-count`}
                onChange={(event) => updateField(field.name, event.target.value)}
              />
              <p id={`lesson-${field.name}-count`} className="draft-editor-counter">
                {(fields[field.name] ?? '').length}/4000 characters
              </p>
            </div>
          ))}

          <div className="draft-editor-field">
            <label htmlFor="lesson-type">Lesson type</label>
            <select
              id="lesson-type"
              disabled={isSaving || isReloading}
              value={fields.lessonType ?? ''}
              onChange={(event) => updateField('lessonType', (event.target.value || null) as DraftFields['lessonType'])}
            >
              <option value="">Select lesson type</option>
              {types.map((lessonType) => <option key={lessonType}>{lessonType}</option>)}
            </select>
          </div>

          {longFields.slice(2).map((field) => (
            <div className="draft-editor-field" key={field.name}>
              <label htmlFor={`lesson-${field.name}`}>{field.label}</label>
              <textarea
                id={`lesson-${field.name}`}
                rows={4}
                maxLength={4000}
                disabled={isSaving || isReloading}
                value={fields[field.name] ?? ''}
                aria-describedby={`lesson-${field.name}-count`}
                onChange={(event) => updateField(field.name, event.target.value)}
              />
              <p id={`lesson-${field.name}-count`} className="draft-editor-counter">
                {(fields[field.name] ?? '').length}/4000 characters
              </p>
            </div>
          ))}

          {error && <p className="draft-editor-error" role="alert">{error}</p>}
          {isSaved && <p className="draft-editor-success" role="status">Draft saved.</p>}
          <div className="draft-editor-actions">
            {hasConflict && draftId !== null && (
              <button className="draft-editor-secondary" type="button" disabled={isReloading} onClick={() => void reloadLatestVersion()}>
                {isReloading ? 'Reloading…' : 'Reload latest version'}
              </button>
            )}
            <button className="draft-editor-primary" type="submit" disabled={isSaving || isReloading}>
              {isSaving ? 'Saving…' : 'Save Draft'}
            </button>
            <button className="draft-editor-secondary" type="button" disabled={isSaving || isReloading} onClick={requestClose}>Close</button>
          </div>
        </form>
      </dialog>,
    document.body,
  );
}
