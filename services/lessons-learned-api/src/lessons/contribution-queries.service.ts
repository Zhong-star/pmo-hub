import {
  BadRequestException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { LESSONS_LEARNED_DATA_SOURCE } from '../database/database.module';
import { LocalAccessService, type LocalProfile } from '../local-access.service';
import { LessonHistory } from './lesson-history.entity';
import {
  collectionCursorScope, encodeCollectionCursor, lessonLabelSort, paginateLessonCollection, readCollectionCursor,
  type LessonPageRequest, type LessonSortKey,
} from './lesson-pagination';
import {
  attachVoteSummaries, includeLatestReviewGuidance, toLessonDraftResponse, toLessonLibraryResponse,
} from './lesson-read-model';
import type {
  ContributorProfileResponse, ProfileSearchPage, ProfileSummaryResponse,
  RankedContributorResponse, RankedLessonResponse, RankingsResponse,
} from './lesson-response.dto';
import { applyLessonSearchFilters, normalizeLessonSearch } from './lesson-search';
import type {
  ContributorProfileFilter, ContributorProfileSort, ProfileSearchFilter,
} from './lesson-submissions-query.dto';
import { Lesson } from './lesson.entity';
import type { LessonProject } from './project-catalog.service';

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
export class ContributionQueriesService {
  constructor(
    @Inject(LocalAccessService) private readonly localAccess: LocalAccessService,
    @Optional() @Inject(LESSONS_LEARNED_DATA_SOURCE) private readonly dataSource?: DataSource,
  ) {}

  async searchProfiles(
    localUserId: string | undefined,
    filters: ProfileSearchFilter,
    page?: LessonPageRequest,
  ): Promise<ProfileSearchPage | ProfileSummaryResponse[]> {
    const caller = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    const normalizedSearch = normalizeLessonSearch(filters.search?.trim() ?? '');
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
      .filter((profile) => !normalizedSearch || normalizeLessonSearch(profile.displayName).includes(normalizedSearch))
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
      applyLessonSearchFilters(query, {
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
        ? await includeLatestReviewGuidance(
          lessons.map((lesson) => toLessonDraftResponse(lesson)),
          manager.getRepository(LessonHistory),
        )
        : [];
      const guidanceById = new Map(baseWithGuidance.map((item) => [item.id, item.latestReviewGuidance]));

      const libraryItems = await attachVoteSummaries(
        lessons.map((lesson) => ({
          ...toLessonLibraryResponse(lesson, authorNames),
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

  private requireDataSource(): DataSource {
    if (!this.dataSource) {
      throw new ServiceUnavailableException('Lessons Learned persistence is unavailable.');
    }
    return this.dataSource;
  }
}
