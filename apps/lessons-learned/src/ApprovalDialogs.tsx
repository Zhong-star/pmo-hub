import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApproveLessonBody, LessonDetails, LessonDraft } from './api';
import { useDialogFocus } from './useDialogFocus';
import './DraftEditor.css';

type ApprovalDialogProps = {
  lesson: LessonDraft;
  onConfirm: (lessonId: number, input: ApproveLessonBody) => Promise<LessonDraft>;
  onReload: (lessonId: number) => Promise<LessonDetails>;
  onClose: () => void;
};

function getApiErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return null;
  const data = response.data;
  if (typeof data !== 'object' || data === null || !('code' in data)) return null;
  return typeof data.code === 'string' ? data.code : null;
}

export function ApprovalDialog({ lesson, onConfirm, onReload, onClose }: ApprovalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [hasVersionConflict, setHasVersionConflict] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  useDialogFocus(dialogRef, closeRef);

  async function confirmApproval() {
    if (isApproving || isReloading || hasVersionConflict) return;
    setIsApproving(true);
    setRequestError(null);
    try {
      await onConfirm(lesson.id, { version: lesson.version, ...(lesson.etag ? { etag: lesson.etag } : {}) });
      onClose();
    } catch (error) {
      const code = getApiErrorCode(error);
      if (code === 'STALE_LESSON_VERSION') {
        setHasVersionConflict(true);
        setRequestError('This lesson changed after you opened it. Reload the current version before deciding again.');
      } else if (code === 'LESSON_NOT_AWAITING_EVALUATION') {
        setHasVersionConflict(true);
        setRequestError('This lesson is no longer awaiting evaluation. Reload the current lesson before deciding again.');
      } else {
        setRequestError('The lesson could not be approved. Your review is still here; try again.');
      }
    } finally {
      setIsApproving(false);
    }
  }

  async function reloadCurrentVersion() {
    if (isReloading || isApproving) return;
    setIsReloading(true);
    setRequestError(null);
    try {
      await onReload(lesson.id);
      onClose();
    } catch {
      setRequestError('The current lesson could not be loaded. Try reloading again.');
    } finally {
      setIsReloading(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="draft-editor-dialog"
      aria-modal="true"
      aria-labelledby="approve-lesson-title"
      aria-describedby="approve-lesson-explanation"
      onCancel={(event) => {
        event.preventDefault();
        if (!isApproving && !isReloading) onClose();
      }}
    >
      <div className="draft-editor-form">
        <div className="draft-editor-heading">
          <div>
            <p className="draft-editor-eyebrow">Lesson #{lesson.id} · version {lesson.version}</p>
            <h2 id="approve-lesson-title">Approve lesson</h2>
          </div>
          <button
            ref={closeRef}
            className="draft-editor-close"
            type="button"
            aria-label="Close approval confirmation"
            disabled={isApproving || isReloading}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p id="approve-lesson-explanation">
          You are approving version {lesson.version} of “{lesson.title}”. Approval publishes it in the Lessons Library.
        </p>
        {requestError && <p className="draft-editor-error" role="alert">{requestError}</p>}
        {hasVersionConflict && (
          <button
            className="draft-editor-secondary"
            type="button"
            disabled={isApproving || isReloading}
            onClick={() => void reloadCurrentVersion()}
          >
            {isReloading ? 'Reloading…' : 'Reload current version'}
          </button>
        )}
        <div className="draft-editor-actions">
          <button className="draft-editor-secondary" type="button" disabled={isApproving || isReloading} onClick={onClose}>
            Keep reviewing
          </button>
          <button
            className="draft-editor-primary"
            type="button"
            disabled={isApproving || isReloading || hasVersionConflict}
            onClick={() => void confirmApproval()}
          >
            {isApproving ? 'Publishing…' : 'Confirm approval'}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
