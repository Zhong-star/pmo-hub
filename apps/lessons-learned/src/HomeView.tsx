import type { Theme } from '../../shared-ui/src/theme';
import type { HomeLessonSummary, HomeResponse, HomeTargetPage } from './api';

interface HomeViewProps {
  home: HomeResponse;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
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

export function HomeView({ home, theme, onThemeChange, onOpenLesson, onNavigate }: HomeViewProps) {
  const isPmo = home.profile.role === 'LESSONS_MODERATOR';
  const { primaryAction, highlights, notifications, recentWork, shortcuts } = home;

  function runPrimaryAction() {
    if (primaryAction.lessonId !== null) onOpenLesson(primaryAction.lessonId);
    else onNavigate(primaryAction.targetPage);
  }

  return (
    <div className="home-view">
      <div className="home-header">
        <div>
          <h1 id="page-title" tabIndex={-1}>Home</h1>
          <p className="intro">Welcome, {home.profile.displayName}</p>
          <p className="active-role">Active role: <strong>{getRoleLabel(home.profile.role)}</strong></p>
        </div>
        <div className="home-theme-controls" role="group" aria-label="Home theme preference">
          <button type="button" aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}>Light</button>
          <button type="button" aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}>Dark</button>
        </div>
      </div>

      <section className="home-primary-action" aria-labelledby="home-primary-action-title">
        <h2 id="home-primary-action-title">Recommended next action</h2>
        <p>{primaryAction.description}</p>
        <button className="draft-action home-primary-button" type="button" onClick={runPrimaryAction}>
          {primaryAction.label}
        </button>
      </section>

      <div className="home-grid">
        {isPmo ? (
          <section className="home-card" aria-labelledby="home-pending-title">
            <h2 id="home-pending-title">Pending PMO evaluation</h2>
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
            <h2 id="home-returned-title">Returned lessons</h2>
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
          <h2 id="home-notifications-title">Unread notifications summary</h2>
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
          <h2 id="home-recent-title">Recent work</h2>
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
                <strong>{shortcut.label}</strong>
                <span className="library-description">{shortcut.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <a className="primary-link" href="/">Back to PMO Hub</a>
    </div>
  );
}
