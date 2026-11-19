import type { MouseEvent } from 'react';
import type {
  LessonDraft,
  LessonProject,
  PmoDashboardCard,
  PmoDashboardResponse,
  PmoDashboardSort,
} from './api';

export type DashboardProjectFilter =
  | { kind: 'any' }
  | { kind: 'without-project' }
  | { kind: 'project'; id: string };

type PmoDashboardViewProps = {
  data?: PmoDashboardResponse;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  projectFilter: DashboardProjectFilter;
  onProjectFilterChange: (value: DashboardProjectFilter) => void;
  projectOptions: LessonProject[];
  lessonType: NonNullable<LessonDraft['lessonType']> | '';
  onLessonTypeChange: (value: NonNullable<LessonDraft['lessonType']> | '') => void;
  status: LessonDraft['status'] | '';
  onStatusChange: (value: LessonDraft['status'] | '') => void;
  activeCard: PmoDashboardCard | '';
  onCardToggle: (card: PmoDashboardCard) => void;
  sort: PmoDashboardSort;
  onSortChange: (sort: PmoDashboardSort) => void;
  onClearFilters: () => void;
  onOpenReviewQueue: (event: MouseEvent<HTMLAnchorElement>) => void;
  onViewLesson: (lessonId: number) => void;
};

const SUMMARY_CARDS: { key: PmoDashboardCard; label: string; subtitle: string; field: keyof PmoDashboardResponse['summary'] }[] = [
  { key: 'awaiting-evaluation', label: 'Awaiting Evaluation', subtitle: 'Status: PMO Evaluation', field: 'awaitingEvaluation' },
  { key: 'recently-approved', label: 'Recently Approved', subtitle: 'Last 30 days (UTC)', field: 'recentlyApproved' },
  { key: 'recently-closed', label: 'Recently Closed', subtitle: 'Last 30 days (UTC)', field: 'recentlyClosed' },
  { key: 'recently-returned', label: 'Recently Returned', subtitle: 'Last 30 days (UTC)', field: 'recentlyReturned' },
];

const CARD_LABELS: Record<PmoDashboardCard, string> = {
  'awaiting-evaluation': 'Awaiting Evaluation',
  'recently-approved': 'Recently Approved (30d)',
  'recently-closed': 'Recently Closed (30d)',
  'recently-returned': 'Recently Returned (30d)',
};

function getProjectOptionValue(filter: DashboardProjectFilter): string {
  if (filter.kind === 'without-project') return 'without-project';
  if (filter.kind === 'project') return `project:${encodeURIComponent(filter.id)}`;
  return '';
}

function readProjectOptionValue(value: string): DashboardProjectFilter {
  if (value === 'without-project') return { kind: 'without-project' };
  if (value.startsWith('project:')) {
    try {
      return { kind: 'project', id: decodeURIComponent(value.slice('project:'.length)) };
    } catch {
      return { kind: 'any' };
    }
  }
  return { kind: 'any' };
}

