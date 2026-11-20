import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  InternalServerErrorException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, In, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { LocalAccessService, type LocalProfile } from '../local-access.service';
import { LESSONS_LEARNED_DATA_SOURCE } from '../database/database.module';
import { isRepresentationETag, lessonRepresentationETag } from './lesson-http-contract';
import { emitsRepresentationTokens } from './lesson-token-format';
import { LessonHistory } from './lesson-history.entity';
import {
  formatNotificationSnippet,
  LessonNotificationsService,
} from './lesson-notifications.service';
import { Lesson } from './lesson.entity';
import {
  collectionCursorScope, encodeCollectionCursor, encodeProjectCursor, lessonLabelSort, paginateLessonCollection,
  paginateLibraryLessonsByTextKey, paginateLibraryLessonsByVotes, paginateLessons, readCollectionCursor, readProjectCursor,
  type LessonSortKey,
  type LessonLibraryPage, type LessonPage, type LessonPageRequest, type LessonProjectPage,
} from './lesson-pagination';
import type { CreateLessonRequest } from './create-lesson-request.dto';
import type { ApproveLessonRequest } from './approve-lesson-request.dto';
import type { CloseLessonRequest } from './close-lesson-request.dto';
import type { CancelLessonRequest } from './cancel-lesson-request.dto';
import type { RejectLessonRequest } from './reject-lesson-request.dto';
import { ProjectCatalogService, type LessonProject } from './project-catalog.service';
import type { SubmitLessonRequest } from './submit-lesson-request.dto';
import type { ReturnLessonRequest } from './return-lesson-request.dto';
import type { UpdateLessonDraftRequest } from './update-lesson-draft-request.dto';
import type {
  ContributorProfileResponse,
  LessonDetailsResponse, LessonDraftResponse, LessonHistoryEventResponse,
  LessonLibraryResponse, LessonVoteResponse, PmoDashboardLessonResponse, PmoDashboardResponse,
  ProfileSearchPage, ProfileSummaryResponse, RankedContributorResponse, RankedLessonResponse, RankingsResponse,
  RecordLessonLibraryViewResponse,
} from './lesson-response.dto';
import type { RecordLibraryViewRequest } from './record-library-view-request.dto';
import type {
  ContributorProfileFilter,
  ContributorProfileSort,
  LessonSearchFilters,
  LessonsLibraryFilter,
  LessonsLibrarySort,
  LessonSubmissionsFilter,
  PmoDashboardCard,
  PmoDashboardFilter,
  PmoDraftsFilter,
  PmoEvaluationQueueFilter,
  ProfileSearchFilter,
} from './lesson-submissions-query.dto';

type EvaluationFields = Pick<
  Lesson,
  | 'title'
  | 'projectCategory'
  | 'projectPhase'
  | 'situationObserved'
  | 'rootCause'
  | 'lessonType'
  | 'impact'
  | 'recommendation'
  | 'applicability'
>;

const libraryTitleWithoutMarks = "REGEXP_REPLACE(NORMALIZE(LOWER(lesson.title), NFD), U&'[\\0300-\\036F\\1AB0-\\1AFF\\1DC0-\\1DFF\\20D0-\\20FF\\FE20-\\FE2F]', '', 'g')";
const libraryCombiningMarkRanges = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
] as const;

function normalizeLibrarySearch(value: string): string {
  return [...value.toLowerCase().normalize('NFD')]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return !libraryCombiningMarkRanges.some(([start, end]) => codePoint >= start && codePoint <= end);
    })
    .join('');
}

function deriveProfileInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
  }
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return '?';
}

@Injectable()
export class LessonsService {
  private readonly representationTokens = emitsRepresentationTokens();

  constructor(
    @Inject(LocalAccessService) private readonly localAccess: LocalAccessService,
    @Inject(ProjectCatalogService) private readonly projectCatalog: ProjectCatalogService,
    @Optional() @Inject(LESSONS_LEARNED_DATA_SOURCE) private readonly dataSource?: DataSource,
    @Optional() @Inject(LessonNotificationsService) private readonly notifications?: LessonNotificationsService,
  ) {}

  async createDraft(localUserId: string | undefined, input: CreateLessonRequest): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();
    const projectId = input.projectId ?? null;
    const projectName = input.projectName ?? null;
    this.validateProjectSelection(null, projectId, projectName);

    const lesson = await dataSource.transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const created = await lessons.save(lessons.create({
        title: input.title,
        authorId: profile.id,
        updatedBy: profile.id,
        status: 'Open',
        projectId,
        projectName,
        projectCategory: input.projectCategory ?? null,
        projectPhase: input.projectPhase ?? null,
        situationObserved: input.situationObserved ?? null,
        rootCause: input.rootCause ?? null,
        lessonType: input.lessonType ?? null,
        impact: input.impact ?? null,
        recommendation: input.recommendation ?? null,
        applicability: input.applicability ?? null,
      }));

