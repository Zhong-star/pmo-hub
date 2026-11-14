import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { LessonDetails, LessonDraft, ReturnLessonBody } from './api';
import { useDialogFocus } from './useDialogFocus';
import './DraftEditor.css';

type ReturnLessonDialogProps = {
  lesson: LessonDetails;
  onClose: () => void;
  onReload: (lessonId: number) => Promise<LessonDetails>;
  onConfirm: (lessonId: number, input: ReturnLessonBody) => Promise<LessonDraft>;
  onComplete: () => void;
  onRegisterNavigationCloseRequest?: (requestClose: (() => boolean) | null) => void;
};

function getApiErrorData(error: unknown): Record<string, unknown> | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return null;
  const data = response.data;
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : null;
}

function getApiErrorCode(error: unknown): string | null {
  const data = getApiErrorData(error);
  return typeof data?.code === 'string' ? data.code : null;
}

function getGuidanceFieldError(error: unknown): string | null {
  const fieldErrors = getApiErrorData(error)?.fieldErrors;
  if (typeof fieldErrors !== 'object' || fieldErrors === null || !('guidance' in fieldErrors)) return null;
  return typeof fieldErrors.guidance === 'string' ? fieldErrors.guidance : null;
}

export function ReturnLessonDialog({
  lesson,
  onClose,
  onReload,
  onConfirm,
  onComplete,
  onRegisterNavigationCloseRequest,
}: ReturnLessonDialogProps) {
  const [currentLesson, setCurrentLesson] = useState(lesson);
  const [version, setVersion] = useState(lesson.version);
  const [guidance, setGuidance] = useState('');
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [hasVersionConflict, setHasVersionConflict] = useState(false);
  const [isAwaitingEvaluation, setIsAwaitingEvaluation] = useState(lesson.status === 'PMOEvaluation');
  const [isReloading, setIsReloading] = useState(false);
  const [isReturning, setIsReturning] = useState(false);
  const [completedReloads, setCompletedReloads] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const guidanceRef = useRef<HTMLTextAreaElement>(null);

  useDialogFocus(dialogRef, guidanceRef);

  useEffect(() => {
    if (completedReloads > 0 && !isReloading) guidanceRef.current?.focus();
  }, [completedReloads, isReloading]);

  const requestClose = useCallback(() => {
    if (isReturning || isReloading) return false;
    if (guidance.length > 0 && !window.confirm('Discard your return guidance?')) return false;
    onClose();
    return true;
  }, [guidance.length, isReloading, isReturning, onClose]);

  useEffect(() => {
    onRegisterNavigationCloseRequest?.(requestClose);
    return () => onRegisterNavigationCloseRequest?.(null);
  }, [onRegisterNavigationCloseRequest, requestClose]);

  async function reloadCurrentLesson() {
    if (isReloading || isReturning) return;
    setIsReloading(true);
    setRequestError(null);
    try {
      const latest = await onReload(currentLesson.id);
      setCurrentLesson(latest);
      setVersion(latest.version);
      setHasVersionConflict(false);
      setIsAwaitingEvaluation(latest.status === 'PMOEvaluation');
      setRequestError(latest.status === 'PMOEvaluation'
        ? 'Review the current lesson and confirm the return again. Your guidance is still here.'
        : 'This lesson is no longer awaiting evaluation. Your guidance is still here.');
    } catch {
      setRequestError('The latest lesson could not be loaded. Your guidance is still here; try reloading again.');
    } finally {
      setIsReloading(false);
      setCompletedReloads((reloads) => reloads + 1);
    }
  }

  async function confirmReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isReturning || isReloading || hasVersionConflict || !isAwaitingEvaluation) return;
    if (!guidance.trim()) {
      setGuidanceError('Enter guidance for the author.');
      setRequestError(null);
      guidanceRef.current?.focus();
      return;
    }

    setIsReturning(true);
    setGuidanceError(null);
    setRequestError(null);
    try {
      await onConfirm(currentLesson.id, { version, guidance });
      onComplete();
    } catch (error) {
      setGuidanceError(getGuidanceFieldError(error));
      const errorCode = getApiErrorCode(error);
      if (errorCode === 'STALE_LESSON_VERSION') {
        setHasVersionConflict(true);
        setRequestError('This lesson changed after you opened it. Reload the current version before confirming again. Your guidance is still here.');
      } else if (errorCode === 'LESSON_NOT_AWAITING_EVALUATION') {
        setIsAwaitingEvaluation(false);
        setRequestError('This lesson is no longer awaiting evaluation. Reload the current version before returning it. Your guidance is still here.');
      } else {
        setRequestError('The lesson could not be returned. Your guidance is still here; try again.');
      }
    } finally {
      setIsReturning(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="draft-editor-dialog"
      aria-modal="true"
      aria-labelledby="return-lesson-title"
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
      <form className="draft-editor-form" noValidate onSubmit={(event) => void confirmReturn(event)}>
        <div className="draft-editor-heading">
          <div>
            <p className="draft-editor-eyebrow">Lesson #{currentLesson.id} · {currentLesson.status}</p>
            <h2 id="return-lesson-title">Return lesson</h2>
          </div>
          <button className="draft-editor-close" type="button" aria-label="Close return" disabled={isReturning || isReloading} onClick={requestClose}>
            ×
          </button>
        </div>
        <p>Return “{currentLesson.title}” to its author with the changes needed before it can be reviewed again.</p>
        <div className="draft-editor-field">
          <label htmlFor="lesson-return-guidance">Guidance for author</label>
          <textarea
            ref={guidanceRef}
            id="lesson-return-guidance"
            required
            maxLength={1000}
            value={guidance}
            aria-invalid={guidanceError ? 'true' : undefined}
            aria-describedby={guidanceError ? 'lesson-return-guidance-error' : 'lesson-return-guidance-count'}
            disabled={isReturning || isReloading}
            onChange={(event) => {
              setGuidance(event.target.value);
              setGuidanceError(null);
              setRequestError(null);
            }}
          />
          {guidanceError ? (
            <p id="lesson-return-guidance-error" className="draft-editor-error" role="alert">{guidanceError}</p>
          ) : (
            <p id="lesson-return-guidance-count" className="draft-editor-counter">{guidance.length}/1,000 characters</p>
          )}
        </div>
        {requestError && <p className="draft-editor-error" role="alert">{requestError}</p>}
        {(hasVersionConflict || !isAwaitingEvaluation) && (
          <button className="draft-editor-secondary" type="button" disabled={isReturning || isReloading} onClick={() => void reloadCurrentLesson()}>
            {isReloading ? 'Reloading…' : 'Reload current version'}
          </button>
        )}
        <div className="draft-editor-actions">
          <button className="draft-editor-secondary" type="button" disabled={isReturning || isReloading} onClick={requestClose}>Keep in queue</button>
          <button className="draft-editor-primary" type="submit" disabled={isReturning || isReloading || hasVersionConflict || !isAwaitingEvaluation}>
            {isReturning ? 'Returning…' : 'Confirm return'}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
