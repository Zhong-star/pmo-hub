import { In, type EntityManager, type Repository } from 'typeorm';
import type { LocalAccessService, LocalProfile } from '../local-access.service';
import { LessonHistory } from './lesson-history.entity';
import type { LessonDetailsResponse, LessonDraftResponse, LessonHistoryEventResponse, LessonLibraryResponse } from './lesson-response.dto';
import type { Lesson } from './lesson.entity';

export async function includeLatestReviewGuidance(
  submissions: LessonDraftResponse[],
  history: Repository<LessonHistory>,
): Promise<LessonDraftResponse[]> {
  const openLessonIds = submissions.filter((submission) => submission.status === 'Open').map(({ id }) => id);
  if (openLessonIds.length === 0) return submissions;

  const returnEvents = await history.find({
    where: { lessonId: In(openLessonIds), eventType: 'Returned', newStatus: 'Open' },
    order: { occurredAt: 'DESC', id: 'DESC' },
  });
  const latestGuidanceByLesson = new Map<number, string>();
  for (const event of returnEvents) {
    if (event.reason && !latestGuidanceByLesson.has(event.lessonId)) {
      latestGuidanceByLesson.set(event.lessonId, event.reason);
    }
  }
  return submissions.map((submission) => ({
    ...submission,
    latestReviewGuidance: latestGuidanceByLesson.get(submission.id) ?? null,
  }));
}

export function toLessonDraftResponse(lesson: Lesson): LessonDraftResponse {
  return {
    id: lesson.id,
    title: lesson.title,
    authorId: lesson.authorId,
    updatedBy: lesson.updatedBy,
    status: lesson.status,
    version: lesson.version,
    projectId: lesson.projectId ?? null,
    projectName: lesson.projectName ?? null,
    projectCategory: lesson.projectCategory ?? null,
    projectPhase: lesson.projectPhase ?? null,
    situationObserved: lesson.situationObserved ?? null,
    rootCause: lesson.rootCause ?? null,
    lessonType: lesson.lessonType ?? null,
    impact: lesson.impact ?? null,
    recommendation: lesson.recommendation ?? null,
    applicability: lesson.applicability ?? null,
    approvedAt: lesson.approvedAt ?? null,
    createdAt: lesson.createdAt,
    updatedAt: lesson.updatedAt,
    latestReviewGuidance: null,
  };
}

export async function getVoteSummary(
  lessonId: number,
  userId: string,
  manager: EntityManager,
): Promise<{ votesCount: number; hasVoted: boolean }> {
  const summaries = await getVoteSummaries([lessonId], userId, manager);
  return summaries.get(lessonId) ?? { votesCount: 0, hasVoted: false };
}

async function getVoteSummaries(
  lessonIds: number[],
  userId: string,
  manager: EntityManager,
): Promise<Map<number, { votesCount: number; hasVoted: boolean }>> {
  const result = new Map<number, { votesCount: number; hasVoted: boolean }>();
  if (lessonIds.length === 0) return result;
  const rows = await manager.query(`
    SELECT
      lesson_id,
      COUNT(*)::int AS votes_count,
      BOOL_OR(user_id = $2) AS has_voted
    FROM lesson_votes
    WHERE lesson_id = ANY($1::int[])
    GROUP BY lesson_id
  `, [lessonIds, userId]) as { lesson_id: number; votes_count: number; has_voted: boolean }[];
  for (const row of rows) {
    result.set(Number(row.lesson_id), {
      votesCount: Number(row.votes_count),
      hasVoted: Boolean(row.has_voted),
    });
  }
  return result;
}

export async function attachVoteSummaries(
  items: LessonLibraryResponse[],
  userId: string,
  manager: EntityManager,
): Promise<LessonLibraryResponse[]> {
  if (items.length === 0) return items;
  const summaries = await getVoteSummaries(items.map((item) => item.id), userId, manager);
  return items.map((item) => {
    const summary = summaries.get(item.id);
    return {
      ...item,
      votesCount: summary?.votesCount ?? 0,
      hasVoted: summary?.hasVoted ?? false,
    };
  });
}

export function toLessonLibraryResponse(
  lesson: Lesson,
  authorNames: ReadonlyMap<string, string>,
  commentCount = 0,
): LessonLibraryResponse {
  return {
    ...toLessonDraftResponse(lesson),
    authorName: authorNames.get(lesson.authorId) ?? lesson.authorId,
    viewCount: lesson.viewCount,
    votesCount: 0,
    hasVoted: false,
    commentCount,
  };
}

export async function readDetailsRepresentation(
  lesson: Lesson,
  profile: LocalProfile,
  manager: EntityManager,
): Promise<LessonDetailsResponse> {
  const history = profile.role === 'LESSONS_MODERATOR' || lesson.authorId === profile.id
    ? await manager.getRepository(LessonHistory).find({
      where: { lessonId: lesson.id },
      order: { occurredAt: 'ASC', id: 'ASC' },
    })
    : [];
  const voteSummary = await getVoteSummary(lesson.id, profile.id, manager);
  const commentCount = await getPublicCommentCount(lesson.id, manager);
  return toDetailsResponse(lesson, history, voteSummary, commentCount);
}

export function withLibraryAuthor(details: LessonDetailsResponse, localAccess: LocalAccessService): LessonDetailsResponse {
  return {
    ...details,
    authorName: localAccess.getDisplayNameForProfile(details.authorId) ?? details.authorId,
  };
}

function toDetailsResponse(
  lesson: Lesson,
  history: LessonHistory[],
  voteSummary: { votesCount: number; hasVoted: boolean } = { votesCount: 0, hasVoted: false },
  commentCount = 0,
): LessonDetailsResponse {
  const historyResponse: LessonHistoryEventResponse[] = history.map((event) => ({
    id: event.id,
    actorId: event.actorId,
    eventType: event.eventType,
    previousStatus: event.previousStatus,
    newStatus: event.newStatus,
    reason: event.reason ?? null,
    occurredAt: event.occurredAt,
  }));

  const latestReviewGuidance = lesson.status === 'Open'
    ? [...history].reverse().find((event) => event.eventType === 'Returned' && event.newStatus === 'Open')?.reason ?? null
    : null;
  return {
    ...toLessonDraftResponse(lesson),
    latestReviewGuidance,
    history: historyResponse,
    votesCount: voteSummary.votesCount,
    hasVoted: voteSummary.hasVoted,
    commentCount,
  };
}

async function getPublicCommentCount(
  lessonId: number,
  manager: EntityManager,
): Promise<number> {
  const rows = await manager.query(
    'SELECT COUNT(*)::int AS count FROM lesson_comments WHERE lesson_id = $1 AND hidden_at IS NULL',
    [lessonId],
  ) as { count: number | string }[];
  return Number(rows[0]?.count ?? 0);
}