      const history = manager.getRepository(LessonHistory);
      await history.save(history.create({
        lessonId: created.id,
        actorId: profile.id,
        eventType: 'Created',
        previousStatus: null,
        newStatus: 'Open',
      }));
      return created;
    });

    return this.toResponse(lesson);
  }

  async getMyOpenDrafts(localUserId: string | undefined): Promise<LessonDraftResponse[]> {
    const profile = this.localAccess.getProfile(localUserId);
    const lessons = await this.requireDataSource().getRepository(Lesson).find({
      where: { authorId: profile.id, status: 'Open' },
      order: { updatedAt: 'DESC', id: 'DESC' },
    });
    return this.includeLatestReviewGuidance(lessons.map((lesson) => this.toResponse(lesson)));
  }

  async getMySubmissions(
    localUserId: string | undefined,
    filters: LessonSubmissionsFilter = {},
  ): Promise<LessonDraftResponse[]> {
    const profile = this.localAccess.getProfile(localUserId);
    return this.listSubmissions(filters, profile.id);
  }

  async getPmoDrafts(
    localUserId: string | undefined,
    filters: PmoDraftsFilter = {},
  ): Promise<LessonDraftResponse[]> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to list module lessons.');
    }
    return this.listSubmissions(filters);
  }

  async getPmoDashboard(
    localUserId: string | undefined,
    filters: PmoDashboardFilter,
    page: LessonPageRequest,
  ): Promise<PmoDashboardResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to view the PMO Dashboard.');
    }

    const windowDays = 30;
    const windowStartAt = new Date();
    windowStartAt.setUTCHours(0, 0, 0, 0);
    windowStartAt.setUTCDate(windowStartAt.getUTCDate() - windowDays + 1);
    const authorNames = this.localAccess.getDisplayNames();
    const dataSource = this.requireDataSource();

    return dataSource.transaction('REPEATABLE READ', async (manager) => {
      const latestHistory = '(SELECT MAX(h.occurred_at) FROM lesson_history h WHERE h.lesson_id = lesson.id)';
      const latestClosed = "(SELECT MAX(h.occurred_at) FROM lesson_history h WHERE h.lesson_id = lesson.id AND h.event_type = 'Closed')";
      const latestReturned = "(SELECT MAX(h.occurred_at) FROM lesson_history h WHERE h.lesson_id = lesson.id AND h.event_type = 'Returned')";
      const lastActivity = `GREATEST(lesson.updated_at, ${latestHistory})`;
      const cardConditions = {
        'awaiting-evaluation': "lesson.status = 'PMOEvaluation'",
        'recently-approved': 'lesson.approved_at >= :windowStartAt',
        'recently-closed': `${latestClosed} >= :windowStartAt`,
        'recently-returned': `${latestReturned} >= :windowStartAt`,
      } satisfies Record<PmoDashboardCard, string>;

      const query = manager.getRepository(Lesson).createQueryBuilder('lesson');
      this.applySearchFilters(query, filters, true);
      if (filters.status) query.andWhere('lesson.status = :status', { status: filters.status });
      query.setParameter('windowStartAt', windowStartAt);
      const counts = await query.clone()
        .select(`COUNT(*) FILTER (WHERE ${cardConditions['awaiting-evaluation']})`, 'awaitingEvaluation')
        .addSelect(`COUNT(*) FILTER (WHERE ${cardConditions['recently-approved']})`, 'recentlyApproved')
        .addSelect(`COUNT(*) FILTER (WHERE ${cardConditions['recently-closed']})`, 'recentlyClosed')
        .addSelect(`COUNT(*) FILTER (WHERE ${cardConditions['recently-returned']})`, 'recentlyReturned')
        .getRawOne<Record<string, string>>();
      const summary = {
        awaitingEvaluation: Number(counts?.awaitingEvaluation ?? 0),
        recentlyApproved: Number(counts?.recentlyApproved ?? 0),
        recentlyClosed: Number(counts?.recentlyClosed ?? 0),
        recentlyReturned: Number(counts?.recentlyReturned ?? 0),
      };

      if (filters.card) query.andWhere(cardConditions[filters.card]);
      const sort = filters.sort ?? 'activity';
      const direction = sort === 'oldest-activity' ? 'ASC' : 'DESC';
      const order: LessonSortKey[] = sort === 'activity' || sort === 'oldest-activity' ? [] : lessonLabelSort(sort);
      order.push(
        { expression: `(EXTRACT(EPOCH FROM ${lastActivity}) * 1000000)::bigint`, type: 'bigint', direction },
        { expression: 'lesson.id', type: 'bigint', direction },
      );

      const { entities, raw, page: pageInfo } = await paginateLessonCollection<{
        last_activity_at: Date;
        latest_closed_at: Date | null;
        latest_returned_at: Date | null;
      }>(
        query.addSelect(lastActivity, 'last_activity_at')
          .addSelect(latestClosed, 'latest_closed_at')
          .addSelect(latestReturned, 'latest_returned_at'),
        page,
        collectionCursorScope('dashboard', profile.id, filters.search, filters.projectId, filters.withoutProject,
          filters.lessonType, filters.status, filters.card, sort, filters.card ? windowStartAt : null),
        order,
      );
      const drafts = await this.includeLatestReviewGuidance(
        entities.map((lesson) => this.toResponse(lesson)),
        manager.getRepository(LessonHistory),
      );
      const items: PmoDashboardLessonResponse[] = entities.map((lesson, index) => ({
        ...this.toLibraryResponse(lesson, authorNames),
        latestReviewGuidance: drafts[index].latestReviewGuidance,
        lastActivityAt: raw[index].last_activity_at,
        latestClosedAt: raw[index].latest_closed_at,
        latestReturnedAt: raw[index].latest_returned_at,
      }));

      const projects = await manager.getRepository(Lesson).createQueryBuilder('lesson')
        .select('lesson.project_id', 'id')
        .addSelect('MAX(lesson.project_name)', 'name')
        .where('lesson.project_id IS NOT NULL')
        .andWhere('lesson.project_name IS NOT NULL')
        .groupBy('lesson.project_id')
        .orderBy('MAX(lesson.project_name)', 'ASC')
        .addOrderBy('lesson.project_id', 'ASC')
        .getRawMany<LessonProject>();

      return {
        windowDays,
        windowStartAt,
        summary,
        items,
        page: pageInfo,
        projects,
      };
    });
  }

  async searchProfiles(
    localUserId: string | undefined,
    filters: ProfileSearchFilter,
    page?: LessonPageRequest,
  ): Promise<ProfileSearchPage | ProfileSummaryResponse[]> {
    const caller = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    const normalizedSearch = normalizeLibrarySearch(filters.search?.trim() ?? '');
    const scope = collectionCursorScope('profiles', caller.id, normalizedSearch);
    const compare = (left: Pick<LocalProfile, 'displayName' | 'id'>, right: Pick<LocalProfile, 'displayName' | 'id'>) => (
      left.displayName.localeCompare(right.displayName, 'en', { sensitivity: 'base' })
      || left.id.localeCompare(right.id)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
    const profiles = this.localAccess.listProfiles();
    const profileKey = (profile: LocalProfile) => collectionCursorScope(profile.displayName, profile.id);
    const cursorKey = page?.cursor === undefined ? undefined : readCollectionCursor(page.cursor, scope, 1)[0];
    const anchor = cursorKey === undefined ? undefined : profiles.find((profile) => profileKey(profile) === cursorKey);
    if (cursorKey !== undefined && !anchor) throw new BadRequestException('Invalid cursor for this collection.');
    const matchingProfiles = profiles
      .filter((profile) => !normalizedSearch || normalizeLibrarySearch(profile.displayName).includes(normalizedSearch))
      .filter((profile) => anchor === undefined || compare(profile, anchor) > 0)
      .sort(compare)
      .slice(0, page ? page.limit + 1 : undefined);
    const visibleProfiles = page ? matchingProfiles.slice(0, page.limit) : matchingProfiles;

    const aggregates = await this.getPublicProfileAggregates(
      visibleProfiles.map((profile) => profile.id),
      dataSource.manager,
    );

    const items = visibleProfiles.map((profile) => {
      const stats = aggregates.get(profile.id);
      return {
        id: profile.id,
        displayName: profile.displayName,
        initials: deriveProfileInitials(profile.displayName),
        role: profile.role,
        publishedLessonsCount: stats?.publishedLessonsCount ?? 0,
        votesReceivedCount: stats?.votesReceivedCount ?? 0,
        viewsReceivedCount: stats?.viewsReceivedCount ?? 0,
      };
    });
    const last = visibleProfiles[visibleProfiles.length - 1];
    if (!page) return items;
    return {
      items,
      page: {
        limit: page.limit,
        nextCursor: matchingProfiles.length > page.limit
          ? encodeCollectionCursor(scope, [profileKey(last)])
          : null,
      },
    };
  }

  async getContributorProfile(
    localUserId: string | undefined,
    targetUserId: string,
    filters: ContributorProfileFilter,
    page: LessonPageRequest,
  ): Promise<ContributorProfileResponse> {
    const caller = this.localAccess.getProfile(localUserId);
    const target = this.localAccess.listProfiles().find((profile) => profile.id === targetUserId);
    if (!target) {
      throw new NotFoundException('Contributor profile not found.');
    }

    const includesPrivateLessons = caller.role === 'LESSONS_MODERATOR' || caller.id === target.id;
    const authorNames = this.localAccess.getDisplayNames();
    const dataSource = this.requireDataSource();

    return dataSource.transaction('REPEATABLE READ', async (manager) => {
      const aggregates = await this.getPublicProfileAggregates([target.id], manager);
      const stats = aggregates.get(target.id);

      const profileSummary: ProfileSummaryResponse = {
        id: target.id,
        displayName: target.displayName,
        initials: deriveProfileInitials(target.displayName),
        role: target.role,
        publishedLessonsCount: stats?.publishedLessonsCount ?? 0,
        votesReceivedCount: stats?.votesReceivedCount ?? 0,
        viewsReceivedCount: stats?.viewsReceivedCount ?? 0,
      };

      const projectQuery = manager.getRepository(Lesson).createQueryBuilder('lesson')
        .select('lesson.project_id', 'id')
        .addSelect('MAX(lesson.project_name)', 'name')
        .where('lesson.author_id = :authorId', { authorId: target.id })
        .andWhere('lesson.project_id IS NOT NULL')
        .andWhere('lesson.project_name IS NOT NULL');
      if (!includesPrivateLessons) {
        projectQuery
          .andWhere('lesson.status IN (:...publishedStatuses)', { publishedStatuses: ['Approved', 'Closed'] })
          .andWhere('lesson.approved_at IS NOT NULL');
      }
      const projects = await projectQuery
        .groupBy('lesson.project_id')
        .orderBy('MAX(lesson.project_name)', 'ASC')
        .addOrderBy('lesson.project_id', 'ASC')
        .getRawMany<LessonProject>();

      const query = manager.getRepository(Lesson).createQueryBuilder('lesson')
        .where('lesson.author_id = :authorId', { authorId: target.id });
      if (!includesPrivateLessons) {
        query
          .andWhere('lesson.status IN (:...publishedStatuses)', { publishedStatuses: ['Approved', 'Closed'] })
          .andWhere('lesson.approved_at IS NOT NULL');
      }
      this.applySearchFilters(query, {
        projectId: filters.projectId,
        withoutProject: filters.withoutProject,
        lessonType: filters.lessonType,
      });

      const sort: ContributorProfileSort = filters.sort ?? 'recent';
      const activity = includesPrivateLessons ? 'GREATEST(lesson.approved_at, lesson.updated_at)' : 'lesson.approved_at';
      const direction = sort === 'oldest' ? 'ASC' : 'DESC';
      const order: LessonSortKey[] = sort === 'title' || sort === 'project' || sort === 'type' ? lessonLabelSort(sort) : [];
      if (sort === 'most-voted') {
        order.push({
          expression: '(SELECT COUNT(*) FROM lesson_votes vote WHERE vote.lesson_id = lesson.id)',
          type: 'bigint',
          direction: 'DESC',
        });
      }
      order.push(
        { expression: `(EXTRACT(EPOCH FROM ${activity}) * 1000000)::bigint`, type: 'bigint', direction },
        { expression: 'lesson.id', type: 'bigint', direction: sort === 'most-voted' ? 'ASC' : direction },
      );
      const { entities: lessons, page: pageInfo } = await paginateLessonCollection(
        query,
        page,
        collectionCursorScope('contributor-profile', caller.id, target.id, includesPrivateLessons,
          filters.projectId, filters.withoutProject, filters.lessonType, sort),
        order,
      );
      const baseWithGuidance = includesPrivateLessons
        ? await this.includeLatestReviewGuidance(
          lessons.map((lesson) => this.toResponse(lesson)),
          manager.getRepository(LessonHistory),
        )
        : [];
      const guidanceById = new Map(baseWithGuidance.map((item) => [item.id, item.latestReviewGuidance]));

      const libraryItems = await this.attachVoteSummaries(
        lessons.map((lesson) => ({
          ...this.toLibraryResponse(lesson, authorNames),
          latestReviewGuidance: guidanceById.get(lesson.id) ?? null,
        })),
        caller.id,
        manager,
      );

      const rankedContributors = await this.getRankedContributors(manager);
      const rankingPosition = rankedContributors.find((item) => item.id === target.id)?.position ?? null;

      return {
        profile: profileSummary,
        rankingPosition,
        includesPrivateLessons,
        items: libraryItems,
        page: pageInfo,
        projects,
      };
    });
  }

  async getRankings(localUserId: string | undefined): Promise<RankingsResponse> {
    this.localAccess.getProfile(localUserId);
    const authorNames = this.localAccess.getDisplayNames();
    const dataSource = this.requireDataSource();

    return dataSource.transaction('REPEATABLE READ', async (manager) => {
      const lessonRows = await manager.query(`
        SELECT
          l.id,
          l.title,
          l.author_id,
          l.project_name,
          l.lesson_type,
          l.status,
          l.approved_at,
          l.view_count,
          v.votes_count
        FROM lessons l
        INNER JOIN (
          SELECT lesson_id, COUNT(*)::int AS votes_count
          FROM lesson_votes
          GROUP BY lesson_id
          HAVING COUNT(*) >= 1
        ) v ON v.lesson_id = l.id
        WHERE l.status IN ('Approved', 'Closed')
          AND l.approved_at IS NOT NULL
        ORDER BY v.votes_count DESC, l.approved_at DESC, l.id ASC
        LIMIT 3
      `) as {
        id: number;
        title: string;
        author_id: string;
        project_name: string | null;
        lesson_type: Lesson['lessonType'];
        status: 'Approved' | 'Closed';
        approved_at: Date | string;
        view_count: number;
        votes_count: number;
      }[];

      const mostVotedLessons: RankedLessonResponse[] = lessonRows.map((row, index) => ({
        position: index + 1,
        id: Number(row.id),
        title: row.title,
        authorId: row.author_id,
        authorName: authorNames.get(row.author_id) ?? row.author_id,
        projectName: row.project_name,
        lessonType: row.lesson_type,
        status: row.status,
        approvedAt: row.approved_at instanceof Date ? row.approved_at : new Date(row.approved_at),
        votesCount: Number(row.votes_count),
        viewCount: Number(row.view_count),
      }));

      const rankedContributors = await this.getRankedContributors(manager);
      const topContributors = rankedContributors.slice(0, 3);

      return {
        mostVotedLessons,
        topContributors,
      };
    });
  }

  private async getRankedContributors(manager: EntityManager): Promise<RankedContributorResponse[]> {
    const authorizedProfiles = this.localAccess.listProfiles();
    if (authorizedProfiles.length === 0) return [];

    const aggregates = await this.getPublicProfileAggregates(
      authorizedProfiles.map((profile) => profile.id),
      manager,
    );

    const eligible = authorizedProfiles.flatMap((profile) => {
      const stats = aggregates.get(profile.id);
      if (!stats || stats.publishedLessonsCount < 1 || !stats.latestApprovedAt) return [];
      return [{
        id: profile.id,
        displayName: profile.displayName,
        initials: deriveProfileInitials(profile.displayName),
        role: profile.role,
        publishedLessonsCount: stats.publishedLessonsCount,
        votesReceivedCount: stats.votesReceivedCount,
        viewsReceivedCount: stats.viewsReceivedCount,
        latestApprovedAt: stats.latestApprovedAt,
      }];
    });

    eligible.sort((left, right) => (
      (right.publishedLessonsCount - left.publishedLessonsCount)
      || (right.latestApprovedAt.getTime() - left.latestApprovedAt.getTime())
      || left.displayName.localeCompare(right.displayName, 'en', { sensitivity: 'base' })
      || left.id.localeCompare(right.id)
    ));

    return eligible.map((contributor, index) => ({
      position: index + 1,
      ...contributor,
    }));
  }

  private async getPublicProfileAggregates(
    authorIds: string[],
    manager: EntityManager,
  ): Promise<Map<string, {
    publishedLessonsCount: number;
    votesReceivedCount: number;
    viewsReceivedCount: number;
    latestApprovedAt: Date | null;
  }>> {
    const result = new Map<string, {
      publishedLessonsCount: number;
      votesReceivedCount: number;
      viewsReceivedCount: number;
      latestApprovedAt: Date | null;
    }>();
    if (authorIds.length === 0) return result;
    const rows = await manager.query(`
      SELECT
        l.author_id,
        COUNT(*)::int AS published_lessons_count,
        COALESCE(SUM(l.view_count), 0)::int AS views_received_count,
        COALESCE(SUM(v.votes_count), 0)::int AS votes_received_count,
        MAX(l.approved_at) AS latest_approved_at
      FROM lessons l
      LEFT JOIN (
        SELECT lesson_id, COUNT(*)::int AS votes_count
        FROM lesson_votes
        GROUP BY lesson_id
      ) v ON v.lesson_id = l.id
      WHERE l.author_id = ANY($1::text[])
        AND l.status IN ('Approved', 'Closed')
        AND l.approved_at IS NOT NULL
      GROUP BY l.author_id
    `, [authorIds]) as {
      author_id: string;
      published_lessons_count: number;
      views_received_count: number;
      votes_received_count: number;
      latest_approved_at: Date | string | null;
    }[];

    for (const row of rows) {
      result.set(row.author_id, {
        publishedLessonsCount: Number(row.published_lessons_count),
        votesReceivedCount: Number(row.votes_received_count),
        viewsReceivedCount: Number(row.views_received_count),
        latestApprovedAt: row.latest_approved_at
          ? (row.latest_approved_at instanceof Date ? row.latest_approved_at : new Date(row.latest_approved_at))
          : null,
      });
    }
    return result;
  }

  async getPmoEvaluationQueue(
    localUserId: string | undefined,
    filters: PmoEvaluationQueueFilter = {},
    page?: LessonPageRequest,
  ): Promise<LessonDraftResponse[] | LessonPage> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to list the evaluation queue.');
    }

    const query = this.requireDataSource().getRepository(Lesson).createQueryBuilder('lesson')
      .where('lesson.status = :queueStatus', { queueStatus: 'PMOEvaluation' });
    this.applySearchFilters(query, filters);

    const lastSubmission = `(SELECT MAX(queue_history.occurred_at)
          FROM lesson_history queue_history
          WHERE queue_history.lesson_id = lesson.id
            AND queue_history.event_type = 'Submitted'
            AND queue_history.new_status = 'PMOEvaluation')`;
    if (page) {
      const scope = JSON.stringify(['queue', filters.search, filters.projectId, Boolean(filters.withoutProject), filters.lessonType]);
      return paginateLessons(query, page, scope, lastSubmission, 'ASC', (lesson) => this.toResponse(lesson), this.representationTokens);
    }
    const lessons = await query
      .addSelect(lastSubmission, 'last_evaluation_submission_at')
      .orderBy('last_evaluation_submission_at', 'ASC')
      .addOrderBy('lesson.id', 'ASC')
      .getMany();
    return lessons.map((lesson) => this.toResponse(lesson));
  }

  async getEvaluationProjectSnapshots(
    localUserId: string | undefined,
    page?: LessonPageRequest,
  ): Promise<LessonProject[] | LessonProjectPage> {
    if (this.localAccess.getProfile(localUserId).role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to list evaluation projects.');
    }
    const query = this.requireDataSource().getRepository(Lesson).createQueryBuilder('lesson')
      .distinctOn(['lesson.project_id'])
      .select('lesson.project_id', 'id').addSelect('lesson.project_name', 'name')
      .where('lesson.status = :status', { status: 'PMOEvaluation' })
      .andWhere('lesson.project_id IS NOT NULL AND lesson.project_name IS NOT NULL')
      .orderBy('lesson.project_id', 'ASC').addOrderBy('lesson.id', 'DESC');
    if (!page) return query.getRawMany<LessonProject>();
    if (page.cursor !== undefined) {
      query.andWhere('lesson.project_id > :projectCursor', { projectCursor: readProjectCursor(page.cursor) });
    }
    const projects = await query.limit(page.limit + 1).getRawMany<LessonProject>();
    const items = projects.slice(0, page.limit);
    const nextCursor = projects.length > page.limit ? encodeProjectCursor(items[items.length - 1].id) : null;
    return { items, page: { limit: page.limit, nextCursor } };
  }

  private async includeLatestReviewGuidance(
    submissions: LessonDraftResponse[],
    history = this.requireDataSource().getRepository(LessonHistory),
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

  async getLibrary(
    localUserId: string | undefined,
    page?: LessonPageRequest,
    filters: LessonsLibraryFilter = {},
  ): Promise<LessonLibraryResponse[] | LessonLibraryPage> {
    const profile = this.localAccess.getProfile(localUserId);
    const authorNames = this.localAccess.getDisplayNames();
    const sort = filters.sort ?? 'newest';
    const dataSource = this.requireDataSource();
    const query = dataSource.getRepository(Lesson).createQueryBuilder('lesson')
      .where('lesson.status IN (:...publishedStatuses)', { publishedStatuses: ['Approved', 'Closed'] })
      .andWhere('lesson.approved_at IS NOT NULL');
    this.applySearchFilters(query, filters, true);
    if (page) {
      const hasFilters = Boolean(filters.search || filters.projectId || filters.withoutProject || filters.lessonType);
      const filterValues = [
        filters.search || null,
        filters.projectId || null,
        filters.withoutProject ?? false,
        filters.lessonType || null,
      ];
      const legacyScope = hasFilters ? `library:${JSON.stringify(filterValues)}` : 'library';
      const scope = sort === 'newest'
        ? legacyScope
        : `library-sort-v1:${JSON.stringify([sort, ...filterValues])}`;
      const toResponse = (lesson: Lesson) => this.toLibraryResponse(lesson, authorNames, 0);
      const result = sort === 'newest'
        ? await paginateLessons(query, page, scope, 'lesson.approved_at', 'DESC', toResponse, this.representationTokens)
        : sort === 'oldest'
          ? await paginateLessons(query, page, scope, 'lesson.approved_at', 'ASC', toResponse, this.representationTokens)
          : sort === 'most-voted'
            ? await paginateLibraryLessonsByVotes(query, page, scope, toResponse, this.representationTokens)
            : await paginateLibraryLessonsByTextKey(query, page, scope, sort, toResponse, this.representationTokens);
      const counts = await this.getPublicCommentCounts(result.items.map(({ id }) => id));
      const withVotes = await this.attachVoteSummaries(result.items, profile.id, dataSource.manager);
      return {
        ...result,
        items: withVotes.map((item) => ({ ...item, commentCount: counts.get(item.id) ?? 0 })),
      };
    }
    const lessons = await this.orderLibrary(query, sort).getMany();
    const counts = await this.getPublicCommentCounts(lessons.map(({ id }) => id));
    return this.attachVoteSummaries(
      lessons.map((lesson) => this.toLibraryResponse(lesson, authorNames, counts.get(lesson.id) ?? 0)),
      profile.id,
      dataSource.manager,
    );
  }

  private orderLibrary(query: SelectQueryBuilder<Lesson>, sort: LessonsLibrarySort): SelectQueryBuilder<Lesson> {
    if (sort === 'newest') {
      return query.orderBy('lesson.approvedAt', 'DESC').addOrderBy('lesson.id', 'DESC');
    }
    if (sort === 'oldest') {
      return query.orderBy('lesson.approvedAt', 'ASC').addOrderBy('lesson.id', 'ASC');
    }
    if (sort === 'most-voted') {
      return query
        .addSelect('(SELECT COUNT(*)::integer FROM lesson_votes lv WHERE lv.lesson_id = lesson.id)', 'library_sort_votes')
        .orderBy('library_sort_votes', 'DESC')
        .addOrderBy('lesson.approvedAt', 'DESC')
        .addOrderBy('lesson.id', 'ASC');
    }
    if (sort === 'title') {
      return query.orderBy('LOWER(lesson.title)', 'ASC')
        .addOrderBy('lesson.approvedAt', 'DESC')
        .addOrderBy('lesson.id', 'DESC');
    }
    if (sort === 'project') {
      return query.orderBy('CASE WHEN lesson.projectId IS NULL THEN 1 ELSE 0 END', 'ASC')
        .addOrderBy("LOWER(COALESCE(lesson.projectName, ''))", 'ASC')
        .addOrderBy('lesson.approvedAt', 'DESC')
        .addOrderBy('lesson.id', 'DESC');
    }
    return query.orderBy('CASE WHEN lesson.lessonType IS NULL THEN 1 ELSE 0 END', 'ASC')
      .addOrderBy("LOWER(COALESCE(lesson.lessonType, ''))", 'ASC')
      .addOrderBy('lesson.approvedAt', 'DESC')
      .addOrderBy('lesson.id', 'DESC');
  }

  async getLibraryProjectSnapshots(localUserId: string | undefined): Promise<LessonProject[]> {
    this.localAccess.getProfile(localUserId);
    return this.requireDataSource().getRepository(Lesson).createQueryBuilder('lesson')
      .select('lesson.project_id', 'id')
      .addSelect('MAX(lesson.project_name)', 'name')
      .where('lesson.status IN (:...publishedStatuses)', { publishedStatuses: ['Approved', 'Closed'] })
      .andWhere('lesson.approved_at IS NOT NULL')
      .andWhere('lesson.project_id IS NOT NULL')
      .andWhere('lesson.project_name IS NOT NULL')
      .groupBy('lesson.project_id')
      .orderBy('MAX(lesson.project_name)', 'ASC')
      .addOrderBy('lesson.project_id', 'ASC')
      .getRawMany<LessonProject>();
  }

  async getLibraryLessonDetails(localUserId: string | undefined, lessonId: number): Promise<LessonDetailsResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    return dataSource.transaction('REPEATABLE READ', async (manager) => {
      const lesson = await manager.getRepository(Lesson).findOne({ where: { id: lessonId } });
      const isPublished = lesson?.approvedAt !== null
        && (lesson?.status === 'Approved' || lesson?.status === 'Closed');
      if (!lesson || !isPublished) throw new NotFoundException('Published lesson not found.');

      const details = await this.readDetailsRepresentation(lesson, profile, manager);
      return this.withLibraryAuthor(details);
    });
  }

  async castVote(localUserId: string | undefined, lessonId: number): Promise<LessonVoteResponse> {
    return this.updateVote(localUserId, lessonId, 'cast');
  }

  async removeVote(localUserId: string | undefined, lessonId: number): Promise<LessonVoteResponse> {
    return this.updateVote(localUserId, lessonId, 'remove');
  }

  private async updateVote(
    localUserId: string | undefined,
    lessonId: number,
    action: 'cast' | 'remove',
  ): Promise<LessonVoteResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    return dataSource.transaction(async (manager) => {
      const lesson = await manager.getRepository(Lesson).findOne({
        where: { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      const isPmo = profile.role === 'LESSONS_MODERATOR';
      const isAuthor = lesson?.authorId === profile.id;
      const isPublished = lesson?.approvedAt !== null
        && (lesson?.status === 'Approved' || lesson?.status === 'Closed');
      if (!lesson || (!isPublished && !isPmo && !isAuthor)) {
        throw new NotFoundException('Lesson not found.');
      }
      if (!isPublished) {
        throw new ConflictException({
          code: 'LESSON_NOT_PUBLISHED',
          message: 'Only published lessons can be voted on.',
        });
      }

      if (action === 'cast') {
        await manager.query(`
          INSERT INTO lesson_votes (lesson_id, user_id)
          VALUES ($1, $2)
          ON CONFLICT (lesson_id, user_id) DO NOTHING
        `, [lessonId, profile.id]);
      } else {
        await manager.query(`
          DELETE FROM lesson_votes
          WHERE lesson_id = $1 AND user_id = $2
        `, [lessonId, profile.id]);
      }

      const summary = await this.getVoteSummary(lessonId, profile.id, manager);
      return {
        lessonId,
        votesCount: summary.votesCount,
        hasVoted: summary.hasVoted,
      };
    });
  }

  async recordLibraryView(
    localUserId: string | undefined,
    lessonId: number,
    input: RecordLibraryViewRequest,
  ): Promise<RecordLessonLibraryViewResponse> {
    this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    return dataSource.transaction(async (manager) => {
      const lesson = await manager.getRepository(Lesson).findOne({
        where: { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      const isPublished = lesson?.approvedAt !== null
        && (lesson?.status === 'Approved' || lesson?.status === 'Closed');
      if (!lesson || !isPublished) throw new NotFoundException('Published lesson not found.');

      const inserted = await manager.query(`
        INSERT INTO lesson_library_views (lesson_id, opening_id)
        VALUES ($1, $2::uuid)
        ON CONFLICT (lesson_id, opening_id) DO NOTHING
        RETURNING opening_id
      `, [lessonId, input.openingId]) as { opening_id: string }[];
      if (inserted.length === 0) return { viewCount: lesson.viewCount };

      const updated = await manager.query(`
        WITH changed AS (
          UPDATE lessons
          SET view_count = view_count + 1
          WHERE id = $1
          RETURNING view_count
        )
        SELECT view_count FROM changed
      `, [lessonId]) as { view_count: number }[];
      if (!updated[0]) throw new InternalServerErrorException('The Library view could not be recorded.');
      return { viewCount: Number(updated[0].view_count) };
    });
  }

  private async listSubmissions(
    filters: PmoDraftsFilter,
    onlyAuthorId?: string,
  ): Promise<LessonDraftResponse[]> {
    const query = this.requireDataSource().getRepository(Lesson).createQueryBuilder('lesson')
      .where(onlyAuthorId ? 'lesson.author_id = :onlyAuthorId' : '1 = 1', onlyAuthorId ? { onlyAuthorId } : {});
    if (filters.authorId) query.andWhere('lesson.author_id = :authorId', { authorId: filters.authorId });
    this.applySearchFilters(query, filters);
    if (filters.status) query.andWhere('lesson.status = :status', { status: filters.status });

    const lessons = await query.orderBy('lesson.updated_at', 'DESC').addOrderBy('lesson.id', 'DESC').getMany();
    return this.includeLatestReviewGuidance(lessons.map((lesson) => this.toResponse(lesson)));
  }

  private applySearchFilters(
    query: SelectQueryBuilder<Lesson>,
    filters: LessonSearchFilters,
    librarySearch = false,
  ): void {
    if (filters.search) {
      if (librarySearch) {
        const exactId = /^#([0-9]+)$/.exec(filters.search);
        const titlePrefix = normalizeLibrarySearch(filters.search);
        if (exactId) {
          const lessonId = Number(exactId[1]);
          if (Number.isSafeInteger(lessonId) && lessonId > 0 && lessonId <= 2_147_483_647) {
            query.andWhere('lesson.id = :lessonId', { lessonId });
          } else {
            query.andWhere('1 = 0');
          }
        } else if (/^[0-9]+$/.test(filters.search)) {
          const lessonId = Number(filters.search);
          const titleQuery = `LEFT(${libraryTitleWithoutMarks}, CHAR_LENGTH(:titlePrefix)) = :titlePrefix`;
          if (Number.isSafeInteger(lessonId) && lessonId <= 2_147_483_647) {
            query.andWhere(`(lesson.id = :lessonId OR ${titleQuery})`, { lessonId, titlePrefix });
          } else {
            query.andWhere(titleQuery, { titlePrefix });
          }
        } else {
          query.andWhere(`LEFT(${libraryTitleWithoutMarks}, CHAR_LENGTH(:titlePrefix)) = :titlePrefix`, { titlePrefix });
        }
      } else if (/^\d+$/.test(filters.search)) {
        const lessonId = Number(filters.search);
        if (Number.isSafeInteger(lessonId) && lessonId <= 2_147_483_647) {
          query.andWhere(
            '(lesson.id = :lessonId OR LOWER(SUBSTRING(lesson.title, 1, LENGTH(:titlePrefix))) = LOWER(:titlePrefix))',
            { lessonId, titlePrefix: filters.search },
          );
        } else {
          query.andWhere(
            'LOWER(SUBSTRING(lesson.title, 1, LENGTH(:titlePrefix))) = LOWER(:titlePrefix)',
            { titlePrefix: filters.search },
          );
        }
      } else {
        query.andWhere(
          'LOWER(SUBSTRING(lesson.title, 1, LENGTH(:titlePrefix))) = LOWER(:titlePrefix)',
          { titlePrefix: filters.search },
        );
      }
    }
    if (filters.withoutProject) query.andWhere('lesson.project_id IS NULL');
    if (filters.projectId) query.andWhere('lesson.project_id = :projectId', { projectId: filters.projectId });
    if (filters.lessonType) query.andWhere('lesson.lesson_type = :lessonType', { lessonType: filters.lessonType });
  }

  async getLessonDetails(localUserId: string | undefined, lessonId: number): Promise<LessonDetailsResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();
    return dataSource.transaction('REPEATABLE READ', async (manager) => {
      const lesson = await manager.getRepository(Lesson).findOne({ where: { id: lessonId } });
      const isPmo = profile.role === 'LESSONS_MODERATOR';
      const isAuthor = lesson?.authorId === profile.id;
      const isPublished = lesson?.approvedAt !== null &&
        (lesson?.status === 'Approved' || lesson?.status === 'Closed');
      if (!lesson || (!isPmo && !isAuthor && !isPublished)) {
        throw new NotFoundException('Lesson not found.');
      }

      return this.readDetailsRepresentation(lesson, profile, manager);
    });
  }

  private async readDetailsRepresentation(
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
    const voteSummary = await this.getVoteSummary(lesson.id, profile.id, manager);
    const commentCount = await this.getPublicCommentCount(lesson.id, manager);
    return this.toDetailsResponse(lesson, history, voteSummary, commentCount);
  }

  private withLibraryAuthor(details: LessonDetailsResponse): LessonDetailsResponse {
    return {
      ...details,
      authorName: this.localAccess.getDisplayNameForProfile(details.authorId) ?? details.authorId,
    };
  }

  private toDetailsResponse(
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
      ...this.toResponse(lesson),
      latestReviewGuidance,
      history: historyResponse,
      votesCount: voteSummary.votesCount,
      hasVoted: voteSummary.hasVoted,
      commentCount,
    };
  }

  async cancelOpenDraft(
    localUserId: string | undefined,
    lessonId: number,
    input: CancelLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    return dataSource.transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const current = await lessons.findOne({
        where: { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current || (profile.role !== 'LESSONS_MODERATOR' && current.authorId !== profile.id)) {
        throw new NotFoundException('Lesson not found.');
      }
      await this.checkIfMatch(ifMatch, input.version, current, profile, manager);
      if (current.status !== 'Open') {
        throw new ConflictException({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be cancelled.' });
      }
      if (current.version !== input.version) throw this.staleVersionConflict();
      if (!input.reason.trim()) {
        const message = 'Enter a cancellation reason.';
        throw new BadRequestException({
          code: 'INVALID_LESSON_CANCELLATION',
          message,
          fieldErrors: { reason: message },
        });
      }

      current.status = 'Archived';
      current.updatedBy = profile.id;
      current.version += 1;
      const cancelled = await lessons.save(current);
      const history = manager.getRepository(LessonHistory);
      await history.save(history.create({
        lessonId: cancelled.id,
        actorId: profile.id,
        eventType: 'Cancelled',
        previousStatus: 'Open',
        newStatus: 'Archived',
        reason: input.reason.trim(),
      }));

      return this.toResponse(cancelled);
    });
  }

  async approveEvaluatedLesson(
    localUserId: string | undefined,
    lessonId: number,
    input: ApproveLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to approve lessons.');
    }
    const dataSource = this.requireDataSource();

    const { response, approved, historyEntry } = await dataSource.transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const current = await lessons.findOne({
        where: { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException('Lesson not found.');
      await this.checkIfMatch(ifMatch, input.version, current, profile, manager);
      if (current.status !== 'PMOEvaluation') {
        throw new ConflictException({
          code: 'LESSON_NOT_AWAITING_EVALUATION',
          message: 'This lesson is no longer awaiting PMO evaluation. Reload the current queue before deciding again.',
        });
      }
      if (current.version !== input.version) throw this.staleVersionConflict();
      this.validateLessonForApproval(current);

      current.status = 'Approved';
      current.updatedBy = profile.id;
      current.version += 1;
      current.approvedAt = new Date();
      const approvedLesson = await lessons.save(current);

      const history = manager.getRepository(LessonHistory);
      const savedHistory = await history.save(history.create({
        lessonId: approvedLesson.id,
        actorId: profile.id,
        eventType: 'Approved',
        previousStatus: 'PMOEvaluation',
        newStatus: 'Approved',
      }));

      return {
        response: this.toResponse(approvedLesson),
        approved: approvedLesson,
        historyEntry: savedHistory,
      };
    });

    await this.notifications?.recordNotification({
      recipientUserId: approved.authorId,
      actorUserId: profile.id,
      actorDisplayName: profile.displayName,
      eventType: 'LESSON_APPROVED',
      lessonId: approved.id,
      lessonTitleSnapshot: approved.title,
      summary: `${profile.displayName} approved your lesson.`,
      sourceEventKey: `history:${historyEntry.id}`,
    });

    return response;
  }

  async rejectEvaluation(
    localUserId: string | undefined,
    lessonId: number,
    input: RejectLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to reject a lesson.');
    }

    const dataSource = this.requireDataSource();
    const reason = input.reason.trim();
    if (!reason || reason.length > 1000) {
      const message = 'Enter a rejection reason of 1 to 1,000 characters.';
      throw new BadRequestException({
        code: 'INVALID_LESSON_REJECTION',
        message,
        fieldErrors: { reason: message },
      });
    }

    const { response, rejected, historyEntry } = await dataSource.transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const current = await lessons.findOne({
        where: { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException('Lesson not found.');
      await this.checkIfMatch(ifMatch, input.version, current, profile, manager);
      if (current.status !== 'PMOEvaluation') {
        throw new ConflictException({
          code: 'LESSON_NOT_AWAITING_EVALUATION',
          message: 'Only lessons awaiting PMO evaluation can be rejected.',
        });
      }
      if (current.version !== input.version) throw this.staleVersionConflict();

      current.status = 'Archived';
      current.updatedBy = profile.id;
      current.version += 1;
      const rejectedLesson = await lessons.save(current);
      const historyRepo = manager.getRepository(LessonHistory);
      const savedHistory = await historyRepo.save(historyRepo.create({
        lessonId: rejectedLesson.id,
        actorId: profile.id,
        eventType: 'Rejected',
        previousStatus: 'PMOEvaluation',
        newStatus: 'Archived',
        reason,
      }));

      return {
        response: this.toResponse(rejectedLesson),
        rejected: rejectedLesson,
        historyEntry: savedHistory,
      };
    });

    await this.notifications?.recordNotification({
      recipientUserId: rejected.authorId,
      actorUserId: profile.id,
      actorDisplayName: profile.displayName,
      eventType: 'LESSON_REJECTED',
      lessonId: rejected.id,
      lessonTitleSnapshot: rejected.title,
      summary: `${profile.displayName} rejected your lesson: ${formatNotificationSnippet(reason)}`,
      sourceEventKey: `history:${historyEntry.id}`,
    });

    return response;
  }

  async closeApprovedLesson(
    localUserId: string | undefined,
    lessonId: number,
    input: CloseLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to close lessons.');
    }

    return this.requireDataSource().transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const current = await lessons.findOne({
        where: { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException('Lesson not found.');
      await this.checkIfMatch(ifMatch, input.version, current, profile, manager);
      if (current.status !== 'Approved') {
        throw new ConflictException({
          code: 'LESSON_NOT_APPROVED',
          message: 'This lesson is no longer Approved. Reload the current version before deciding again.',
        });
      }
      if (current.version !== input.version) throw this.staleVersionConflict();

      current.status = 'Closed';
      current.updatedBy = profile.id;
      current.version += 1;
      const closed = await lessons.save(current);

      const history = manager.getRepository(LessonHistory);
      await history.save(history.create({
        lessonId: closed.id,
        actorId: profile.id,
        eventType: 'Closed',
        previousStatus: 'Approved',
        newStatus: 'Closed',
      }));

      return this.toResponse(closed);
    });
  }

  getProjects(localUserId: string | undefined): LessonProject[] {
    this.localAccess.getProfile(localUserId);
    return this.projectCatalog.list();
  }

  async updateOpenDraft(
    localUserId: string | undefined,
    lessonId: number,
    input: UpdateLessonDraftRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const repository = this.requireDataSource().getRepository(Lesson);
    const current = await repository.findOne({ where: { id: lessonId } });
    if (!current || (profile.role !== 'LESSONS_MODERATOR' && current.authorId !== profile.id)) {
      throw new NotFoundException('Lesson not found.');
    }
    if (ifMatch && current.version !== input.version) throw this.staleVersionConflict();
    const canEditEvaluation = current.status === 'PMOEvaluation' && profile.role === 'LESSONS_MODERATOR';
    if (current.status !== 'Open' && !canEditEvaluation) {
      throw new ConflictException({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be edited.' });
    }
    if (current.version !== input.version) throw this.staleVersionConflict();

    const projectId = input.projectId === undefined ? current.projectId : input.projectId;
    const projectName = input.projectName === undefined ? current.projectName : input.projectName;
    try {
      this.validateProjectSelection(current, projectId, projectName);
    } catch (error) {
      const response = error instanceof BadRequestException ? error.getResponse() : null;
      if (
        typeof response === 'object' && response !== null &&
        'code' in response && response.code === 'INVALID_PROJECT_SELECTION'
      ) {
        const message = 'Choose a current project or No project before saving.';
        throw new BadRequestException({
          code: 'INVALID_LESSON_EDIT',
          message: 'Correct the indicated fields before saving.',
          fieldErrors: { projectId: message },
        });
      }
      throw error;
    }
    const fields = {
      title: input.title,
      projectId,
      projectName,
      projectCategory: input.projectCategory === undefined ? current.projectCategory : input.projectCategory,
      projectPhase: input.projectPhase === undefined ? current.projectPhase : input.projectPhase,
      situationObserved: input.situationObserved === undefined ? current.situationObserved : input.situationObserved,
      rootCause: input.rootCause === undefined ? current.rootCause : input.rootCause,
      lessonType: input.lessonType === undefined ? current.lessonType : input.lessonType,
      impact: input.impact === undefined ? current.impact : input.impact,
      recommendation: input.recommendation === undefined ? current.recommendation : input.recommendation,
      applicability: input.applicability === undefined ? current.applicability : input.applicability,
    };
    if (current.status === 'PMOEvaluation') this.validateEvaluationCompleteness(fields);

    return this.requireDataSource().transaction(async (manager) => {
      const transactionalLessons = manager.getRepository(Lesson);
      await this.checkIfMatch(ifMatch, input.version, current, profile, manager);
      const update = transactionalLessons.createQueryBuilder()
        .update(Lesson)
        .set({
          ...fields,
          updatedBy: profile.id,
          version: () => '"version" + 1',
          updatedAt: () => 'CURRENT_TIMESTAMP',
        })
        .where('id = :lessonId AND status = :status AND version = :version', {
          lessonId,
          status: current.status,
          version: input.version,
        });
      if (profile.role !== 'LESSONS_MODERATOR') update.andWhere('author_id = :authorId', { authorId: profile.id });
      const result = await update.returning('*').execute();

      if (!result.affected) {
        const latest = await transactionalLessons.findOne({ where: { id: lessonId } });
        if (!latest || (profile.role !== 'LESSONS_MODERATOR' && latest.authorId !== profile.id)) {
          throw new NotFoundException('Lesson not found.');
        }
        if (ifMatch && latest.version !== input.version) throw this.staleVersionConflict();
        if (latest.status !== current.status) {
          if (current.status === 'PMOEvaluation') {
            throw new ConflictException({
              code: 'LESSON_NOT_IN_EVALUATION',
              message: 'This lesson is no longer in PMO evaluation. Reload its current status before saving again.',
            });
          }
          throw new ConflictException({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be edited.' });
        }
        throw this.staleVersionConflict();
      }

      const updated = result.raw[0] as Record<string, unknown> | undefined;
      if (!updated) throw new InternalServerErrorException('The updated draft could not be returned.');
      const [response] = await this.includeLatestReviewGuidance(
        [this.toResponseFromDatabaseRow(updated)],
        manager.getRepository(LessonHistory),
      );
      return response!;
    });
  }

  async submitOwnOpenDraft(
    localUserId: string | undefined,
    lessonId: number,
    input: SubmitLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    return dataSource.transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const current = await lessons.findOne({
        where: { id: lessonId, authorId: profile.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException('Lesson not found.');
      await this.checkIfMatch(ifMatch, input.version, current, profile, manager);
      if (current.status !== 'Open') {
        throw new ConflictException({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be submitted.' });
      }
      if (current.version !== input.version) throw this.staleVersionConflict();
      if (input.lessonType === 'Future Prevention' && !input.rootCause?.trim()) {
        throw new BadRequestException({
          code: 'INVALID_LESSON_SUBMISSION',
          message: 'Root cause is required for Future Prevention.',
          fieldErrors: { rootCause: 'Root cause is required for Future Prevention.' },
        });
      }

      const projectId = input.projectId === undefined ? current.projectId : input.projectId;
      const projectName = input.projectName === undefined ? current.projectName : input.projectName;
      try {
        this.validateProjectSelection(current, projectId ?? null, projectName ?? null);
      } catch (error) {
        const response = error instanceof BadRequestException ? error.getResponse() : null;
        if (
          typeof response === 'object' && response !== null &&
          'code' in response && response.code === 'INVALID_PROJECT_SELECTION'
        ) {
          const message = 'Choose a current project or No project before submitting.';
          throw new BadRequestException({
            code: 'INVALID_LESSON_SUBMISSION',
            message,
            fieldErrors: { projectId: message },
          });
        }
        throw error;
      }

      current.title = input.title;
      current.projectId = projectId ?? null;
      current.projectName = projectName ?? null;
      current.projectCategory = input.projectCategory;
      current.projectPhase = input.projectPhase;
      current.situationObserved = input.situationObserved;
      current.rootCause = input.rootCause ?? null;
      current.lessonType = input.lessonType;
      current.impact = input.impact;
      current.recommendation = input.recommendation;
      current.applicability = input.applicability;
      current.updatedBy = profile.id;
      current.status = 'PMOEvaluation';
      current.version += 1;

      const submitted = await lessons.save(current);
      const history = manager.getRepository(LessonHistory);
      await history.save(history.create({
        lessonId: submitted.id,
        actorId: profile.id,
        eventType: 'Submitted',
        previousStatus: 'Open',
        newStatus: 'PMOEvaluation',
      }));

      return this.toResponse(submitted);
    });
  }

  async returnForChanges(
    localUserId: string | undefined,
    lessonId: number,
    input: ReturnLessonRequest,
    ifMatch?: string,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to return a lesson for changes.');
    }

    const { response, returned, historyEntry, guidance } = await this.requireDataSource().transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const current = await lessons.findOne({
        where: { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException('Lesson not found.');
      await this.checkIfMatch(ifMatch, input.version, current, profile, manager);
      if (current.status !== 'PMOEvaluation') {
        throw new ConflictException({
          code: 'LESSON_NOT_AWAITING_EVALUATION',
          message: 'This lesson is no longer awaiting evaluation. Reload the current version before deciding.',
        });
      }
      if (current.version !== input.version) throw this.staleVersionConflict();
      if (typeof input.guidance !== 'string' || !input.guidance.trim()) {
        const message = 'Enter guidance for the author.';
        throw new BadRequestException({
          code: 'INVALID_LESSON_RETURN',
          message,
          fieldErrors: { guidance: message },
        });
      }
      if (input.guidance.length > 1000) {
        const message = 'Guidance must be 1000 characters or fewer.';
        throw new BadRequestException({
          code: 'INVALID_LESSON_RETURN',
          message,
          fieldErrors: { guidance: message },
        });
      }

      const trimmedGuidance = input.guidance.trim();
      current.status = 'Open';
      current.updatedBy = profile.id;
      current.version += 1;
      const returnedLesson = await lessons.save(current);
      const history = manager.getRepository(LessonHistory);
      const savedHistory = await history.save(history.create({
        lessonId: returnedLesson.id,
        actorId: profile.id,
        eventType: 'Returned',
        previousStatus: 'PMOEvaluation',
        newStatus: 'Open',
        reason: trimmedGuidance,
      }));
      return {
        response: { ...this.toResponse(returnedLesson), latestReviewGuidance: trimmedGuidance },
        returned: returnedLesson,
        historyEntry: savedHistory,
        guidance: trimmedGuidance,
      };
    });

    await this.notifications?.recordNotification({
      recipientUserId: returned.authorId,
      actorUserId: profile.id,
      actorDisplayName: profile.displayName,
      eventType: 'LESSON_RETURNED',
      lessonId: returned.id,
      lessonTitleSnapshot: returned.title,
      summary: `${profile.displayName} returned your lesson for changes: ${formatNotificationSnippet(guidance)}`,
      sourceEventKey: `history:${historyEntry.id}`,
    });

    return response;
  }

  private validateProjectSelection(
    current: Lesson | null,
    projectId: string | null,
    projectName: string | null,
  ): void {
    if (projectId === null && projectName === null) return;
    if (
      typeof projectId !== 'string' || projectId.trim() === '' ||
      typeof projectName !== 'string' || projectName.trim() === ''
    ) {
      throw new BadRequestException({
        code: 'INVALID_PROJECT_SELECTION',
        message: 'Select a project from the local catalog or clear the project selection.',
      });
    }

    const unchangedSnapshot = current !== null &&
      projectId === current.projectId && projectName === current.projectName;
    if (unchangedSnapshot) return;

    const catalogMatches = this.projectCatalog.list().some(
      (project) => project.id === projectId && project.name === projectName,
    );
    if (!catalogMatches) {
      throw new BadRequestException({
        code: 'INVALID_PROJECT_SELECTION',
        message: 'Select a project from the local catalog or clear the project selection.',
      });
    }
  }

  private validateLessonForApproval(lesson: Lesson): void {
    const fieldErrors = this.evaluationCompletenessErrors(lesson);
    if (lesson.projectCategory && !['Technology', 'Business', 'Infrastructure', 'Data'].includes(lesson.projectCategory)) {
      fieldErrors.projectCategory = 'Choose a project category.';
    }
    if (lesson.projectPhase && !['Initiation', 'Planning', 'Execution', 'Closure', 'Not Applicable'].includes(lesson.projectPhase)) {
      fieldErrors.projectPhase = 'Choose a project phase.';
    }
    if (lesson.lessonType && !['Future Prevention', 'Success to Repeat', 'Risk Avoided', 'Communication'].includes(lesson.lessonType)) {
      fieldErrors.lessonType = 'Choose a lesson type.';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new BadRequestException({
        code: 'INVALID_LESSON_APPROVAL',
        message: 'Complete the required lesson fields before approving.',
        fieldErrors,
      });
    }
    this.validateProjectSelection(lesson, lesson.projectId, lesson.projectName);
  }

  private async checkIfMatch(
    ifMatch: string | undefined,
    expectedVersion: number,
    current: Lesson,
    profile: LocalProfile,
    manager: EntityManager,
  ): Promise<void> {
    if (!ifMatch) return;
    if (current.version !== expectedVersion) throw this.staleVersionConflict();
    if (!isRepresentationETag(ifMatch)) return;

    const matches = (response: LessonDraftResponse) =>
      [false, true].some((includeInBody) => lessonRepresentationETag(response, includeInBody) === ifMatch);
    const draft = this.toResponse(current);
    if (matches(draft)) return;

    const details = await this.readDetailsRepresentation(current, profile, manager);
    if (matches(details) || matches({ ...draft, latestReviewGuidance: details.latestReviewGuidance })) return;
    if (current.approvedAt && (current.status === 'Approved' || current.status === 'Closed')
      && matches(this.withLibraryAuthor(details))) return;
    throw this.staleVersionConflict();
  }

  private staleVersionConflict(): ConflictException {
    return new ConflictException({
      code: 'STALE_LESSON_VERSION',
      message: 'This draft changed after you opened it. Reload the current version before saving again.',
    });
  }

  private validateEvaluationCompleteness(fields: EvaluationFields): void {
    const fieldErrors = this.evaluationCompletenessErrors(fields);
    if (Object.keys(fieldErrors).length > 0) {
      throw new BadRequestException({
        code: 'INVALID_LESSON_EDIT',
        message: 'Correct the indicated fields before saving.',
        fieldErrors,
      });
    }
  }

  private evaluationCompletenessErrors(fields: EvaluationFields): Record<string, string> {
    const fieldErrors: Record<string, string> = {};
    const requireText = (field: string, value: string | null, label: string) => {
      if (!value?.trim()) fieldErrors[field] = `${label} is required.`;
    };

    requireText('title', fields.title, 'Title');
    if (!fields.projectCategory) fieldErrors.projectCategory = 'Project category is required.';
    if (!fields.projectPhase) fieldErrors.projectPhase = 'Project phase is required.';
    requireText('situationObserved', fields.situationObserved, 'Situation observed');
    if (!fields.lessonType) fieldErrors.lessonType = 'Lesson type is required.';
    requireText('impact', fields.impact, 'Impact');
    requireText('recommendation', fields.recommendation, 'Recommendation');
    requireText('applicability', fields.applicability, 'Applicability');
    if (fields.lessonType === 'Future Prevention') requireText('rootCause', fields.rootCause, 'Root cause');

    return fieldErrors;
  }

  private requireDataSource(): DataSource {
    if (!this.dataSource) {
      throw new ServiceUnavailableException('Lessons Learned persistence is unavailable.');
    }
    return this.dataSource;
  }

  private toResponse(lesson: Lesson): LessonDraftResponse {
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

  private async getVoteSummary(
    lessonId: number,
    userId: string,
    manager: EntityManager,
  ): Promise<{ votesCount: number; hasVoted: boolean }> {
    const summaries = await this.getVoteSummaries([lessonId], userId, manager);
    return summaries.get(lessonId) ?? { votesCount: 0, hasVoted: false };
  }

  private async getVoteSummaries(
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

  private async attachVoteSummaries(
    items: LessonLibraryResponse[],
    userId: string,
    manager: EntityManager,
  ): Promise<LessonLibraryResponse[]> {
    if (items.length === 0) return items;
    const summaries = await this.getVoteSummaries(items.map((item) => item.id), userId, manager);
    return items.map((item) => {
      const summary = summaries.get(item.id);
      return {
        ...item,
        votesCount: summary?.votesCount ?? 0,
        hasVoted: summary?.hasVoted ?? false,
      };
    });
  }

  private async getPublicCommentCounts(lessonIds: number[]): Promise<Map<number, number>> {
    if (lessonIds.length === 0) return new Map();
    const rows = await this.requireDataSource().query(
      `SELECT lesson_id, COUNT(*)::int AS count
       FROM lesson_comments
       WHERE lesson_id = ANY($1::int[]) AND hidden_at IS NULL
       GROUP BY lesson_id`,
      [lessonIds],
    ) as { lesson_id: number; count: number | string }[];
    return new Map(rows.map((row) => [Number(row.lesson_id), Number(row.count)]));
  }

  private async getPublicCommentCount(
    lessonId: number,
    queryable: Pick<DataSource, 'query'> = this.requireDataSource(),
  ): Promise<number> {
    const rows = await queryable.query(
      'SELECT COUNT(*)::int AS count FROM lesson_comments WHERE lesson_id = $1 AND hidden_at IS NULL',
      [lessonId],
    ) as { count: number | string }[];
    return Number(rows[0]?.count ?? 0);
  }

  private toLibraryResponse(
    lesson: Lesson,
    authorNames: ReadonlyMap<string, string>,
    commentCount = 0,
  ): LessonLibraryResponse {
    return {
      ...this.toResponse(lesson),
      authorName: authorNames.get(lesson.authorId) ?? lesson.authorId,
      viewCount: lesson.viewCount,
      votesCount: 0,
      hasVoted: false,
      commentCount,
    };
  }

  private toResponseFromDatabaseRow(row: Record<string, unknown>): LessonDraftResponse {
    return {
      id: row.id as number,
      title: row.title as string,
      authorId: row.author_id as string,
      updatedBy: row.updated_by as string,
      status: row.status as Lesson['status'],
      version: row.version as number,
      projectId: (row.project_id as string | null) ?? null,
      projectName: (row.project_name as string | null) ?? null,
      projectCategory: (row.project_category as Lesson['projectCategory']) ?? null,
      projectPhase: (row.project_phase as Lesson['projectPhase']) ?? null,
      situationObserved: (row.situation_observed as string | null) ?? null,
      rootCause: (row.root_cause as string | null) ?? null,
      lessonType: (row.lesson_type as Lesson['lessonType']) ?? null,
      impact: (row.impact as string | null) ?? null,
      recommendation: (row.recommendation as string | null) ?? null,
      applicability: (row.applicability as string | null) ?? null,
      approvedAt: (row.approved_at as Date | null) ?? null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
      latestReviewGuidance: null,
    };
  }
}
