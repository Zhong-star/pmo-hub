import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { CancelLessonBody, LessonDraft } from './api';
import './DraftEditor.css';

type CancelLessonDialogProps = {
  draft: LessonDraft;
  onClose: () => void;
  onReload: (lessonId: number) => Promise<LessonDraft>;
  onConfirm: (lessonId: number, input: CancelLessonBody) => Promise<LessonDraft>;
};

function useDialogFocus(dialogRef: RefObject<HTMLDialogElement | null>, initialFocusRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const activeElement = document.activeElement;
    const returnFocus = activeElement instanceof HTMLElement ? activeElement : null;
    const dialog = dialogRef.current;
    const appShell = document.querySelector<HTMLElement>('.app-shell');
    if (appShell) appShell.setAttribute('inert', '');
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else dialog?.setAttribute('open', '');
    initialFocusRef.current?.focus();
    return () => {
      if (dialog?.open && typeof dialog.close === 'function') dialog.close();
      else dialog?.removeAttribute('open');
      if (appShell) appShell.removeAttribute('inert');
      if (returnFocus?.isConnected) returnFocus.focus();
      else document.querySelector<HTMLElement>('#page-title')?.focus();
    };
  }, [dialogRef, initialFocusRef]);
}

function getReasonFieldError(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return null;
  const data = response.data;
  if (typeof data !== 'object' || data === null || !('fieldErrors' in data)) return null;
  const fieldErrors = data.fieldErrors;
  if (typeof fieldErrors !== 'object' || fieldErrors === null || !('reason' in fieldErrors)) return null;
  return typeof fieldErrors.reason === 'string' ? fieldErrors.reason : null;
}

function getApiErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return null;
  const data = response.data;
  if (typeof data !== 'object' || data === null || !('code' in data)) return null;
  return typeof data.code === 'string' ? data.code : null;
}

