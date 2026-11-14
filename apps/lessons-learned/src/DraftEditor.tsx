import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { LessonDraft, LessonProject, SubmitLessonBody, UpdateLessonDraftBody } from './api';
import { useDialogFocus } from './useDialogFocus';
import './DraftEditor.css';

type DraftFields = Required<Omit<UpdateLessonDraftBody, 'version'>>;

type DraftEditorProps = {
  draft: LessonDraft | null;
  projects: LessonProject[];
  projectsLoading?: boolean;
  projectsError?: boolean;
  onRetryProjects?: () => void;
  homeRecheckError?: boolean;
  onRetryHomeCheck?: () => void;
  canSubmit?: boolean;
  onClose: () => void;
  onViewCurrent?: (draftId: number) => void;
  getReturnFocusTarget?: (draftId: number | null) => HTMLElement | null;
  onRegisterNavigationCloseRequest?: (requestClose: (() => boolean) | null) => void;
  onSave: (input: UpdateLessonDraftBody, draftId: number | null) => Promise<LessonDraft>;
  onSubmit: (input: SubmitLessonBody, draftId: number) => Promise<LessonDraft>;
  onReload: (draftId: number) => Promise<LessonDraft>;
};

type SubmissionFieldErrors = Partial<Record<keyof DraftFields, string>>;

const submissionFieldLabels: Record<keyof DraftFields, string> = {
  title: 'Title',
  projectId: 'Project',
  projectName: 'Project',
  projectCategory: 'Project category',
  projectPhase: 'Project phase',
  situationObserved: 'Situation observed',
  rootCause: 'Root cause',
  lessonType: 'Lesson type',
  impact: 'Impact',
  recommendation: 'Recommendation',
  applicability: 'Applicability',
};

const submissionInputIds: Record<keyof DraftFields, string> = {
  title: 'lesson-title',
  projectId: 'lesson-project',
  projectName: 'lesson-project',
  projectCategory: 'lesson-project-category',
  projectPhase: 'lesson-project-phase',
  situationObserved: 'lesson-situationObserved',
  rootCause: 'lesson-rootCause',
  lessonType: 'lesson-type',
  impact: 'lesson-impact',
  recommendation: 'lesson-recommendation',
  applicability: 'lesson-applicability',
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

function getApiFieldErrors(error: unknown): SubmissionFieldErrors | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return null;
  const data = response.data;
  if (typeof data !== 'object' || data === null || !('fieldErrors' in data)) return null;
  const fieldErrors = data.fieldErrors;
  if (typeof fieldErrors !== 'object' || fieldErrors === null) return null;
  return Object.fromEntries(Object.entries(fieldErrors).filter((entry): entry is [keyof DraftFields, string] =>
    Object.hasOwn(submissionFieldLabels, entry[0]) && typeof entry[1] === 'string'));
}

