import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BellIcon,
  ClockIcon,
  CompassIcon,
  InboxIcon,
  UserIcon,
} from '../../shared-ui/src/Icons';
import type { HomeLessonSummary, HomeResponse, HomeTargetPage } from './api';

interface HomeViewProps {
  home: HomeResponse;
  showOverview: boolean;
  /** Opens Lesson Detail through the operational path that never records a view (D7). */
  onOpenLesson: (lessonId: number) => void;
  onNavigate: (targetPage: HomeTargetPage) => void;
}

const STATUS_LABELS: Record<HomeLessonSummary['status'], string> = {
  Open: 'Open',
  PMOEvaluation: 'PMO Evaluation',
  Approved: 'Approved',
  Closed: 'Closed',
  Archived: 'Archived',
};

function formatTimestamp(timestamp: string): string {
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(timestamp))} UTC`;
}

function getRoleLabel(role: HomeResponse['profile']['role']): string {
  return role === 'LESSONS_MODERATOR' ? 'PMO' : 'Contributor';
}

function LessonButton({ lesson, onOpenLesson }: { lesson: HomeLessonSummary; onOpenLesson: (lessonId: number) => void }) {
  return (
    <button
      className="submission-title-link"
      type="button"
      data-lesson-view-id={lesson.id}
      onClick={() => onOpenLesson(lesson.id)}
    >
      #{lesson.id} · {lesson.title}
    </button>
  );
}

export function HomeView({ home, showOverview, onOpenLesson, onNavigate }: HomeViewProps) {
  return (
    <div className="home-view">
      <div className="home-header">
        <div>
          <h1 id="page-title" tabIndex={-1}>Home</h1>
          <div className="home-welcome-meta">
            <p className="intro">Welcome, {home.profile.displayName}</p>
            <p className="active-role">
              <UserIcon size={14} />
              <span>Active role: <strong>{getRoleLabel(home.profile.role)}</strong></span>
            </p>
          </div>
        </div>
      </div>

      {showOverview && <HomeOverview home={home} onOpenLesson={onOpenLesson} onNavigate={onNavigate} />}

      <a className="primary-link home-back-link ui-inline-btn" href="/">
        <ArrowLeftIcon size={15} />
        <span>Back to PMO Hub</span>
      </a>
    </div>
  );
}

function HomeOverview({ home, onOpenLesson, onNavigate }: Pick<HomeViewProps, 'home' | 'onOpenLesson' | 'onNavigate'>) {
  const isPmo = home.profile.role === 'LESSONS_MODERATOR';
  const { primaryAction, highlights, notifications, recentWork, shortcuts } = home;

  function runPrimaryAction() {
    if (primaryAction.lessonId !== null) onOpenLesson(primaryAction.lessonId);
    else onNavigate(primaryAction.targetPage);
  }

  return (
    <>
      <section className="home-primary-action" aria-labelledby="home-primary-action-title">
        <div className="home-primary-action__copy">
          <h2 id="home-primary-action-title" className="home-section-heading">
            <CompassIcon size={18} />
            <span>Recommended next action</span>
          </h2>
          <p>{primaryAction.description}</p>
        </div>
        <button className="draft-action home-primary-button ui-inline-btn" type="button" onClick={runPrimaryAction}>
          <span>{primaryAction.label}</span>
          <ArrowRightIcon size={15} />
        </button>
      </section>

      <div className="home-grid">
        {isPmo ? (
          <section className="home-card" aria-labelledby="home-pending-title">
            <h2 id="home-pending-title" className="home-card__heading">
              <InboxIcon size={16} />
              <span>Pending PMO evaluation</span>
            </h2>
            <p className="home-card-count">
              {highlights.pendingEvaluationCount === 1
                ? '1 lesson awaiting evaluation'
                : `${highlights.pendingEvaluationCount} lessons awaiting evaluation`}
            </p>
            {highlights.pendingEvaluationLessons.length === 0 ? (
              <p className="draft-empty">No lessons are awaiting evaluation.</p>
            ) : (
              <ul className="home-list">
                {highlights.pendingEvaluationLessons.map((lesson) => (
                  <li key={lesson.id}>
                    <LessonButton lesson={lesson} onOpenLesson={onOpenLesson} />
                    <span className="library-description">
                      {lesson.authorName ?? lesson.authorId}
                      {lesson.projectName ? ` · ${lesson.projectName}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <section className="home-card" aria-labelledby="home-returned-title">
            <h2 id="home-returned-title" className="home-card__heading">
              <AlertTriangleIcon size={16} />
              <span>Returned lessons</span>
            </h2>
            <p className="home-card-count">
              {highlights.returnedCount === 1
                ? '1 lesson returned for changes'
                : `${highlights.returnedCount} lessons returned for changes`}
            </p>
            {highlights.returnedLessons.length === 0 ? (
              <p className="draft-empty">No lessons are waiting for your updates.</p>
            ) : (
              <ul className="home-list">
                {highlights.returnedLessons.map((lesson) => (
                  <li key={lesson.id}>
                    <LessonButton lesson={lesson} onOpenLesson={onOpenLesson} />
                    {lesson.latestReviewGuidance && (
                      <span className="library-description">{lesson.latestReviewGuidance}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="home-card" aria-labelledby="home-notifications-title">
          <h2 id="home-notifications-title" className="home-card__heading">
            <BellIcon size={16} />
            <span>Unread notifications summary</span>
          </h2>
          <p className="home-card-count">{notifications.unreadCount} unread</p>
          {notifications.items.length === 0 ? (
            <p className="draft-empty">You are all caught up.</p>
          ) : (
            <ul className="home-list">
              {notifications.items.map((item) => (
                <li key={item.id}>
                  <button className="submission-title-link" type="button" onClick={() => onOpenLesson(item.lessonId)}>
                    #{item.lessonId} · {item.lessonTitle}
                  </button>
                  <span className="library-description">{item.summary}</span>
                  <span className="library-description">{formatTimestamp(item.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="home-card" aria-labelledby="home-recent-title">
          <h2 id="home-recent-title" className="home-card__heading">
            <ClockIcon size={16} />
            <span>Recent work</span>
          </h2>
          {recentWork.length === 0 ? (
            <p className="draft-empty">No recent work yet.</p>
          ) : (
            <ul className="home-list">
              {recentWork.map((lesson) => (
                <li key={lesson.id}>
                  <LessonButton lesson={lesson} onOpenLesson={onOpenLesson} />
                  <span className="library-description">
                    {lesson.isReturned ? 'Returned' : STATUS_LABELS[lesson.status]} · Updated {formatTimestamp(lesson.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="home-card" aria-labelledby="home-shortcuts-title">
        <h2 id="home-shortcuts-title">Quick shortcuts</h2>
        <ul className="home-shortcuts">
          {shortcuts.map((shortcut) => (
            <li key={shortcut.id}>
              <button className="home-shortcut" type="button" onClick={() => onNavigate(shortcut.targetPage)}>
                <span className="home-shortcut__top">
                  <strong>{shortcut.label}</strong>
                  <ArrowRightIcon size={14} className="ui-icon home-shortcut__arrow" />
                </span>
                <span className="library-description">{shortcut.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
