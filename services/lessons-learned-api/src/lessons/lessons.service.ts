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
import { DataSource, type SelectQueryBuilder } from 'typeorm';
import { LocalAccessService } from '../local-access.service';
import { LESSONS_LEARNED_DATA_SOURCE } from '../database/database.module';
import { emitsRepresentationTokens } from './lesson-token-format';
import { LessonHistory } from './lesson-history.entity';
import { Lesson } from './lesson.entity';
import {
  attachVoteSummaries, getVoteSummary, includeLatestReviewGuidance, readDetailsRepresentation,
  toLessonDraftResponse, toLessonLibraryResponse, withLibraryAuthor,
} from './lesson-read-model';
import { applyLessonSearchFilters } from './lesson-search';
import { evaluationCompletenessErrors, validateProjectSelection, type EvaluationFields } from './lesson-validation';
import { checkLessonIfMatch, staleLessonVersionConflict } from './lesson-version';
import {
  collectionCursorScope, encodeProjectCursor, lessonLabelSort, paginateLessonCollection,
  paginateLibraryLessonsByTextKey, paginateLibraryLessonsByVotes, paginateLessons, readProjectCursor,
  type LessonSortKey,
  type LessonLibraryPage, type LessonPage, type LessonPageRequest, type LessonProjectPage,
} from './lesson-pagination';
import type { CreateLessonRequest } from './create-lesson-request.dto';
import { ProjectCatalogService, type LessonProject } from './project-catalog.service';
import type { UpdateLessonDraftRequest } from './update-lesson-draft-request.dto';
import type {
  LessonDetailsResponse, LessonDraftResponse,
  LessonLibraryResponse, LessonVoteResponse, PmoDashboardLessonResponse, PmoDashboardResponse,
  RecordLessonLibraryViewResponse,
} from './lesson-response.dto';
import type { RecordLibraryViewRequest } from './record-library-view-request.dto';
import type {
  LessonsLibraryFilter,
  LessonsLibrarySort,
  LessonSubmissionsFilter,
  PmoDashboardCard,
  PmoDashboardFilter,
  PmoDraftsFilter,
  PmoEvaluationQueueFilter,
} from './lesson-submissions-query.dto';

@Injectable()
export class LessonsService {
  private readonly representationTokens = emitsRepresentationTokens();

  constructor(
    @Inject(LocalAccessService) private readonly localAccess: LocalAccessService,
    @Inject(ProjectCatalogService) private readonly projectCatalog: ProjectCatalogService,
    @Optional() @Inject(LESSONS_LEARNED_DATA_SOURCE) private readonly dataSource?: DataSource,
  ) {}

  async createDraft(localUserId: string | undefined, input: CreateLessonRequest): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();
    const projectId = input.projectId ?? null;
    const projectName = input.projectName ?? null;
    validateProjectSelection(this.projectCatalog, null, projectId, projectName);

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