export function DraftEditor({
  draft,
  projects,
  projectsLoading = false,
  projectsError = false,
  onRetryProjects,
  homeRecheckError = false,
  onRetryHomeCheck,
  canSubmit = true,
  onClose,
  onViewCurrent,
  getReturnFocusTarget,
  onRegisterNavigationCloseRequest,
  onSave,
  onSubmit,
  onReload,
}: DraftEditorProps) {
  const [fields, setFields] = useState(() => toFormValues(draft));
  const [savedFields, setSavedFields] = useState(() => toFormValues(draft));
  const [draftId, setDraftId] = useState(draft?.id ?? null);
  const [version, setVersion] = useState(draft?.version ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [submissionFieldErrors, setSubmissionFieldErrors] = useState<SubmissionFieldErrors>({});
  const [isSubmitted, setIsSubmitted] = useState(draft?.status === 'PMOEvaluation');
  const [isSaving, setIsSaving] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [hasConflict, setHasConflict] = useState(false);
  const [isLessonNotOpen, setIsLessonNotOpen] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<HTMLSelectElement>(null);
  const savingRef = useRef(false);
  const pendingSubmissionFocusRef = useRef<keyof DraftFields | null>(null);

  useEffect(() => {
    const field = pendingSubmissionFocusRef.current;
    if (isSaving || field === null) return;
    pendingSubmissionFocusRef.current = null;
    dialogRef.current?.querySelector<HTMLElement>(`#${submissionInputIds[field]}`)?.focus();
  }, [isSaving, submissionFieldErrors]);

  const isDirty = JSON.stringify(fields) !== JSON.stringify(savedFields);
  const selectedProjectValue = fields.projectId !== null && fields.projectName !== null
    ? projectKey({ id: fields.projectId, name: fields.projectName })
    : '';
  const savedProject = savedFields.projectId && savedFields.projectName
    ? { id: savedFields.projectId, name: savedFields.projectName }
    : null;
  const selectedProject = fields.projectId !== null && fields.projectName !== null
    ? { id: fields.projectId, name: fields.projectName }
    : null;
  const savedProjectValue = savedProject ? projectKey(savedProject) : '';
  const selectedProjectIsCurrent = selectedProject !== null && projects.some(
    (project) => projectKey(project) === selectedProjectValue,
  );
  const selectedProjectIsSavedSnapshot = selectedProject !== null && selectedProjectValue === savedProjectValue;
  const hasUnavailableProjectSelection = selectedProject !== null && !selectedProjectIsCurrent && !selectedProjectIsSavedSnapshot;
  const projectChoices = [
    ...projects.map((project) => ({ ...project, isSavedSnapshot: false, isUnavailableSelection: false })),
    ...(savedProject && !projects.some((project) => projectKey(project) === projectKey(savedProject))
      ? [{ ...savedProject, isSavedSnapshot: true, isUnavailableSelection: false }]
      : []),
    ...(hasUnavailableProjectSelection && selectedProject
      ? [{ ...selectedProject, isSavedSnapshot: false, isUnavailableSelection: true }]
      : []),
  ];

  useDialogFocus(dialogRef, titleRef, () => getReturnFocusTarget?.(draftId) ?? null);

  const requestClose = useCallback(() => {
    if (isSaving || isReloading) return false;
    if (isDirty && !window.confirm('Discard your unsaved changes?')) return false;
    onClose();
    return true;
  }, [isDirty, isReloading, isSaving, onClose]);

  useEffect(() => {
    onRegisterNavigationCloseRequest?.(requestClose);
    return () => onRegisterNavigationCloseRequest?.(null);
  }, [onRegisterNavigationCloseRequest, requestClose]);

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
    }
  }

  function updateField<Key extends keyof DraftFields>(key: Key, value: DraftFields[Key]) {
    setFields((current) => ({ ...current, [key]: value }));
    setError(null);
    setTitleError(null);
    setSubmissionFieldErrors({});
    setIsSaved(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || isSubmitted || isLessonNotOpen) return;
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
    if (hasUnavailableProjectSelection) {
      projectRef.current?.focus();
      return;
    }

    setIsSaving(true);
    savingRef.current = true;
    setError(null);
    setTitleError(null);
    setSubmissionFieldErrors({});
    setHasConflict(false);
    setIsSaved(false);
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
      } else if (getApiErrorCode(saveError) === 'LESSON_NOT_OPEN') {
        setIsLessonNotOpen(true);
        setHasConflict(false);
        setError('This lesson is no longer Open. Your changes are still here; saving and submitting are disabled. View its current status and history below.');
      } else {
        setError('The draft could not be saved. Your changes are still here; try again.');
      }
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  async function submit() {
    if (!canSubmit || savingRef.current || isSubmitted || isLessonNotOpen) return;
    const title = fields.title.trim();
    const fieldErrors: SubmissionFieldErrors = {};
    if (!title) fieldErrors.title = 'Title is required.';
    else if (title.length > 150) fieldErrors.title = 'Title must be 150 characters or fewer.';
    if (!fields.projectCategory) fieldErrors.projectCategory = 'Project category is required.';
    if (!fields.projectPhase) fieldErrors.projectPhase = 'Project phase is required.';
    if (!fields.situationObserved?.trim()) fieldErrors.situationObserved = 'Situation observed is required.';
    if (!fields.lessonType) fieldErrors.lessonType = 'Lesson type is required.';
    if (!fields.impact?.trim()) fieldErrors.impact = 'Impact is required.';
    if (!fields.recommendation?.trim()) fieldErrors.recommendation = 'Recommendation is required.';
    if (!fields.applicability?.trim()) fieldErrors.applicability = 'Applicability is required.';
    if (fields.lessonType === 'Future Prevention' && !fields.rootCause?.trim()) {
      fieldErrors.rootCause = 'Root cause is required for Future Prevention.';
    }
    if (hasUnavailableProjectSelection) fieldErrors.projectId = 'Choose a current project or No project before submitting.';

    if (Object.keys(fieldErrors).length > 0) {
      setSubmissionFieldErrors(fieldErrors);
      setError(null);
      const firstField = Object.keys(fieldErrors)[0] as keyof DraftFields;
      dialogRef.current?.querySelector<HTMLElement>(`#${submissionInputIds[firstField]}`)?.focus();
      return;
    }

    setIsSaving(true);
    setIsSubmitting(true);
    savingRef.current = true;
    setError(null);
    setTitleError(null);
    setSubmissionFieldErrors({});
    setHasConflict(false);
    try {
      let submittedDraftId = draftId;
      let submittedVersion = version;
      if (submittedDraftId === null) {
        const created = await onSave({ ...fields, title, version }, null);
        submittedDraftId = created.id;
        submittedVersion = created.version;
        const saved = toFormValues(created);
        setFields(saved);
        setSavedFields(saved);
        setDraftId(created.id);
        setVersion(created.version);
      }

      const input = {
        version: submittedVersion,
        title,
        projectId: fields.projectId,
        projectName: fields.projectName,
        projectCategory: fields.projectCategory!,
        projectPhase: fields.projectPhase!,
        situationObserved: fields.situationObserved!,
        rootCause: fields.rootCause,
        lessonType: fields.lessonType!,
        impact: fields.impact!,
        recommendation: fields.recommendation!,
        applicability: fields.applicability!,
      } satisfies SubmitLessonBody;
      const submitted = await onSubmit(input, submittedDraftId);
      const nextFields = toFormValues(submitted);
      setFields(nextFields);
      setSavedFields(nextFields);
      setDraftId(submitted.id);
      setVersion(submitted.version);
      setIsSubmitted(true);
      setIsSaved(false);
    } catch (submitError) {
      const serverFieldErrors = getApiFieldErrors(submitError);
      if (serverFieldErrors) {
        setSubmissionFieldErrors(serverFieldErrors);
        const firstField = Object.keys(serverFieldErrors)[0] as keyof DraftFields | undefined;
        if (firstField) pendingSubmissionFocusRef.current = firstField;
        setError('Correct the indicated fields before submitting. Your changes are still here.');
      } else if (getApiErrorCode(submitError) === 'STALE_LESSON_VERSION') {
        setHasConflict(true);
        setError('This draft changed after you opened it. Your edits are still here; reload the latest version to continue.');
      } else if (getApiErrorCode(submitError) === 'LESSON_NOT_OPEN') {
        setIsLessonNotOpen(true);
        setHasConflict(false);
        setError('This lesson is no longer Open. Your changes are still here; saving and submitting are disabled. View its current status and history below.');
      } else {
        setError('The lesson could not be submitted. Your changes are still here; try again.');
      }
    } finally {
      savingRef.current = false;
      setIsSubmitting(false);
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
    } catch (reloadError) {
      if (getApiErrorCode(reloadError) === 'LESSON_NOT_OPEN') {
        setIsLessonNotOpen(true);
        setHasConflict(false);
        setError('This lesson is no longer Open. Your changes are still here; saving and submitting are disabled. View its current status and history below.');
      } else {
        setError('The latest version could not be loaded. Your edits are still here; try again.');
      }
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
              {draftId !== null && <p className="draft-editor-eyebrow">{isSubmitted ? `Lesson #${draftId} · PMO evaluation` : `Draft #${draftId} · Open`}</p>}
              <h2 id="draft-editor-title">{isSubmitted ? 'Lesson submitted' : draftId === null ? 'Create lesson' : 'Edit lesson'}</h2>
            </div>
            <button className="draft-editor-close" type="button" aria-label="Close editor" disabled={isSaving || isReloading} onClick={requestClose}>
              ×
            </button>
          </div>

          {projectsLoading && <p className="draft-editor-catalog-status" role="status">Loading project options…</p>}
          {projectsError && (
            <div className="draft-editor-catalog-status" role="alert" aria-label="Project options error">
              <p>Project options could not be loaded.</p>
              <button className="draft-editor-secondary" type="button" onClick={onRetryProjects}>
                Retry project options
              </button>
            </div>
          )}
          {homeRecheckError && (
            <div className="draft-editor-catalog-status" role="alert" aria-label="Home access check temporarily unavailable">
              <p>The Home access recheck is temporarily unavailable. Retry to verify access.</p>
              <button className="draft-editor-secondary" type="button" onClick={onRetryHomeCheck}>
                Retry access check
              </button>
            </div>
          )}

          <div className="draft-editor-field">
            <label htmlFor="lesson-title">Title</label>
            <input
              ref={titleRef}
              id="lesson-title"
              type="text"
              required
              maxLength={150}
              disabled={isSaving || isReloading || isSubmitted}
              value={fields.title}
              aria-invalid={titleError || submissionFieldErrors.title ? 'true' : undefined}
              aria-describedby={titleError
                ? 'lesson-title-error'
                : submissionFieldErrors.title ? 'lesson-title-submission-error' : 'lesson-title-count'}
              onChange={(event) => updateField('title', event.target.value)}
            />
            {titleError ? (
              <p id="lesson-title-error" className="draft-editor-error" role="alert" aria-live="assertive">{titleError}</p>
            ) : submissionFieldErrors.title ? (
              <p id="lesson-title-submission-error" className="draft-editor-error">{submissionFieldErrors.title}</p>
            ) : (
              <p id="lesson-title-count" className="draft-editor-counter">{fields.title.length}/150 characters</p>
            )}
          </div>

          <div className="draft-editor-field">
            <label htmlFor="lesson-project">Project</label>
            <select
              ref={projectRef}
              id="lesson-project"
              disabled={isSaving || isReloading || isSubmitted}
              value={selectedProjectValue}
              aria-invalid={hasUnavailableProjectSelection || submissionFieldErrors.projectId || submissionFieldErrors.projectName
                ? 'true' : undefined}
              aria-describedby={hasUnavailableProjectSelection
                ? 'lesson-project-error'
                : submissionFieldErrors.projectId || submissionFieldErrors.projectName ? 'lesson-project-submission-error' : undefined}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">No project</option>
              {projectChoices.map((project) => (
                <option key={projectKey(project)} value={projectKey(project)}>
                  {project.name}
                  {project.isSavedSnapshot ? ' (saved project)' : ''}
                  {project.isUnavailableSelection ? ' (no longer available; choose another project)' : ''}
                </option>
              ))}
            </select>
            {hasUnavailableProjectSelection && (
              <p id="lesson-project-error" className="draft-editor-error" role="alert">
                This project is no longer available. Choose a current project or No project before saving.
              </p>
            )}
            {!hasUnavailableProjectSelection && (submissionFieldErrors.projectId || submissionFieldErrors.projectName) && (
              <p id="lesson-project-submission-error" className="draft-editor-error">
                {submissionFieldErrors.projectId ?? submissionFieldErrors.projectName}
              </p>
            )}
          </div>

          <div className="draft-editor-grid">
            <div className="draft-editor-field">
              <label htmlFor="lesson-project-category">Project category</label>
              <select
                id="lesson-project-category"
                disabled={isSaving || isReloading || isSubmitted}
                value={fields.projectCategory ?? ''}
                aria-invalid={submissionFieldErrors.projectCategory ? 'true' : undefined}
                aria-describedby={submissionFieldErrors.projectCategory ? 'lesson-project-category-error' : undefined}
                onChange={(event) => updateField('projectCategory', (event.target.value || null) as DraftFields['projectCategory'])}
              >
                <option value="">Select category</option>
                {categories.map((category) => <option key={category}>{category}</option>)}
              </select>
              {submissionFieldErrors.projectCategory && (
                <p id="lesson-project-category-error" className="draft-editor-error">{submissionFieldErrors.projectCategory}</p>
              )}
            </div>
            <div className="draft-editor-field">
              <label htmlFor="lesson-project-phase">Project phase</label>
              <select
                id="lesson-project-phase"
                disabled={isSaving || isReloading || isSubmitted}
                value={fields.projectPhase ?? ''}
                aria-invalid={submissionFieldErrors.projectPhase ? 'true' : undefined}
                aria-describedby={submissionFieldErrors.projectPhase ? 'lesson-project-phase-error' : undefined}
                onChange={(event) => updateField('projectPhase', (event.target.value || null) as DraftFields['projectPhase'])}
              >
                <option value="">Select phase</option>
                {phases.map((phase) => <option key={phase}>{phase}</option>)}
              </select>
              {submissionFieldErrors.projectPhase && (
                <p id="lesson-project-phase-error" className="draft-editor-error">{submissionFieldErrors.projectPhase}</p>
              )}
            </div>
          </div>

          {longFields.slice(0, 2).map((field) => (
            <div className="draft-editor-field" key={field.name}>
              <label htmlFor={`lesson-${field.name}`}>{field.label}</label>
              <textarea
                id={`lesson-${field.name}`}
                rows={4}
                maxLength={4000}
                disabled={isSaving || isReloading || isSubmitted}
                value={fields[field.name] ?? ''}
                aria-invalid={submissionFieldErrors[field.name] ? 'true' : undefined}
                aria-describedby={submissionFieldErrors[field.name]
                  ? `lesson-${field.name}-error lesson-${field.name}-count`
                  : `lesson-${field.name}-count`}
                onChange={(event) => updateField(field.name, event.target.value)}
              />
              {submissionFieldErrors[field.name] && (
                <p id={`lesson-${field.name}-error`} className="draft-editor-error">{submissionFieldErrors[field.name]}</p>
              )}
              <p id={`lesson-${field.name}-count`} className="draft-editor-counter">
                {(fields[field.name] ?? '').length}/4000 characters
              </p>
            </div>
          ))}

          <div className="draft-editor-field">
            <label htmlFor="lesson-type">Lesson type</label>
            <select
              id="lesson-type"
              disabled={isSaving || isReloading || isSubmitted}
              value={fields.lessonType ?? ''}
              aria-invalid={submissionFieldErrors.lessonType ? 'true' : undefined}
              aria-describedby={submissionFieldErrors.lessonType ? 'lesson-type-error' : undefined}
              onChange={(event) => updateField('lessonType', (event.target.value || null) as DraftFields['lessonType'])}
            >
              <option value="">Select lesson type</option>
              {types.map((lessonType) => <option key={lessonType}>{lessonType}</option>)}
            </select>
            {submissionFieldErrors.lessonType && (
              <p id="lesson-type-error" className="draft-editor-error">{submissionFieldErrors.lessonType}</p>
            )}
          </div>

          {longFields.slice(2).map((field) => (
            <div className="draft-editor-field" key={field.name}>
              <label htmlFor={`lesson-${field.name}`}>{field.label}</label>
              <textarea
                id={`lesson-${field.name}`}
                rows={4}
                maxLength={4000}
                disabled={isSaving || isReloading || isSubmitted}
                value={fields[field.name] ?? ''}
                aria-invalid={submissionFieldErrors[field.name] ? 'true' : undefined}
                aria-describedby={submissionFieldErrors[field.name]
                  ? `lesson-${field.name}-error lesson-${field.name}-count`
                  : `lesson-${field.name}-count`}
                onChange={(event) => updateField(field.name, event.target.value)}
              />
              {submissionFieldErrors[field.name] && (
                <p id={`lesson-${field.name}-error`} className="draft-editor-error">{submissionFieldErrors[field.name]}</p>
              )}
              <p id={`lesson-${field.name}-count`} className="draft-editor-counter">
                {(fields[field.name] ?? '').length}/4000 characters
              </p>
            </div>
          ))}

          {Object.keys(submissionFieldErrors).length > 0 && (
            <div className="draft-editor-error" role="alert" aria-label="Submission errors">
              <p>Review these fields before submitting:</p>
              <ul>
                {Object.entries(submissionFieldErrors).map(([field, message]) => (
                  <li key={field}>{submissionFieldLabels[field as keyof DraftFields]}: {message}</li>
                ))}
              </ul>
            </div>
          )}
          {error && <p className="draft-editor-error" role="alert">{error}</p>}
          {isSaved && <p className="draft-editor-success" role="status">Draft saved.</p>}
          {isSubmitted && <p className="draft-editor-success" role="status">Lesson submitted for PMO review.</p>}
          <div className="draft-editor-actions">
            {!isSubmitted && hasConflict && draftId !== null && (
              <button className="draft-editor-secondary" type="button" disabled={isReloading} onClick={() => void reloadLatestVersion()}>
                {isReloading ? 'Reloading…' : 'Reload latest version'}
              </button>
            )}
            {isLessonNotOpen && draftId !== null && onViewCurrent && (
              <button className="draft-editor-secondary" type="button" onClick={() => onViewCurrent(draftId)}>
                View current lesson details and history
              </button>
            )}
            {!isSubmitted && (
              <>
                <button className="draft-editor-primary" type="submit" disabled={isSaving || isReloading || isLessonNotOpen}>
                  {isSaving ? isSubmitting ? 'Submitting…' : 'Saving…' : 'Save Draft'}
                </button>
                {canSubmit && (
                  <button className="draft-editor-primary" type="button" disabled={isSaving || isReloading || isLessonNotOpen} onClick={() => void submit()}>
                    {isSubmitting ? 'Submitting…' : 'Submit for PMO Review'}
                  </button>
                )}
              </>
            )}
            <button className="draft-editor-secondary" type="button" disabled={isSaving || isReloading} onClick={requestClose}>Close</button>
          </div>
        </form>
      </dialog>,
    document.body,
  );
}
