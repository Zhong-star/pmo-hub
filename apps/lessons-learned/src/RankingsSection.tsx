import { useState } from 'react';
import type { RankedContributor, RankedLesson, RankingsResponse } from './api';

export type RankingMode = 'lessons' | 'contributors';

type RankingsSectionProps = {
  data?: RankingsResponse;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onOpenLesson: (lessonId: number) => void;
  onOpenContributor: (userId: string) => void;
};

function orderForPodium<T extends { position: number }>(items: T[]): T[] {
  const byPosition = new Map(items.map((item) => [item.position, item]));
  const ordered: T[] = [];
  const second = byPosition.get(2);
  const first = byPosition.get(1);
  const third = byPosition.get(3);
  if (second) ordered.push(second);
  if (first) ordered.push(first);
  if (third) ordered.push(third);
  return ordered;
}

function getPodiumSlot(position: number): 'left' | 'center' | 'right' {
  if (position === 1) return 'center';
  if (position === 2) return 'left';
  return 'right';
}

function getPodiumCardClass(position: number): string {
  if (position === 1) return 'podium-card podium-card--first';
  if (position === 2) return 'podium-card podium-card--second';
  return 'podium-card podium-card--third';
}

function getPositionLabel(position: number): string {
  if (position === 1) return '1st place';
  if (position === 2) return '2nd place';
  return '3rd place';
}

export function RankingsSection({
  data,
  isLoading,
  isError,
  onRetry,
  onOpenLesson,
  onOpenContributor,
}: RankingsSectionProps) {
  const [mode, setMode] = useState<RankingMode>('lessons');

  const rankedLessons: RankedLesson[] = orderForPodium(data?.mostVotedLessons ?? []);
  const rankedContributors: RankedContributor[] = orderForPodium(data?.topContributors ?? []);

  return (
    <section className="rankings-section" aria-labelledby="rankings-heading">
      <div className="rankings-header">
        <div>
          <h2 id="rankings-heading" className="rankings-title">Rankings</h2>
          <p className="rankings-subtitle">
            {mode === 'lessons'
              ? 'Top 3 most voted published lessons.'
              : 'Top 3 authorized contributors by published lessons.'}
          </p>
        </div>
        <div className="rankings-mode-toggle" role="group" aria-label="Ranking mode">
          <button
            type="button"
            className={mode === 'lessons' ? 'rankings-mode-button is-active' : 'rankings-mode-button'}
            aria-pressed={mode === 'lessons'}
            onClick={() => setMode('lessons')}
          >
            Most Voted Lessons
          </button>
          <button
            type="button"
            className={mode === 'contributors' ? 'rankings-mode-button is-active' : 'rankings-mode-button'}
            aria-pressed={mode === 'contributors'}
            onClick={() => setMode('contributors')}
          >
            Top Contributors
          </button>
        </div>
      </div>

      {isLoading && <p role="status">Loading rankings…</p>}

      {!isLoading && isError && (
        <div className="draft-error" role="alert">
          <p>Rankings could not be loaded.</p>
          <button className="draft-cancel" type="button" onClick={onRetry}>Retry</button>
        </div>
      )}

      {!isLoading && !isError && mode === 'lessons' && (
        rankedLessons.length === 0 ? (
          <p className="draft-empty">No lessons have received votes yet.</p>
        ) : (
          <ol className="rankings-podium" aria-label="Most Voted Lessons podium">
            {rankedLessons.map((lesson) => (
              <li
                key={lesson.id}
                className={getPodiumCardClass(lesson.position)}
                data-podium-position={lesson.position}
                data-podium-slot={getPodiumSlot(lesson.position)}
              >
                <span className="podium-badge" aria-label={getPositionLabel(lesson.position)}>
                  #{lesson.position} · {getPositionLabel(lesson.position)}
                </span>
                <button
                  type="button"
                  className="podium-title-button"
                  onClick={() => onOpenLesson(lesson.id)}
                >
                  {lesson.title}
                </button>
                <p className="podium-meta">
                  By {lesson.authorName}
                  {lesson.projectName ? ` · ${lesson.projectName}` : ''}
                </p>
                <dl className="podium-stats">
                  <div>
                    <dt>Votes</dt>
                    <dd>{lesson.votesCount}</dd>
                  </div>
                  <div>
                    <dt>Views</dt>
                    <dd>{lesson.viewCount}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        )
      )}

      {!isLoading && !isError && mode === 'contributors' && (
        rankedContributors.length === 0 ? (
          <p className="draft-empty">No contributors have published lessons yet.</p>
        ) : (
          <ol className="rankings-podium" aria-label="Top Contributors podium">
            {rankedContributors.map((contributor) => (
              <li
                key={contributor.id}
                className={getPodiumCardClass(contributor.position)}
                data-podium-position={contributor.position}
                data-podium-slot={getPodiumSlot(contributor.position)}
              >
                <span className="podium-badge" aria-label={getPositionLabel(contributor.position)}>
                  #{contributor.position} · {getPositionLabel(contributor.position)}
                </span>
                <div className="podium-contributor-header">
                  <span className="profile-avatar" aria-hidden="true">{contributor.initials}</span>
                  <button
                    type="button"
                    className="podium-title-button"
                    onClick={() => onOpenContributor(contributor.id)}
                  >
                    {contributor.displayName}
                  </button>
                </div>
                <dl className="podium-stats">
                  <div>
                    <dt>Published</dt>
                    <dd>{contributor.publishedLessonsCount}</dd>
                  </div>
                  <div>
                    <dt>Votes</dt>
                    <dd>{contributor.votesReceivedCount}</dd>
                  </div>
                  <div>
                    <dt>Views</dt>
                    <dd>{contributor.viewsReceivedCount}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        )
      )}
    </section>
  );
}