    return toLessonDraftResponse(lesson);
  }

  async getMyOpenDrafts(localUserId: string | undefined): Promise<LessonDraftResponse[]> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();
    const lessons = await dataSource.getRepository(Lesson).find({
      where: { authorId: profile.id, status: 'Open' },
      order: { updatedAt: 'DESC', id: 'DESC' },
    });
    return includeLatestReviewGuidance(lessons.map(toLessonDraftResponse), dataSource.getRepository(LessonHistory));
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
      applyLessonSearchFilters(query, filters, true);
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
      const drafts = await includeLatestReviewGuidance(
        entities.map(toLessonDraftResponse),
        manager.getRepository(LessonHistory),
      );
      const items: PmoDashboardLessonResponse[] = entities.map((lesson, index) => ({
        ...toLessonLibraryResponse(lesson, authorNames),
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
    applyLessonSearchFilters(query, filters);

    const lastSubmission = `(SELECT MAX(queue_history.occurred_at)
          FROM lesson_history queue_history
          WHERE queue_history.lesson_id = lesson.id
            AND queue_history.event_type = 'Submitted'
            AND queue_history.new_status = 'PMOEvaluation')`;
    if (page) {
      const scope = JSON.stringify(['queue', filters.search, filters.projectId, Boolean(filters.withoutProject), filters.lessonType]);
      return paginateLessons(query, page, scope, lastSubmission, 'ASC', toLessonDraftResponse, this.representationTokens);
    }
    const lessons = await query
      .addSelect(lastSubmission, 'last_evaluation_submission_at')
      .orderBy('last_evaluation_submission_at', 'ASC')
      .addOrderBy('lesson.id', 'ASC')
      .getMany();
    return lessons.map(toLessonDraftResponse);
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
    applyLessonSearchFilters(query, filters, true);
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
      const toResponse = (lesson: Lesson) => toLessonLibraryResponse(lesson, authorNames, 0);
      const result = sort === 'newest'
        ? await paginateLessons(query, page, scope, 'lesson.approved_at', 'DESC', toResponse, this.representationTokens)
        : sort === 'oldest'
          ? await paginateLessons(query, page, scope, 'lesson.approved_at', 'ASC', toResponse, this.representationTokens)
          : sort === 'most-voted'
            ? await paginateLibraryLessonsByVotes(query, page, scope, toResponse, this.representationTokens)
            : await paginateLibraryLessonsByTextKey(query, page, scope, sort, toResponse, this.representationTokens);
      const counts = await this.getPublicCommentCounts(result.items.map(({ id }) => id));
      const withVotes = await attachVoteSummaries(result.items, profile.id, dataSource.manager);
      return {
        ...result,
        items: withVotes.map((item) => ({ ...item, commentCount: counts.get(item.id) ?? 0 })),
      };
    }
    const lessons = await this.orderLibrary(query, sort).getMany();
    const counts = await this.getPublicCommentCounts(lessons.map(({ id }) => id));
    return attachVoteSummaries(
      lessons.map((lesson) => toLessonLibraryResponse(lesson, authorNames, counts.get(lesson.id) ?? 0)),
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

      const details = await readDetailsRepresentation(lesson, profile, manager);
      return withLibraryAuthor(details, this.localAccess);
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

      const summary = await getVoteSummary(lessonId, profile.id, manager);
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
    const dataSource = this.requireDataSource();
    const query = dataSource.getRepository(Lesson).createQueryBuilder('lesson')
      .where(onlyAuthorId ? 'lesson.author_id = :onlyAuthorId' : '1 = 1', onlyAuthorId ? { onlyAuthorId } : {});
    if (filters.authorId) query.andWhere('lesson.author_id = :authorId', { authorId: filters.authorId });
    applyLessonSearchFilters(query, filters);
    if (filters.status) query.andWhere('lesson.status = :status', { status: filters.status });

    const lessons = await query.orderBy('lesson.updated_at', 'DESC').addOrderBy('lesson.id', 'DESC').getMany();
    return includeLatestReviewGuidance(lessons.map(toLessonDraftResponse), dataSource.getRepository(LessonHistory));
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

      return readDetailsRepresentation(lesson, profile, manager);
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
    if (ifMatch && current.version !== input.version) throw staleLessonVersionConflict();
    const canEditEvaluation = current.status === 'PMOEvaluation' && profile.role === 'LESSONS_MODERATOR';
    if (current.status !== 'Open' && !canEditEvaluation) {
      throw new ConflictException({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be edited.' });
    }
    if (current.version !== input.version) throw staleLessonVersionConflict();

    const projectId = input.projectId === undefined ? current.projectId : input.projectId;
    const projectName = input.projectName === undefined ? current.projectName : input.projectName;
    try {
      validateProjectSelection(this.projectCatalog, current, projectId, projectName);
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
      await checkLessonIfMatch(ifMatch, input.version, current, profile, manager, this.localAccess);
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
        if (ifMatch && latest.version !== input.version) throw staleLessonVersionConflict();
        if (latest.status !== current.status) {
          if (current.status === 'PMOEvaluation') {
            throw new ConflictException({
              code: 'LESSON_NOT_IN_EVALUATION',
              message: 'This lesson is no longer in PMO evaluation. Reload its current status before saving again.',
            });
          }
          throw new ConflictException({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be edited.' });
        }
        throw staleLessonVersionConflict();
      }

      const updated = result.raw[0] as Record<string, unknown> | undefined;
      if (!updated) throw new InternalServerErrorException('The updated draft could not be returned.');
      const [response] = await includeLatestReviewGuidance(
        [this.toResponseFromDatabaseRow(updated)],
        manager.getRepository(LessonHistory),
      );
      return response!;
    });
  }

  private validateEvaluationCompleteness(fields: EvaluationFields): void {
    const fieldErrors = evaluationCompletenessErrors(fields);
    if (Object.keys(fieldErrors).length > 0) {
      throw new BadRequestException({
        code: 'INVALID_LESSON_EDIT',
        message: 'Correct the indicated fields before saving.',
        fieldErrors,
      });
    }
  }

  private requireDataSource(): DataSource {
    if (!this.dataSource) {
      throw new ServiceUnavailableException('Lessons Learned persistence is unavailable.');
    }
    return this.dataSource;
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
