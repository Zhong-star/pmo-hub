import { useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  SearchIcon,
  SlidersIcon,
  StarIcon,
  XIcon,
} from '../../shared-ui/src/Icons';
import type {
  ContributorProfileResponse,
  ContributorProfileSort,
  LessonDraft,
  LessonProject,
  LibraryLesson,
  ProfileSummary,
} from './api';

export type ProfileProjectFilter =
  | { kind: 'any' }
  | { kind: 'without-project' }
  | { kind: 'project'; id: string };

function getProjectOptionValue(filter: ProfileProjectFilter): string {
  if (filter.kind === 'without-project') return 'without-project';
  if (filter.kind === 'project') return `project:${encodeURIComponent(filter.id)}`;
  return '';
}

function readProjectOptionValue(value: string): ProfileProjectFilter {
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

function getRoleLabel(role: 'LESSONS_USER' | 'LESSONS_MODERATOR'): string {
  return role === 'LESSONS_MODERATOR' ? 'PMO' : 'Contributor';
}

function isPublishedLesson(lesson: LibraryLesson): boolean {
  return (lesson.status === 'Approved' || lesson.status === 'Closed') && Boolean(lesson.approvedAt);
}

function statusPillClass(status: LibraryLesson['status']): string {
  if (status === 'Approved') return 'lesson-status-pill lesson-status-pill--approved';
  if (status === 'PMOEvaluation') return 'lesson-status-pill lesson-status-pill--evaluation';
  if (status === 'Closed') return 'lesson-status-pill lesson-status-pill--closed';
  if (status === 'Archived') return 'lesson-status-pill lesson-status-pill--archived';
  return 'lesson-status-pill lesson-status-pill--open';
}

type ProfileSearchViewProps = {
  profiles?: ProfileSummary[];
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  onOpenProfile: (userId: string) => void;
};

export function ProfileSearchView({
  profiles,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  search,
  onSearchChange,
  onOpenProfile,
}: ProfileSearchViewProps) {
  const items = profiles ?? [];
  const hasSearch = search.trim().length > 0;

  return (
    <>
      <div className="submissions-header">
        <div>
          <h1 id="page-title" tabIndex={-1}>Profiles</h1>
          <p className="intro">Search authorized module members and inspect their public contributions.</p>
        </div>
      </div>

      <div className="profiles-search-bar" role="group" aria-label="Search profiles">
        <div className="collection-filter-field collection-filter-field--search">
          <label htmlFor="profile-search">Search profiles by name</label>
          <div className="search-field-wrap">
            <SearchIcon size={15} className="ui-icon search-field-wrap__icon" />
            <input
              id="profile-search"
              type="search"
              value={search}
              placeholder="Search by display name"
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
        </div>
        {hasSearch && (
          <button
            className="collection-toolbar__clear"
            type="button"
            onClick={() => onSearchChange('')}
          >
            <XIcon size={13} />
            <span>Clear search</span>
          </button>
        )}
      </div>

      {isLoading && <p role="status">Loading profiles…</p>}
      {isError && (
        <div className="draft-error" role="alert">
          <p>{errorMessage ?? (profiles
            ? 'Could not refresh. Showing the last loaded results.'
            : 'Profiles could not be loaded.')}</p>
          <button className="draft-cancel" type="button" onClick={onRetry}>Retry</button>
        </div>
      )}
      {!isLoading && !isError && items.length === 0 && (
        <p className="draft-empty">
          {hasSearch ? 'No authorized profiles match this search.' : 'No authorized profiles are available.'}
        </p>
      )}
      {!isLoading && items.length > 0 && (
        <ul className="profile-cards-grid" aria-label="Authorized module profiles">
          {items.map((profile) => (
            <li key={profile.id} className="profile-card">
              <div className="profile-card__header">
                <span className="profile-avatar" aria-hidden="true">{profile.initials}</span>
                <div>
                  <h2 className="profile-card__name">{profile.displayName}</h2>
                  <p className="profile-card__role">{getRoleLabel(profile.role)}</p>
                </div>
              </div>
              <dl className="profile-card__stats">
                <div>
                  <dt>Published lessons</dt>
                  <dd>{profile.publishedLessonsCount}</dd>
                </div>
                <div>
                  <dt>Votes received</dt>
                  <dd>{profile.votesReceivedCount}</dd>
                </div>
                <div>
                  <dt>Views received</dt>
                  <dd>{profile.viewsReceivedCount}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="draft-cancel profile-card__action ui-inline-btn"
                aria-label={`View profile of ${profile.displayName}`}
                onClick={() => onOpenProfile(profile.id)}
              >
                <span>View profile</span>
                <ArrowRightIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

type ContributorProfileViewProps = {
  data?: ContributorProfileResponse;
  isLoading: boolean;
  isNotFound: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  backLabel: string;
  onBack: () => void;
  projectFilter: ProfileProjectFilter;
  onProjectFilterChange: (value: ProfileProjectFilter) => void;
  lessonType: NonNullable<LessonDraft['lessonType']> | '';
  onLessonTypeChange: (value: NonNullable<LessonDraft['lessonType']> | '') => void;
  sort: ContributorProfileSort;
  onSortChange: (sort: ContributorProfileSort) => void;
  onClearFilters: () => void;
  onOpenLesson: (lesson: LibraryLesson) => void;
  onToggleVote: (lesson: LibraryLesson) => void;
  pendingVoteIds: ReadonlySet<number>;
  voteErrorMessage: string | null;
};

export function ContributorProfileView({
  data,
  isLoading,
  isNotFound,
  isError,
  errorMessage,
  onRetry,
  backLabel,
  onBack,
  projectFilter,
  onProjectFilterChange,
  lessonType,
  onLessonTypeChange,
  sort,
  onSortChange,
  onClearFilters,
  onOpenLesson,
  onToggleVote,
  pendingVoteIds,
  voteErrorMessage,
}: ContributorProfileViewProps) {
  const [filtersOpen, setFiltersOpen] = useState(true);
  const hasFilters = projectFilter.kind !== 'any' || lessonType !== '' || sort !== 'recent';
  const activeFilterCount = (projectFilter.kind !== 'any' ? 1 : 0) + (lessonType !== '' ? 1 : 0);
  const projectOptions: LessonProject[] = data?.projects ?? [];
  const items = data?.items ?? [];

  return (
    <>
      <div className="profile-back-bar">
        <button type="button" className="draft-cancel ui-inline-btn" onClick={onBack}>
          <ArrowLeftIcon size={15} />
          <span>{backLabel}</span>
        </button>
      </div>

      {isLoading && <p role="status">Loading contributor profile…</p>}

      {!isLoading && isNotFound && (
        <div className="draft-error" role="alert">
          <h1 id="page-title" tabIndex={-1}>Profile not found</h1>
          <p>The requested contributor profile could not be found.</p>
          <button type="button" className="draft-cancel" onClick={onBack}>{backLabel}</button>
        </div>
      )}

      {!isLoading && isError && !isNotFound && (
        <div className="draft-error" role="alert">
          {!data && <h1 id="page-title" tabIndex={-1}>Contributor profile</h1>}
          <p>{errorMessage ?? (data
            ? 'Could not refresh. Showing the last loaded results.'
            : 'The contributor profile could not be loaded.')}</p>
          <button type="button" className="draft-cancel" onClick={onRetry}>Retry</button>
        </div>
      )}

      {!isLoading && data && (
        <>
          <div className="profile-hero">
            <span className="profile-avatar profile-avatar--large" aria-hidden="true">
              {data.profile.initials}
            </span>
            <div>
              <h1 id="page-title" tabIndex={-1}>{data.profile.displayName}</h1>
              <p className="intro">
                {getRoleLabel(data.profile.role)}
                {data.rankingPosition !== null ? ` · Rank #${data.rankingPosition}` : ''}
              </p>
            </div>
          </div>

          <dl className="profile-summary-grid" aria-label="Public contribution summary">
            <div className="profile-summary-card">
              <dt>Published lessons</dt>
              <dd>{data.profile.publishedLessonsCount}</dd>
            </div>
            <div className="profile-summary-card">
              <dt>Votes received</dt>
              <dd>{data.profile.votesReceivedCount}</dd>
            </div>
            <div className="profile-summary-card">
              <dt>Views received</dt>
              <dd>{data.profile.viewsReceivedCount}</dd>
            </div>
          </dl>

          {data.includesPrivateLessons && (
            <p className="intro">
              Private lessons are shown in the list below based on your access, while public totals reflect only published lessons.
            </p>
          )}

          {voteErrorMessage && (
            <div className="draft-error" role="alert">
              <p>{voteErrorMessage}</p>
            </div>
          )}

          <div className="collection-surface">
            <div className="collection-toolbar">
              <div className="collection-toolbar__bar">
                <span className="collection-toolbar__title">
                  <SlidersIcon size={15} />
                  <span>Filters</span>
                  {activeFilterCount > 0 && (
                    <span className="collection-filter-badge" aria-label={`${activeFilterCount} active filters`}>
                      {activeFilterCount}
                    </span>
                  )}
                </span>
                <div className="collection-toolbar__actions">
                  {hasFilters && (
                    <button type="button" className="collection-toolbar__clear" onClick={onClearFilters}>
                      <XIcon size={13} />
                      <span>Clear filters</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="collection-toolbar__toggle"
                    aria-expanded={filtersOpen}
                    aria-controls="profile-filter-controls"
                    onClick={() => setFiltersOpen((open) => !open)}
                  >
                    <span>{filtersOpen ? 'Hide filters' : 'Show filters'}</span>
                    <ChevronDownIcon size={14} />
                  </button>
                </div>
              </div>

              <div
                id="profile-filter-controls"
                className="collection-toolbar__controls"
                role="group"
                aria-label="Filter and sort contributor lessons"
                hidden={!filtersOpen}
              >
                <div className="collection-filter-field">
                  <label htmlFor="profile-project">Project</label>
                  <select
                    id="profile-project"
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
                <div className="collection-filter-field">
                  <label htmlFor="profile-type">Lesson type</label>
                  <select
                    id="profile-type"
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
                <div className="collection-filter-field">
                  <label htmlFor="profile-sort">Sort by</label>
                  <select
                    id="profile-sort"
                    value={sort}
                    onChange={(event) => onSortChange(event.target.value as ContributorProfileSort)}
                  >
                    <option value="recent">Most recent</option>
                    <option value="oldest">Oldest</option>
                    <option value="most-voted">Most voted</option>
                    <option value="title">Title (A–Z)</option>
                    <option value="project">Project</option>
                    <option value="type">Lesson type</option>
                  </select>
                </div>
              </div>
            </div>

            {items.length === 0 ? (
              <p className="collection-surface__empty">
                {projectFilter.kind !== 'any' || lessonType !== ''
                  ? 'No lessons match these filters.'
                  : data.includesPrivateLessons
                    ? 'No lessons authored by this contributor yet.'
                    : 'No published lessons yet.'}
              </p>
            ) : (
              <div className="submission-table-wrapper submission-table-wrapper--flush">
                <table className="submission-table">
                  <caption className="visually-hidden">Lessons visible on {data.profile.displayName}&apos;s profile</caption>
                  <thead>
                    <tr>
                      <th scope="col">Title</th>
                      <th scope="col">ID</th>
                      <th scope="col">Project</th>
                      <th scope="col">Type</th>
                      <th scope="col">Status</th>
                      <th scope="col">{data.includesPrivateLessons ? 'Date' : 'Approved'}</th>
                      <th scope="col">Views</th>
                      <th scope="col">Votes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((lesson) => {
                      const published = isPublishedLesson(lesson);
                      const displayDate = lesson.approvedAt ?? lesson.updatedAt;
                      return (
                        <tr key={lesson.id}>
                          <th scope="row">
                            <button
                              type="button"
                              className="submission-title-link"
                              aria-label={`View ${lesson.title}`}
                              data-lesson-view-id={lesson.id}
                              onClick={() => onOpenLesson(lesson)}
                            >
                              {lesson.title}
                            </button>
                            {lesson.situationObserved && (
                              <p className="library-description">{lesson.situationObserved}</p>
                            )}
                          </th>
                          <td className="tabular-cell">#{lesson.id}</td>
                          <td>{lesson.projectName ?? 'No project'}</td>
                          <td>{lesson.lessonType ?? 'Not specified'}</td>
                          <td><span className={statusPillClass(lesson.status)}>{lesson.status === 'PMOEvaluation' ? 'PMO Evaluation' : lesson.status}</span></td>
                          <td className="tabular-cell">
                            <time dateTime={displayDate}>{formatUtcTimestamp(displayDate)}</time>
                          </td>
                          <td className="tabular-cell">{published ? lesson.viewCount : '—'}</td>
                          <td>
                            {published ? (
                              <button
                                type="button"
                                className={lesson.hasVoted ? 'vote-button is-voted' : 'vote-button'}
                                aria-pressed={lesson.hasVoted}
                                aria-label={lesson.hasVoted
                                  ? `Remove vote for ${lesson.title} (${lesson.votesCount})`
                                  : `Vote for ${lesson.title} (${lesson.votesCount})`}
                                disabled={pendingVoteIds.has(lesson.id)}
                                onClick={() => onToggleVote(lesson)}
                              >
                                <StarIcon size={15} filled={lesson.hasVoted} />
                                <span>{lesson.hasVoted ? 'Voted' : 'Vote'}</span>
                                <span className="vote-count">{lesson.votesCount}</span>
                              </button>
                            ) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
