import type { ReactNode } from 'react';
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  FileTextIcon,
  InboxIcon,
  PlusIcon,
} from '../../shared-ui/src/Icons';
import type { HomeLessonSummary, HomeResponse, HomeTargetPage } from './api';

interface HomeViewProps {
  home: HomeResponse;
  showOverview: boolean;
  /** Opens Lesson Detail through the operational path that never records a view (D7). */
  onOpenLesson: (lessonId: number) => void;
  onNavigate: (targetPage: HomeTargetPage) => void;
}

function formatTimestamp(timestamp: string): string {
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(timestamp))} UTC`;
}

function formatFeedDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dateUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const diffDays = Math.round((todayUtc - dateUtc) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays <= 14) return `${diffDays} days ago`;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

interface PendingSectionProps {
  headingId: string;
  title: string;
  count: number;
  viewAllTarget: HomeTargetPage;
  emptyMessage: string;
  lessons: HomeLessonSummary[];
  statusLabel: string;
  statusTone: 'evaluation' | 'returned' | 'draft';
  showAuthor?: boolean;
  icon: ReactNode;
  onOpenLesson: (lessonId: number) => void;
  onNavigate: (targetPage: HomeTargetPage) => void;
}

function PendingActivitySection({
  headingId,
  title,
  count,
  viewAllTarget,
  emptyMessage,
  lessons,
  statusLabel,
  statusTone,
  showAuthor = false,
  icon,
  onOpenLesson,
  onNavigate,
}: PendingSectionProps) {
  return (
    <section className="home-section" aria-labelledby={headingId}>
      <div className="home-section__header">
        <div className="home-section__title-group">
          <h2 id={headingId}>{title}</h2>
          <span className="home-section__count" aria-label={`${count} items`}>{count}</span>
        </div>
        <button
          className="home-section__view-all"
          type="button"
          onClick={() => onNavigate(viewAllTarget)}
        >
          View all
        </button>
      </div>

      <div className="home-activity-box">
        {lessons.length === 0 ? (
          <p className="home-activity-empty">{emptyMessage}</p>
        ) : (
          <ul className="home-activity-list">
            {lessons.map((lesson) => {
              const metaParts = [
                `#${lesson.id}`,
                showAuthor ? (lesson.authorName ?? lesson.authorId) : null,
                lesson.projectName,
                `Updated ${formatTimestamp(lesson.updatedAt)}`,
              ].filter(Boolean);

              return (
                <li key={lesson.id} className="home-activity-item">
                  <span className={`home-activity-item__icon home-activity-item__icon--${statusTone}`} aria-hidden="true">
                    {icon}
                  </span>
                  <div className="home-activity-item__body">
                    <div className="home-activity-item__title-row">
                      <button
                        className="submission-title-link"
                        type="button"
                        data-lesson-view-id={lesson.id}
                        onClick={() => onOpenLesson(lesson.id)}
                      >
                        #{lesson.id} · {lesson.title}
                      </button>
                      <span className={`lesson-status-pill lesson-status-pill--${statusTone === 'draft' ? 'open' : statusTone}`}>
                        {statusLabel}
                      </span>
                    </div>
                    {statusTone === 'returned' && lesson.latestReviewGuidance && (
                      <p className="home-activity-item__guidance">{lesson.latestReviewGuidance}</p>
                    )}
                    <p className="home-activity-item__meta">{metaParts.join(' · ')}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export function HomeView({ home, showOverview, onOpenLesson, onNavigate }: HomeViewProps) {
  const isPmo = home.profile.role === 'LESSONS_MODERATOR';
  const highlights = home.highlights;
  const openDraftOnlyCount = highlights
    ? Math.max(0, highlights.openDraftCount - highlights.returnedCount)
    : 0;
  const openDraftLessons = highlights?.openDraftLessons ?? [];
  const recentlyApprovedLessons = home.recentlyApprovedLessons ?? [];

  return (
    <div className={showOverview ? 'home-view home-layout' : 'home-view'}>
      <div className="home-main">
        <div className="home-header">
          <div>
            <h1 id="page-title" tabIndex={-1}>Home</h1>
            <p className="intro">Welcome, {home.profile.displayName}</p>
          </div>
          {showOverview && (
            <button
              className="draft-action home-primary-button ui-inline-btn"
              type="button"
              onClick={() => onNavigate('create-lesson')}
            >
              <PlusIcon size={15} />
              <span>Create lesson</span>
            </button>
          )}
        </div>

        {showOverview && highlights && (
          <div className="home-activities">
            {isPmo ? (
              <>
                <PendingActivitySection
                  headingId="home-pending-title"
                  title="Pending PMO evaluation"
                  count={highlights.pendingEvaluationCount}
                  viewAllTarget="evaluation-queue"
                  emptyMessage="No lessons are awaiting PMO evaluation."
                  lessons={highlights.pendingEvaluationLessons}
                  statusLabel="PMO Evaluation"
                  statusTone="evaluation"
                  showAuthor
                  icon={<InboxIcon size={16} />}
                  onOpenLesson={onOpenLesson}
                  onNavigate={onNavigate}
                />
                {highlights.returnedCount > 0 && (
                  <PendingActivitySection
                    headingId="home-returned-title"
                    title="Returned for changes"
                    count={highlights.returnedCount}
                    viewAllTarget="my-submissions"
                    emptyMessage="No lessons are waiting for your updates."
                    lessons={highlights.returnedLessons}
                    statusLabel="Returned"
                    statusTone="returned"
                    icon={<AlertTriangleIcon size={16} />}
                    onOpenLesson={onOpenLesson}
                    onNavigate={onNavigate}
                  />
                )}
                <PendingActivitySection
                  headingId="home-drafts-title"
                  title="Open drafts"
                  count={openDraftOnlyCount}
                  viewAllTarget="pmo-drafts"
                  emptyMessage="No open drafts."
                  lessons={openDraftLessons}
                  statusLabel="Draft"
                  statusTone="draft"
                  icon={<FileTextIcon size={16} />}
                  onOpenLesson={onOpenLesson}
                  onNavigate={onNavigate}
                />
              </>
            ) : (
              <>
                <PendingActivitySection
                  headingId="home-returned-title"
                  title="Returned for changes"
                  count={highlights.returnedCount}
                  viewAllTarget="my-submissions"
                  emptyMessage="No lessons are waiting for your updates."
                  lessons={highlights.returnedLessons}
                  statusLabel="Returned"
                  statusTone="returned"
                  icon={<AlertTriangleIcon size={16} />}
                  onOpenLesson={onOpenLesson}
                  onNavigate={onNavigate}
                />
                <PendingActivitySection
                  headingId="home-drafts-title"
                  title="Open drafts"
                  count={openDraftOnlyCount}
                  viewAllTarget="my-submissions"
                  emptyMessage="No open drafts."
                  lessons={openDraftLessons}
                  statusLabel="Draft"
                  statusTone="draft"
                  icon={<FileTextIcon size={16} />}
                  onOpenLesson={onOpenLesson}
                  onNavigate={onNavigate}
                />
              </>
            )}
          </div>
        )}

        <a className="primary-link home-back-link ui-inline-btn" href="/">
          <ArrowLeftIcon size={15} />
          <span>Back to PMO Hub</span>
        </a>
      </div>

      {showOverview && (
        <aside className="home-feed-sidebar">
          <section className="home-feed-card" aria-labelledby="home-approved-feed-title">
            <h2 id="home-approved-feed-title" className="home-feed-card__title">
              Latest approved by PMO
            </h2>

            {recentlyApprovedLessons.length === 0 ? (
              <p className="home-feed-empty">No lessons have been approved by the PMO yet.</p>
            ) : (
              <ol className="home-feed-timeline">
                {recentlyApprovedLessons.map((lesson) => {
                  const approvedTimestamp = lesson.approvedAt ?? lesson.updatedAt;
                  const metaParts = [
                    lesson.projectName,
                    lesson.authorName ?? lesson.authorId,
                    lesson.lessonType,
                  ].filter(Boolean);

                  return (
                    <li key={lesson.id} className="home-feed-item">
                      <span className="home-feed-item__dot" aria-hidden="true" />
                      <time
                        className="home-feed-item__time"
                        dateTime={approvedTimestamp}
                        title={formatTimestamp(approvedTimestamp)}
                      >
                        {formatFeedDate(approvedTimestamp)}
                      </time>
                      <button
                        className="home-feed-item__title submission-title-link"
                        type="button"
                        data-lesson-view-id={lesson.id}
                        onClick={() => onOpenLesson(lesson.id)}
                      >
                        #{lesson.id} · {lesson.title}
                      </button>
                      {metaParts.length > 0 && (
                        <span className="home-feed-item__meta">{metaParts.join(' · ')}</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            <button
              className="home-feed-card__footer-link ui-inline-btn"
              type="button"
              onClick={() => onNavigate('library')}
            >
              <span>View Lessons Library</span>
              <ArrowRightIcon size={14} />
            </button>
          </section>
        </aside>
      )}
    </div>
  );
}