export function CancelLessonDialog({ draft, onClose, onReload, onConfirm }: CancelLessonDialogProps) {
  const [currentDraft, setCurrentDraft] = useState(draft);
  const [version, setVersion] = useState(draft.version);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [hasVersionConflict, setHasVersionConflict] = useState(false);
  const [isDraftOpen, setIsDraftOpen] = useState(true);
  const [isReloading, setIsReloading] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useDialogFocus(dialogRef, reasonRef);

  function requestClose() {
    if (isCancelling || isReloading) return;
    if (reason.length > 0 && !window.confirm('Discard your cancellation reason?')) return;
    onClose();
  }

  async function reloadCurrentDraft() {
    if (isReloading || isCancelling) return;
    setIsReloading(true);
    setRequestError(null);
    try {
      const latest = await onReload(currentDraft.id);
      setCurrentDraft(latest);
      setVersion(latest.version);
      setHasVersionConflict(false);
      setIsDraftOpen(true);
      setRequestError('Review the current lesson and confirm cancellation again. Your reason is still here.');
    } catch (error) {
      if (getApiErrorCode(error) === 'LESSON_NOT_OPEN') {
        setIsDraftOpen(false);
        setRequestError('This lesson is no longer Open and cannot be cancelled. Your reason is still here.');
      } else {
        setRequestError('The latest draft could not be loaded. Your reason is still here; try reloading again.');
      }
    } finally {
      setIsReloading(false);
    }
  }

  async function confirmCancellation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCancelling || isReloading || hasVersionConflict || !isDraftOpen) return;
    if (!reason.trim()) {
      setReasonError('Enter a reason for cancelling this lesson.');
      setRequestError(null);
      reasonRef.current?.focus();
      return;
    }

    setIsCancelling(true);
    setReasonError(null);
    setRequestError(null);
    try {
      await onConfirm(currentDraft.id, { version, reason });
      onClose();
    } catch (error) {
      setReasonError(getReasonFieldError(error));
      const errorCode = getApiErrorCode(error);
      if (errorCode === 'STALE_LESSON_VERSION') {
        setHasVersionConflict(true);
        setRequestError('This draft changed after you opened it. Reload the current version before confirming again. Your reason is still here.');
      } else if (errorCode === 'LESSON_NOT_OPEN') {
        setIsDraftOpen(false);
        setRequestError('This lesson is no longer Open and cannot be cancelled. Your reason is still here.');
      } else {
        setRequestError('The lesson could not be cancelled. Your reason is still here; try again.');
      }
    } finally {
      setIsCancelling(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="draft-editor-dialog"
      aria-modal="true"
      aria-labelledby="cancel-lesson-title"
      aria-describedby="cancel-lesson-explanation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          requestClose();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
    >
      <form className="draft-editor-form" noValidate onSubmit={(event) => void confirmCancellation(event)}>
        <div className="draft-editor-heading">
          <div>
            <p className="draft-editor-eyebrow">Draft #{currentDraft.id} · Open</p>
            <h2 id="cancel-lesson-title">Cancel lesson</h2>
          </div>
          <button className="draft-editor-close" type="button" aria-label="Close cancellation" disabled={isCancelling || isReloading} onClick={requestClose}>
            ×
          </button>
        </div>
        <p id="cancel-lesson-explanation">This will archive “{currentDraft.title}”. The lesson will stay in My Submissions as read-only.</p>
        <div className="draft-editor-field">
          <label htmlFor="lesson-cancellation-reason">Reason for cancellation</label>
          <textarea
            ref={reasonRef}
            id="lesson-cancellation-reason"
            required
            maxLength={1000}
            value={reason}
            aria-invalid={reasonError ? 'true' : undefined}
            aria-describedby={reasonError ? 'lesson-cancellation-reason-error' : 'lesson-cancellation-reason-count'}
            disabled={isCancelling || isReloading}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(null);
              setRequestError(null);
            }}
          />
          {reasonError ? (
            <p id="lesson-cancellation-reason-error" className="draft-editor-error" role="alert">{reasonError}</p>
          ) : (
            <p id="lesson-cancellation-reason-count" className="draft-editor-counter">{reason.length}/1,000 characters</p>
          )}
        </div>
        {requestError && <p className="draft-editor-error" role="alert">{requestError}</p>}
        {hasVersionConflict && isDraftOpen && (
          <button className="draft-editor-secondary" type="button" disabled={isCancelling || isReloading} onClick={() => void reloadCurrentDraft()}>
            {isReloading ? 'Reloading…' : 'Reload current version'}
          </button>
        )}
        <div className="draft-editor-actions">
          <button className="draft-editor-secondary" type="button" disabled={isCancelling || isReloading} onClick={requestClose}>Keep draft</button>
          <button className="draft-editor-primary" type="submit" disabled={isCancelling || isReloading || hasVersionConflict || !isDraftOpen}>
            {isCancelling ? 'Cancelling…' : 'Confirm cancellation'}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

type ArchivedSubmissionDetailsDialogProps = {
  draft: LessonDraft;
  onClose: () => void;
};

export function ArchivedSubmissionDetailsDialog({ draft, onClose }: ArchivedSubmissionDetailsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useDialogFocus(dialogRef, closeRef);

  const details: Array<[string, string]> = [
    ['Title', draft.title],
    ['Author', draft.authorId],
    ['Status', draft.status],
    ['Project', draft.projectName ?? 'No project'],
    ['Project category', draft.projectCategory ?? 'Not provided'],
    ['Project phase', draft.projectPhase ?? 'Not provided'],
    ['Situation observed', draft.situationObserved ?? 'Not provided'],
    ['Root cause', draft.rootCause ?? 'Not provided'],
    ['Lesson type', draft.lessonType ?? 'Not provided'],
    ['Impact', draft.impact ?? 'Not provided'],
    ['Recommendation', draft.recommendation ?? 'Not provided'],
    ['Applicability', draft.applicability ?? 'Not provided'],
  ];

  return createPortal(
    <dialog
      ref={dialogRef}
      className="draft-editor-dialog"
      aria-modal="true"
      aria-labelledby="archived-lesson-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="draft-editor-form">
        <div className="draft-editor-heading">
          <div>
            <p className="draft-editor-eyebrow">Lesson #{draft.id} · Archived</p>
            <h2 id="archived-lesson-title">Lesson details</h2>
          </div>
          <button ref={closeRef} className="draft-editor-close" type="button" aria-label="Close lesson details" onClick={onClose}>
            ×
          </button>
        </div>
        <dl className="submission-detail-list">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="draft-editor-actions">
          <button className="draft-editor-secondary" type="button" onClick={onClose}>Close details</button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
