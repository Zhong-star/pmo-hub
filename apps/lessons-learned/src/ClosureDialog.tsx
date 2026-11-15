import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CloseLessonBody, LessonDetails, LessonDraft } from './api';
import { useDialogFocus } from './useDialogFocus';
import './DraftEditor.css';

type ClosureDialogProps = {
  lesson: LessonDraft;
  onConfirm: (lessonId: number, input: CloseLessonBody) => Promise<LessonDraft>;
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

export function ClosureDialog({ lesson, onConfirm, onReload, onClose }: ClosureDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [hasVersionConflict, setHasVersionConflict] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  useDialogFocus(dialogRef, closeRef);

  async function confirmClosure() {
    if (isClosing || isReloading || hasVersionConflict) return;
    setIsClosing(true);
    setRequestError(null);
    try {
      await onConfirm(lesson.id, { version: lesson.version });
      onClose();
    } catch (error) {
      const code = getApiErrorCode(error);
      if (code === 'STALE_LESSON_VERSION' || code === 'LESSON_NOT_APPROVED') {
        setHasVersionConflict(true);
        setRequestError(code === 'STALE_LESSON_VERSION'
          ? 'This lesson changed after you opened it. Reload the current version before closing.'
          : 'This lesson is no longer Approved. Reload the current lesson before deciding again.');
      } else {
        setRequestError('The lesson could not be closed. Your review is still here; try again.');
      }
    } finally {
      setIsClosing(false);
    }
  }

  async function reloadCurrentVersion() {
    if (isReloading || isClosing) return;
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
      aria-labelledby="close-lesson-title"
      aria-describedby="close-lesson-explanation"
      onCancel={(event) => {
        event.preventDefault();
        if (!isClosing && !isReloading) onClose();
      }}
    >
      <div className="draft-editor-form">
        <div className="draft-editor-heading">
          <div>
            <p className="draft-editor-eyebrow">Lesson #{lesson.id} · version {lesson.version}</p>
            <h2 id="close-lesson-title">Close lesson</h2>
          </div>
          <button
            ref={closeRef}
            className="draft-editor-close"
            type="button"
            aria-label="Close closure confirmation"
            disabled={isClosing || isReloading}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p id="close-lesson-explanation">
          You are closing version {lesson.version} of “{lesson.title}”. It will remain in the Lessons Library with its original approval date.
        </p>
        {requestError && <p className="draft-editor-error" role="alert">{requestError}</p>}
        {hasVersionConflict && (
          <button
            className="draft-editor-secondary"
            type="button"
            disabled={isClosing || isReloading}
            onClick={() => void reloadCurrentVersion()}
          >
            {isReloading ? 'Reloading…' : 'Reload current version'}
          </button>
        )}
        <div className="draft-editor-actions">
          <button className="draft-editor-secondary" type="button" disabled={isClosing || isReloading} onClick={onClose}>
            Keep published
          </button>
          <button
            className="draft-editor-primary"
            type="button"
            disabled={isClosing || isReloading || hasVersionConflict}
            onClick={() => void confirmClosure()}
          >
            {isClosing ? 'Closing…' : 'Confirm closure'}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
