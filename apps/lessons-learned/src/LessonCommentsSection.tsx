import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  createLessonComment,
  createLessonCommentReply,
  getLessonComments,
  hideLessonComment,
  type LessonCommentItem,
} from './api';

type LessonCommentsSectionProps = {
  lessonId: number;
  profileId: string;
  isPmo: boolean;
  initialPublicCommentCount: number;
  onPublicCommentCountChange?: (lessonId: number, publicCommentCount: number) => void;
};

const MAX_COMMENT_LENGTH = 2000;
const MAX_MODERATION_REASON_LENGTH = 1000;
const COMMENTS_PAGE_LIMIT = 20;

function formatTimestampUtc(value: string): string {
  const formatted = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
  return `${formatted} UTC`;
}

function getFieldError(error: unknown, field: string): string | null {
  if (typeof error !== 'object' || error === null || !('response' in error)) return null;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return null;
  const data = response.data;
  if (typeof data !== 'object' || data === null || !('fieldErrors' in data)) return null;
  const fieldErrors = data.fieldErrors;
  if (typeof fieldErrors !== 'object' || fieldErrors === null || !(field in fieldErrors)) return null;
  const value = (fieldErrors as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

export function LessonCommentsSection({
  lessonId,
  profileId,
  isPmo,
  initialPublicCommentCount,
  onPublicCommentCountChange,
}: LessonCommentsSectionProps) {
  const queryClient = useQueryClient();
  const [showHidden, setShowHidden] = useState(false);

  const [newCommentBody, setNewCommentBody] = useState('');
  const [newCommentError, setNewCommentError] = useState<string | null>(null);
  const [isPostingComment, setIsPostingComment] = useState(false);
  const newCommentRef = useRef<HTMLTextAreaElement>(null);

  const [replyTargetId, setReplyTargetId] = useState<number | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);
  const [isPostingReply, setIsPostingReply] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const [hideTargetId, setHideTargetId] = useState<number | null>(null);
  const [hideReason, setHideReason] = useState('');
  const [hideError, setHideError] = useState<string | null>(null);
  const [isHiding, setIsHiding] = useState(false);
  const hideReasonRef = useRef<HTMLTextAreaElement>(null);

  const effectiveShowHidden = isPmo && showHidden;
  const queryKey = ['lessons-learned-comments', profileId, lessonId, effectiveShowHidden] as const;

  const commentsQuery = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      getLessonComments(profileId, lessonId, {
        limit: COMMENTS_PAGE_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
        ...(effectiveShowHidden ? { includeHidden: 'true' } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage?.page?.nextCursor ?? undefined,
  });

  const pages = commentsQuery.data?.pages.filter((page) => Boolean(page && Array.isArray(page.items))) ?? [];
  const threads = pages.flatMap((page) => page.items);
  const latestPublicCount = pages.length > 0 ? pages[pages.length - 1].publicCommentCount : initialPublicCommentCount;

  useEffect(() => {
    if (pages.length > 0) {
      onPublicCommentCountChange?.(lessonId, latestPublicCount);
    }
  }, [lessonId, latestPublicCount, onPublicCommentCountChange, pages.length]);

  async function refreshComments() {
    await queryClient.invalidateQueries({
      queryKey: ['lessons-learned-comments', profileId, lessonId],
    });
  }

  async function handleCreateComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPostingComment) return;
    if (!newCommentBody.trim()) {
      setNewCommentError('Enter a comment before posting.');
      newCommentRef.current?.focus();
      return;
    }
    if (newCommentBody.length > MAX_COMMENT_LENGTH) {
      setNewCommentError('Comments must be 2,000 characters or fewer.');
      newCommentRef.current?.focus();
      return;
    }

    setIsPostingComment(true);
    setNewCommentError(null);
    try {
      await createLessonComment(profileId, lessonId, { body: newCommentBody });
      setNewCommentBody('');
      await refreshComments();
    } catch (error) {
      setNewCommentError(
        getFieldError(error, 'body') ?? 'Your comment could not be posted. Your text is still here; try again.',
      );
    } finally {
      setIsPostingComment(false);
    }
  }

  async function handleCreateReply(event: FormEvent<HTMLFormElement>, parentCommentId: number) {
    event.preventDefault();
    if (isPostingReply) return;
    if (!replyBody.trim()) {
      setReplyError('Enter a reply before posting.');
      replyRef.current?.focus();
      return;
    }
    if (replyBody.length > MAX_COMMENT_LENGTH) {
      setReplyError('Replies must be 2,000 characters or fewer.');
      replyRef.current?.focus();
      return;
    }

    setIsPostingReply(true);
    setReplyError(null);
    try {
      await createLessonCommentReply(profileId, lessonId, parentCommentId, { body: replyBody });
      setReplyBody('');
      setReplyTargetId(null);
      await refreshComments();
    } catch (error) {
      setReplyError(
        getFieldError(error, 'body') ?? 'Your reply could not be posted. Your text is still here; try again.',
      );
    } finally {
      setIsPostingReply(false);
    }
  }

  async function handleHideComment(event: FormEvent<HTMLFormElement>, commentId: number) {
    event.preventDefault();
    if (isHiding) return;
    if (!hideReason.trim()) {
      setHideError('Enter a reason for hiding this comment.');
      hideReasonRef.current?.focus();
      return;
    }
    if (hideReason.length > MAX_MODERATION_REASON_LENGTH) {
      setHideError('Moderation reason must be 1,000 characters or fewer.');
      hideReasonRef.current?.focus();
      return;
    }

    setIsHiding(true);
    setHideError(null);
    try {
      await hideLessonComment(profileId, lessonId, commentId, { reason: hideReason });
      setHideReason('');
      setHideTargetId(null);
      await refreshComments();
    } catch (error) {
      setHideError(
        getFieldError(error, 'reason') ?? 'The comment could not be hidden. Your reason is still here; try again.',
      );
    } finally {
      setIsHiding(false);
    }
  }

  function renderModerationAudit(item: LessonCommentItem) {
    if (!item.isHidden || !item.moderation) return null;
    return (
      <div className="comment-moderation-audit">
        <p><strong>Hidden by PMO</strong></p>
        <p>Reason: {item.moderation.reason}</p>
        <p>
          Moderated by: {item.moderation.hiddenByDisplayName} ·{' '}
          <time dateTime={item.moderation.hiddenAt}>{formatTimestampUtc(item.moderation.hiddenAt)}</time>
        </p>
      </div>
    );
  }

  function renderHideForm(commentId: number) {
    if (!isPmo || hideTargetId !== commentId) return null;
    return (
      <form className="comment-inline-form" noValidate onSubmit={(event) => void handleHideComment(event, commentId)}>
        <div className="draft-editor-field">
          <label htmlFor={`hide-comment-reason-${commentId}`}>Reason for hiding</label>
          <textarea
            ref={hideReasonRef}
            id={`hide-comment-reason-${commentId}`}
            required
            value={hideReason}
            aria-invalid={hideError ? 'true' : undefined}
            aria-describedby={hideError ? `hide-comment-error-${commentId}` : `hide-comment-count-${commentId}`}
            disabled={isHiding}
            onChange={(event) => {
              setHideReason(event.target.value);
              setHideError(null);
            }}
          />
          {hideError ? (
            <p id={`hide-comment-error-${commentId}`} className="draft-editor-error" role="alert">{hideError}</p>
          ) : (
            <p id={`hide-comment-count-${commentId}`} className="draft-editor-counter">
              {hideReason.length}/1,000 characters
            </p>
          )}
        </div>
        <div className="comment-inline-actions">
          <button
            className="draft-editor-secondary"
            type="button"
            disabled={isHiding}
            onClick={() => {
              setHideTargetId(null);
              setHideReason('');
              setHideError(null);
            }}
          >
            Cancel
          </button>
          <button className="draft-editor-primary" type="submit" disabled={isHiding}>
            {isHiding ? 'Hiding…' : 'Confirm hide'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <section className="lesson-comments" aria-labelledby="lesson-comments-title">
      <div className="lesson-comments-header">
        <h3 id="lesson-comments-title">Comments ({latestPublicCount})</h3>
        {isPmo && (
          <label className="comments-audit-toggle">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => {
                setShowHidden(event.target.checked);
                setHideTargetId(null);
                setHideReason('');
                setHideError(null);
              }}
            />
            <span>Show hidden comments</span>
          </label>
        )}
      </div>

      <form className="comment-composer" noValidate onSubmit={(event) => void handleCreateComment(event)}>
        <div className="draft-editor-field">
          <label htmlFor={`new-comment-${lessonId}`}>Add a comment</label>
          <textarea
            ref={newCommentRef}
            id={`new-comment-${lessonId}`}
            value={newCommentBody}
            aria-invalid={newCommentError ? 'true' : undefined}
            aria-describedby={newCommentError ? `new-comment-error-${lessonId}` : `new-comment-count-${lessonId}`}
            disabled={isPostingComment}
            onChange={(event) => {
              setNewCommentBody(event.target.value);
              setNewCommentError(null);
            }}
          />
          {newCommentError ? (
            <p id={`new-comment-error-${lessonId}`} className="draft-editor-error" role="alert">{newCommentError}</p>
          ) : (
            <p id={`new-comment-count-${lessonId}`} className="draft-editor-counter">
              {newCommentBody.length}/2,000 characters
            </p>
          )}
        </div>
        <div className="comment-inline-actions">
          <button className="draft-editor-primary" type="submit" disabled={isPostingComment}>
            {isPostingComment ? 'Posting…' : 'Post comment'}
          </button>
        </div>
      </form>

      {commentsQuery.isLoading && <p role="status">Loading comments…</p>}
      {commentsQuery.isError && (
        <div className="draft-error" role="alert">
          <p>Comments could not be loaded.</p>
          <button className="draft-cancel" type="button" onClick={() => void commentsQuery.refetch()}>Retry</button>
        </div>
      )}
      {commentsQuery.isSuccess && threads.length === 0 && (
        <p className="draft-empty">No comments yet.</p>
      )}
      {threads.length > 0 && (
        <ol className="comment-thread-list">
          {threads.map((thread) => (
            <li key={thread.id} className={thread.isHidden ? 'comment-thread comment-thread-hidden' : 'comment-thread'}>
              {thread.isHidden && !effectiveShowHidden ? (
                <p className="comment-hidden-placeholder">Comment hidden by PMO</p>
              ) : (
                <div className="comment-card">
                  <p className="comment-meta">
                    <strong>{thread.authorDisplayName ?? thread.authorId}</strong> ·{' '}
                    <time dateTime={thread.createdAt}>{formatTimestampUtc(thread.createdAt)}</time>
                  </p>
                  <p className="comment-body">{thread.body}</p>
                  {renderModerationAudit(thread)}
                  {!thread.isHidden && (
                    <div className="comment-actions">
                      <button
                        className="draft-editor-secondary"
                        type="button"
                        onClick={() => {
                          setReplyTargetId(replyTargetId === thread.id ? null : thread.id);
                          setReplyBody('');
                          setReplyError(null);
                        }}
                      >
                        Reply
                      </button>
                      {isPmo && (
                        <button
                          className="draft-editor-secondary"
                          type="button"
                          onClick={() => {
                            setHideTargetId(hideTargetId === thread.id ? null : thread.id);
                            setHideReason('');
                            setHideError(null);
                          }}
                        >
                          Hide comment
                        </button>
                      )}
                    </div>
                  )}
                  {renderHideForm(thread.id)}
                  {!thread.isHidden && replyTargetId === thread.id && (
                    <form
                      className="comment-inline-form"
                      noValidate
                      onSubmit={(event) => void handleCreateReply(event, thread.id)}
                    >
                      <div className="draft-editor-field">
                        <label htmlFor={`reply-body-${thread.id}`}>Write a reply</label>
                        <textarea
                          ref={replyRef}
                          id={`reply-body-${thread.id}`}
                          value={replyBody}
                          aria-invalid={replyError ? 'true' : undefined}
                          aria-describedby={replyError ? `reply-error-${thread.id}` : `reply-count-${thread.id}`}
                          disabled={isPostingReply}
                          onChange={(event) => {
                            setReplyBody(event.target.value);
                            setReplyError(null);
                          }}
                        />
                        {replyError ? (
                          <p id={`reply-error-${thread.id}`} className="draft-editor-error" role="alert">{replyError}</p>
                        ) : (
                          <p id={`reply-count-${thread.id}`} className="draft-editor-counter">
                            {replyBody.length}/2,000 characters
                          </p>
                        )}
                      </div>
                      <div className="comment-inline-actions">
                        <button
                          className="draft-editor-secondary"
                          type="button"
                          disabled={isPostingReply}
                          onClick={() => {
                            setReplyTargetId(null);
                            setReplyBody('');
                            setReplyError(null);
                          }}
                        >
                          Cancel
                        </button>
                        <button className="draft-editor-primary" type="submit" disabled={isPostingReply}>
                          {isPostingReply ? 'Posting…' : 'Post reply'}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {thread.replies.length > 0 && (
                <ol className="comment-reply-list">
                  {thread.replies.map((reply) => (
                    <li key={reply.id} className={reply.isHidden ? 'comment-reply comment-reply-hidden' : 'comment-reply'}>
                      <p className="comment-meta">
                        <strong>{reply.authorDisplayName ?? reply.authorId}</strong> ·{' '}
                        <time dateTime={reply.createdAt}>{formatTimestampUtc(reply.createdAt)}</time>
                      </p>
                      <p className="comment-body">{reply.body}</p>
                      {renderModerationAudit(reply)}
                      {isPmo && !reply.isHidden && (
                        <div className="comment-actions">
                          <button
                            className="draft-editor-secondary"
                            type="button"
                            onClick={() => {
                              setHideTargetId(hideTargetId === reply.id ? null : reply.id);
                              setHideReason('');
                              setHideError(null);
                            }}
                          >
                            Hide reply
                          </button>
                        </div>
                      )}
                      {renderHideForm(reply.id)}
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ol>
      )}

      {commentsQuery.hasNextPage && (
        <div className="comments-load-more">
          {commentsQuery.isFetchNextPageError && (
            <p className="draft-editor-error" role="alert">More comments could not be loaded.</p>
          )}
          <button
            className="draft-editor-secondary"
            type="button"
            disabled={commentsQuery.isFetchingNextPage}
            onClick={() => void commentsQuery.fetchNextPage()}
          >
            {commentsQuery.isFetchingNextPage ? 'Loading more…' : 'Load more comments'}
          </button>
        </div>
      )}
    </section>
  );
}
