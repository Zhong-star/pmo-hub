import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CancelLessonBody, LessonDetails, LessonDraft, RejectLessonBody } from './api';
import { LessonCommentsSection } from './LessonCommentsSection';
import { useDialogFocus } from './useDialogFocus';
import './DraftEditor.css';

type CancelLessonDialogProps = {
  draft: LessonDraft;
  onClose: () => void;
  onReload: (lessonId: number) => Promise<LessonDraft>;
  onConfirm: (lessonId: number, input: CancelLessonBody) => Promise<LessonDraft>;
  onRegisterNavigationCloseRequest?: (requestClose: (() => boolean) | null) => void;
};

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
  if (typeof error !== 'object' || error === null) return null;
  if ('response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const data = response.data;
      if (typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string') {
        return data.code;
      }
    }
  }
  return 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function formatTimestampUtc(value: string): string {
  const formatted = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
  return `${formatted} UTC`;
}

export function CancelLessonDialog({ draft, onClose, onReload, onConfirm, onRegisterNavigationCloseRequest }: CancelLessonDialogProps) {
  const [currentDraft, setCurrentDraft] = useState(draft);
  const [version, setVersion] = useState(draft.version);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [hasVersionConflict, setHasVersionConflict] = useState(false);
  const [isDraftOpen, setIsDraftOpen] = useState(true);
  const [isReloading, setIsReloading] = useState(false);
  const [completedReloads, setCompletedReloads] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useDialogFocus(dialogRef, reasonRef);

  useEffect(() => {
    if (completedReloads > 0 && !isReloading) reasonRef.current?.focus();
  }, [completedReloads, isReloading]);

  const requestClose = useCallback(() => {
    if (isCancelling || isReloading) return false;
    if (reason.length > 0 && !window.confirm('Discard your cancellation reason?')) return false;
    onClose();
    return true;
  }, [isCancelling, isReloading, onClose, reason]);

  useEffect(() => {
    onRegisterNavigationCloseRequest?.(requestClose);
    return () => onRegisterNavigationCloseRequest?.(null);
  }, [onRegisterNavigationCloseRequest, requestClose]);

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
      setCompletedReloads((reloads) => reloads + 1);
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
      await onConfirm(currentDraft.id, { version, reason, ...(currentDraft.etag ? { etag: currentDraft.etag } : {}) });
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

type RejectLessonDialogProps = {
  draft: LessonDraft;
  onClose: () => void;
  onReload: (lessonId: number) => Promise<LessonDraft>;
  onConfirm: (lessonId: number, input: RejectLessonBody) => Promise<LessonDraft>;
  onRegisterNavigationCloseRequest?: (requestClose: (() => boolean) | null) => void;
};

export function RejectLessonDialog({ draft, onClose, onReload, onConfirm, onRegisterNavigationCloseRequest }: RejectLessonDialogProps) {
  const [currentDraft, setCurrentDraft] = useState(draft);
  const [version, setVersion] = useState(draft.version);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [hasVersionConflict, setHasVersionConflict] = useState(false);
  const [isAwaitingEvaluation, setIsAwaitingEvaluation] = useState(true);
  const [isReloading, setIsReloading] = useState(false);
  const [completedReloads, setCompletedReloads] = useState(0);
  const [isRejecting, setIsRejecting] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useDialogFocus(dialogRef, reasonRef);

  useEffect(() => {
    if (completedReloads > 0 && !isReloading) reasonRef.current?.focus();
  }, [completedReloads, isReloading]);

  const requestClose = useCallback(() => {
    if (isRejecting || isReloading) return false;
    if (reason.length > 0 && !window.confirm('Discard your rejection reason?')) return false;
    onClose();
    return true;
  }, [isRejecting, isReloading, onClose, reason]);

  useEffect(() => {
    onRegisterNavigationCloseRequest?.(requestClose);
    return () => onRegisterNavigationCloseRequest?.(null);
  }, [onRegisterNavigationCloseRequest, requestClose]);

  async function reloadCurrentEvaluation() {
    if (isReloading || isRejecting) return;
    setIsReloading(true);
    setRequestError(null);
    try {
      const latest = await onReload(currentDraft.id);
      setCurrentDraft(latest);
      setVersion(latest.version);
      setHasVersionConflict(false);
      setIsAwaitingEvaluation(true);
      setRequestError('Review the current lesson and confirm rejection again. Your reason is still here.');
    } catch (error) {
      if (getApiErrorCode(error) === 'LESSON_NOT_AWAITING_EVALUATION') {
        setIsAwaitingEvaluation(false);
        setRequestError('This lesson no longer awaits PMO evaluation and cannot be rejected. Your reason is still here.');
      } else {
        setRequestError('The latest evaluation could not be loaded. Your reason is still here; try reloading again.');
      }
    } finally {
      setIsReloading(false);
      setCompletedReloads((reloads) => reloads + 1);
    }
  }

  async function confirmRejection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isRejecting || isReloading || hasVersionConflict || !isAwaitingEvaluation) return;
    if (!reason.trim()) {
      setReasonError('Enter a reason for rejecting this lesson.');
      setRequestError(null);
      reasonRef.current?.focus();
      return;
    }

    setIsRejecting(true);
    setReasonError(null);
    setRequestError(null);
    try {
      await onConfirm(currentDraft.id, { version, reason, ...(currentDraft.etag ? { etag: currentDraft.etag } : {}) });
      onClose();
    } catch (error) {
      setReasonError(getReasonFieldError(error));
      const errorCode = getApiErrorCode(error);
      if (errorCode === 'STALE_LESSON_VERSION') {
        setHasVersionConflict(true);
        setRequestError('This lesson changed after you opened it. Reload the current version before confirming again. Your reason is still here.');
      } else if (errorCode === 'LESSON_NOT_AWAITING_EVALUATION') {
        setIsAwaitingEvaluation(false);
        setRequestError('This lesson no longer awaits PMO evaluation and cannot be rejected. Your reason is still here.');
      } else {
        setRequestError('The lesson could not be rejected. Your reason is still here; try again.');
      }
    } finally {
      setIsRejecting(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="draft-editor-dialog"
      aria-modal="true"
      aria-labelledby="reject-lesson-title"
      aria-describedby="reject-lesson-explanation"
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
      <form className="draft-editor-form" noValidate onSubmit={(event) => void confirmRejection(event)}>
        <div className="draft-editor-heading">
          <div>
            <p className="draft-editor-eyebrow">Lesson #{currentDraft.id} · PMO Evaluation</p>
            <h2 id="reject-lesson-title">Reject lesson</h2>
          </div>
          <button className="draft-editor-close" type="button" aria-label="Close rejection" disabled={isRejecting || isReloading} onClick={requestClose}>
            ×
          </button>
        </div>
        <p id="reject-lesson-explanation">This will archive “{currentDraft.title}”. The author can read the reason in My Submissions.</p>
        <div className="draft-editor-field">
          <label htmlFor="lesson-rejection-reason">Reason for rejection</label>
          <textarea
            ref={reasonRef}
            id="lesson-rejection-reason"
            required
            maxLength={1000}
            value={reason}
            aria-invalid={reasonError ? 'true' : undefined}
            aria-describedby={reasonError ? 'lesson-rejection-reason-error' : 'lesson-rejection-reason-count'}
            disabled={isRejecting || isReloading}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(null);
              setRequestError(null);
            }}
          />
          {reasonError ? (
            <p id="lesson-rejection-reason-error" className="draft-editor-error" role="alert">{reasonError}</p>
          ) : (
            <p id="lesson-rejection-reason-count" className="draft-editor-counter">{reason.length}/1,000 characters</p>
          )}
        </div>
        {requestError && <p className="draft-editor-error" role="alert">{requestError}</p>}
        {(hasVersionConflict || !isAwaitingEvaluation) && (
          <button className="draft-editor-secondary" type="button" disabled={isRejecting || isReloading} onClick={() => void reloadCurrentEvaluation()}>
            {isReloading ? 'Reloading…' : 'Reload current version'}
          </button>
        )}
        <div className="draft-editor-actions">
          <button className="draft-editor-secondary" type="button" disabled={isRejecting || isReloading} onClick={requestClose}>Keep review</button>
          <button className="draft-editor-primary" type="submit" disabled={isRejecting || isReloading || hasVersionConflict || !isAwaitingEvaluation}>
            {isRejecting ? 'Rejecting…' : 'Confirm rejection'}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

type LessonSubmissionDetailsDialogProps = {
  lessonId: number;
  details?: LessonDetails;
  isLoading: boolean;
  hasError: boolean;
  canEdit?: boolean;
  onEdit?: () => void;
  onRetry: () => void;
  onClose: () => void;
  onReturn?: (lesson: LessonDetails) => void;
  canApprove?: boolean;
  onApprove?: (lesson: LessonDetails) => void;
  canClose?: boolean;
  onCloseLesson?: (lesson: LessonDetails) => void;
  isLibrarySurface?: boolean;
  profileId?: string;
  isPmo?: boolean;
  onPublicCommentCountChange?: (lessonId: number, publicCommentCount: number) => void;
};

export function LessonSubmissionDetailsDialog({
  lessonId,
  details: lessonData,
  isLoading,
  hasError,
  canEdit = false,
  onEdit,
  onRetry,
  onClose,
  onReturn,
  canApprove = false,
  onApprove,
  canClose = false,
  onCloseLesson,
  isLibrarySurface = false,
  profileId,
  isPmo = false,
  onPublicCommentCountChange,
}: LessonSubmissionDetailsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lesson = hasError ? undefined : lessonData;

  useDialogFocus(dialogRef, closeRef);

  const fields: Array<[string, string]> = lesson ? [
    ['Title', lesson.title],
    ['Author', lesson.authorName ?? lesson.authorId],
    ['Updated by', lesson.updatedBy],
    ['Status', lesson.status],
    ['Project', lesson.projectName ?? 'No project'],
    ['Project category', lesson.projectCategory ?? 'Not provided'],
    ['Project phase', lesson.projectPhase ?? 'Not provided'],
    ['Situation observed', lesson.situationObserved ?? 'Not provided'],
    ...(lesson.rootCause?.trim() ? [['Root cause', lesson.rootCause] as [string, string]] : []),
    ['Lesson type', lesson.lessonType ?? 'Not provided'],
    ['Impact', lesson.impact ?? 'Not provided'],
    ['Recommendation', lesson.recommendation ?? 'Not provided'],
    ['Applicability', lesson.applicability ?? 'Not provided'],
  ] : [];
  const dates: Array<[string, string]> = lesson ? [
    ['Created', lesson.createdAt],
    ['Last updated', lesson.updatedAt],
    ...(lesson.approvedAt ? [['Approved', lesson.approvedAt] as [string, string]] : []),
  ] : [];

  return createPortal(
    <dialog
      ref={dialogRef}
      className="draft-editor-dialog"
      aria-modal="true"
      aria-labelledby="lesson-details-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="draft-editor-form">
        <div className="draft-editor-heading">
          <div>
            <p className="draft-editor-eyebrow">{isLibrarySurface ? 'Published lesson' : 'Lesson'} #{lesson?.id ?? lessonId}{lesson ? ` · ${lesson.status}` : ''}</p>
            <h2 id="lesson-details-title">{isLibrarySurface ? 'Published lesson details' : 'Lesson details'}</h2>
          </div>
          <button ref={closeRef} className="draft-editor-close" type="button" aria-label={isLibrarySurface ? 'Close published lesson details' : 'Close lesson details'} onClick={onClose}>
            ×
          </button>
        </div>
        {isLoading && <p role="status">Loading lesson details…</p>}
        {hasError && (
          <div className="draft-error" role="alert">
            <p>Lesson details and history could not be loaded.</p>
            <button className="draft-cancel" type="button" onClick={onRetry}>Retry</button>
          </div>
        )}
        {lesson && (
          <>
            <dl className="submission-detail-list">
              {fields.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              {dates.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd><time dateTime={value}>{formatTimestampUtc(value)}</time></dd>
                </div>
              ))}
            </dl>
            {lesson.history.length > 0 && (
              <section className="submission-history" aria-labelledby="lesson-history-title">
                <h3 id="lesson-history-title">History</h3>
                <ol>
                  {lesson.history.map((event) => (
                    <li key={event.id}>
                      <p><strong>{event.eventType}</strong> · {event.previousStatus ? `${event.previousStatus} → ` : ''}{event.newStatus}</p>
                      <p>{event.actorId} · <time dateTime={event.occurredAt}>{formatTimestampUtc(event.occurredAt)}</time></p>
                      {event.reason && <p>{getHistoryReasonLabel(event.eventType)}: {event.reason}</p>}
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {profileId && (
              <LessonCommentsSection
                lessonId={lesson.id}
                profileId={profileId}
                isPmo={isPmo}
                initialPublicCommentCount={lesson.commentCount ?? 0}
                onPublicCommentCountChange={onPublicCommentCountChange}
              />
            )}
          </>
        )}
        <div className="draft-editor-actions">
          {lesson && lesson.status === 'PMOEvaluation' && onReturn && (
            <button className="draft-editor-secondary" type="button" onClick={() => onReturn(lesson)}>
              Return for changes
            </button>
          )}
          {canApprove && lesson?.status === 'PMOEvaluation' && onApprove && (
            <button className="draft-editor-primary" type="button" onClick={() => onApprove(lesson)}>
              Approve and publish
            </button>
          )}
          {canEdit && onEdit && (
            <button className="draft-editor-primary" type="button" onClick={onEdit}>Edit lesson</button>
          )}
          {canClose && lesson?.status === 'Approved' && onCloseLesson && (
            <button className="draft-editor-primary" type="button" onClick={() => onCloseLesson(lesson)}>
              Close lesson
            </button>
          )}
          <button className="draft-editor-secondary" type="button" onClick={onClose}>{isLibrarySurface ? 'Back to Lessons Library' : 'Close details'}</button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

function getHistoryReasonLabel(eventType: string): string {
  switch (eventType) {
    case 'Cancelled': return 'Cancellation reason';
    case 'Returned': return 'PMO guidance';
    case 'Rejected': return 'Rejection reason';
    default: return 'Reason';
  }
}