function formatUtcTimestamp(timestamp: string): string {
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(timestamp))} UTC`;
}

function formatStatusLabel(status: LessonDraft['status']): string {
  return status === 'PMOEvaluation' ? 'PMO Evaluation' : status;
}

function getSortCaption(sort: PmoDashboardSort): string {
  if (sort === 'oldest-activity') return 'PMO Dashboard lessons, oldest activity first';
  if (sort === 'title') return 'PMO Dashboard lessons, title order';
  if (sort === 'status') return 'PMO Dashboard lessons, status order';
  if (sort === 'project') return 'PMO Dashboard lessons, project order';
  if (sort === 'type') return 'PMO Dashboard lessons, type order';
  return 'PMO Dashboard lessons, most recent activity first';
}

export function PmoDashboardView({
  data,
  isLoading,
  isError,
  onRetry,
  search,
  onSearchChange,
  projectFilter,
  onProjectFilterChange,
  projectOptions,
  lessonType,
  onLessonTypeChange,
  status,
  onStatusChange,
  activeCard,
  onCardToggle,
  sort,
  onSortChange,
  onClearFilters,
  onOpenReviewQueue,
  onViewLesson,
}: PmoDashboardViewProps) {
  const activeFilterLabels: string[] = [];
  if (search.trim()) activeFilterLabels.push(`Search: ${search.trim()}`);
  if (projectFilter.kind === 'without-project') {
    activeFilterLabels.push('Project: No project');
  } else if (projectFilter.kind === 'project') {
    const projectName = projectOptions.find((option) => option.id === projectFilter.id)?.name ?? projectFilter.id;
    activeFilterLabels.push(`Project: ${projectName}`);
  }
  if (lessonType) activeFilterLabels.push(`Type: ${lessonType}`);
  if (status) activeFilterLabels.push(`Status: ${formatStatusLabel(status)}`);
  if (activeCard) activeFilterLabels.push(`Card: ${CARD_LABELS[activeCard]}`);

  const summary = data?.summary ?? {
    awaitingEvaluation: 0,
    recentlyApproved: 0,
    recentlyClosed: 0,
    recentlyReturned: 0,
  };
  const items = data?.items ?? [];

  return (
    <>
      <div className="submissions-header">
        <div>
          <h1 id="page-title" tabIndex={-1}>PMO Dashboard</h1>
          <p className="intro">Operational overview with a 30-day UTC window.</p>
        </div>
        <a
          className="primary-link"
          href="/lessons-learned/?page=evaluation-queue"
          onClick={onOpenReviewQueue}
        >
          PMO Review Queue
        </a>
      </div>

      <div
        className="pmo-dashboard-summary-grid"
        role="group"
        aria-label="Operational summary (last 30 days UTC)"
      >
        {SUMMARY_CARDS.map((card) => {
          const isPressed = activeCard === card.key;
          return (
            <button
              key={card.key}
              type="button"
              className="dashboard-summary-card"
              aria-pressed={isPressed}
              onClick={() => onCardToggle(card.key)}
            >
              <span className="dashboard-summary-card__label">{card.label}</span>
              <span className="dashboard-summary-card__count">{summary[card.field]}</span>
              <span className="dashboard-summary-card__subtitle">{card.subtitle}</span>
            </button>
          );
        })}
      </div>

      <div className="submission-filters" role="group" aria-label="Search, filter, and sort PMO Dashboard">
        <div className="draft-editor-field">
          <label htmlFor="dashboard-search">Search title or ID</label>
          <input
            id="dashboard-search"
            type="search"
            value={search}
            placeholder="Title prefix, ID or #ID"
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
        <div className="draft-editor-field">
          <label htmlFor="dashboard-project">Project</label>
          <select
            id="dashboard-project"
            value={getProjectOptionValue(projectFilter)}
            onChange={(event) => onProjectFilterChange(readProjectOptionValue(event.target.value))}
          >
            <option value="">Any project</option>
            <option value="without-project">No project</option>
            {projectOptions.map((project) => (
              <option key={project.id} value={getProjectOptionValue({ kind: 'project', id: project.id })}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="draft-editor-field">
          <label htmlFor="dashboard-type">Lesson type</label>
          <select
            id="dashboard-type"
            value={lessonType}
            onChange={(event) => onLessonTypeChange(event.target.value as NonNullable<LessonDraft['lessonType']> | '')}
          >
            <option value="">Any type</option>
            <option value="Future Prevention">Future Prevention</option>
            <option value="Success to Repeat">Success to Repeat</option>
            <option value="Risk Avoided">Risk Avoided</option>
            <option value="Communication">Communication</option>
          </select>
        </div>
        <div className="draft-editor-field">
          <label htmlFor="dashboard-status">Status</label>
          <select
            id="dashboard-status"
            value={status}
            onChange={(event) => onStatusChange(event.target.value as LessonDraft['status'] | '')}
          >
            <option value="">Any status</option>
            <option value="Open">Open</option>
            <option value="PMOEvaluation">PMO Evaluation</option>
            <option value="Approved">Approved</option>
            <option value="Closed">Closed</option>
            <option value="Archived">Archived</option>
          </select>
        </div>
        <div className="draft-editor-field">
          <label htmlFor="dashboard-sort">Sort by</label>
          <select
            id="dashboard-sort"
            value={sort}
            onChange={(event) => onSortChange(event.target.value as PmoDashboardSort)}
          >
            <option value="activity">Most recent activity</option>
            <option value="oldest-activity">Oldest activity</option>
            <option value="title">Title</option>
            <option value="status">Status</option>
            <option value="project">Project</option>
            <option value="type">Lesson type</option>
          </select>
        </div>
        {activeFilterLabels.length > 0 && (
          <button className="draft-cancel" type="button" onClick={onClearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {activeFilterLabels.length > 0 && (
        <p className="draft-meta" role="status">Active filters: {activeFilterLabels.join(' · ')}</p>
      )}

      {isLoading && <p role="status">Loading PMO Dashboard…</p>}

      {isError && (
        <div className="draft-error" role="alert">
          <p>The PMO Dashboard could not be loaded.</p>
          <button className="draft-cancel" type="button" onClick={onRetry}>Retry</button>
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <p className="draft-empty">
          {activeFilterLabels.length > 0
            ? 'No lessons match these filters.'
            : 'No lessons are available yet.'}
        </p>
      )}

      {!isLoading && !isError && items.length > 0 && (
        <div className="submission-table-wrapper">
          <table className="submission-table">
            <caption className="visually-hidden">{getSortCaption(sort)}</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">ID</th>
                <th scope="col">Author</th>
                <th scope="col">Project</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Last activity</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((lesson) => (
                <tr key={lesson.id}>
                  <th scope="row">
                    <button
                      className="submission-title-link"
                      type="button"
                      onClick={() => onViewLesson(lesson.id)}
                      aria-label={`Open ${lesson.title}`}
                    >
                      {lesson.title}
                    </button>
                  </th>
                  <td>#{lesson.id}</td>
                  <td>{lesson.authorName}</td>
                  <td>{lesson.projectName ?? 'No project'}</td>
                  <td>{lesson.lessonType ?? '—'}</td>
                  <td>{formatStatusLabel(lesson.status)}</td>
                  <td>{formatUtcTimestamp(lesson.lastActivityAt)}</td>
                  <td>
                    <button
                      className="draft-cancel"
                      type="button"
                      onClick={() => onViewLesson(lesson.id)}
                      aria-label={`View ${lesson.title}`}
                      data-lesson-view-id={lesson.id}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
