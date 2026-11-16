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
import { DataSource, In, type SelectQueryBuilder } from 'typeorm';
import { LocalAccessService } from '../local-access.service';
import { LESSONS_LEARNED_DATA_SOURCE } from '../database/database.module';
import { LessonHistory } from './lesson-history.entity';
import { Lesson } from './lesson.entity';
import {
  encodeProjectCursor, paginateLessons, readProjectCursor, type LessonPage, type LessonPageRequest, type LessonProjectPage,
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
import type { LessonDetailsResponse, LessonDraftResponse, LessonHistoryEventResponse } from './lesson-response.dto';
import type {
  LessonSearchFilters,
  LessonSubmissionsFilter,
  PmoDraftsFilter,
  PmoEvaluationQueueFilter,
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

@Injectable()
export class LessonsService {
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
      return paginateLessons(query, page, scope, lastSubmission, 'ASC', (lesson) => this.toResponse(lesson));
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

  async getLibrary(localUserId: string | undefined, page?: LessonPageRequest): Promise<LessonDraftResponse[] | LessonPage> {
    this.localAccess.getProfile(localUserId);
    const query = this.requireDataSource().getRepository(Lesson).createQueryBuilder('lesson')
      .where('lesson.status IN (:...publishedStatuses)', { publishedStatuses: ['Approved', 'Closed'] })
      .andWhere('lesson.approved_at IS NOT NULL');
    if (page) return paginateLessons(query, page, 'library', 'lesson.approved_at', 'DESC', (lesson) => this.toResponse(lesson));
    const lessons = await query
      .orderBy('lesson.approvedAt', 'DESC')
      .addOrderBy('lesson.id', 'DESC')
      .getMany();
    return lessons.map((lesson) => this.toResponse(lesson));
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

  private applySearchFilters(query: SelectQueryBuilder<Lesson>, filters: LessonSearchFilters): void {
    if (filters.search) {
      if (/^\d+$/.test(filters.search)) {
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

      const history = isPmo || isAuthor
        ? await manager.getRepository(LessonHistory).find({
          where: { lessonId },
          order: { occurredAt: 'ASC', id: 'ASC' },
        })
        : [];
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
      return { ...this.toResponse(lesson), latestReviewGuidance, history: historyResponse };
    });
  }

  async cancelOpenDraft(
    localUserId: string | undefined,
    lessonId: number,
    input: CancelLessonRequest,
    usesIfMatch = false,
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
      if (usesIfMatch && current.version !== input.version) throw this.staleVersionConflict();
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
    usesIfMatch = false,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to approve lessons.');
    }
    const dataSource = this.requireDataSource();

    return dataSource.transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const current = await lessons.findOne({
        where: { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException('Lesson not found.');
      if (usesIfMatch && current.version !== input.version) throw this.staleVersionConflict();
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
      const approved = await lessons.save(current);

      const history = manager.getRepository(LessonHistory);
      await history.save(history.create({
        lessonId: approved.id,
        actorId: profile.id,
        eventType: 'Approved',
        previousStatus: 'PMOEvaluation',
        newStatus: 'Approved',
      }));

      return this.toResponse(approved);
    });
  }

  async rejectEvaluation(
    localUserId: string | undefined,
    lessonId: number,
    input: RejectLessonRequest,
    usesIfMatch = false,
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

    return dataSource.transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const current = await lessons.findOne({
        where: { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException('Lesson not found.');
      if (usesIfMatch && current.version !== input.version) throw this.staleVersionConflict();
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
      const rejected = await lessons.save(current);
      await manager.getRepository(LessonHistory).save(manager.getRepository(LessonHistory).create({
        lessonId: rejected.id,
        actorId: profile.id,
        eventType: 'Rejected',
        previousStatus: 'PMOEvaluation',
        newStatus: 'Archived',
        reason,
      }));

      return this.toResponse(rejected);
    });
  }

  async closeApprovedLesson(
    localUserId: string | undefined,
    lessonId: number,
    input: CloseLessonRequest,
    usesIfMatch = false,
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
      if (usesIfMatch && current.version !== input.version) throw this.staleVersionConflict();
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
    usesIfMatch = false,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const repository = this.requireDataSource().getRepository(Lesson);
    const current = await repository.findOne({ where: { id: lessonId } });
    if (!current || (profile.role !== 'LESSONS_MODERATOR' && current.authorId !== profile.id)) {
      throw new NotFoundException('Lesson not found.');
    }
    if (usesIfMatch && current.version !== input.version) throw this.staleVersionConflict();
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
        if (usesIfMatch && latest.version !== input.version) throw this.staleVersionConflict();
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
    usesIfMatch = false,
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
      if (usesIfMatch && current.version !== input.version) throw this.staleVersionConflict();
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
    usesIfMatch = false,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    if (profile.role !== 'LESSONS_MODERATOR') {
      throw new ForbiddenException('PMO moderator access is required to return a lesson for changes.');
    }

    return this.requireDataSource().transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const current = await lessons.findOne({
        where: { id: lessonId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw new NotFoundException('Lesson not found.');
      if (usesIfMatch && current.version !== input.version) throw this.staleVersionConflict();
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

      current.status = 'Open';
      current.updatedBy = profile.id;
      current.version += 1;
      const returned = await lessons.save(current);
      const history = manager.getRepository(LessonHistory);
      await history.save(history.create({
        lessonId: returned.id,
        actorId: profile.id,
        eventType: 'Returned',
        previousStatus: 'PMOEvaluation',
        newStatus: 'Open',
        reason: input.guidance.trim(),
      }));
      return { ...this.toResponse(returned), latestReviewGuidance: input.guidance.trim() };
    });
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
