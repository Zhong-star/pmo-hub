import {
  BadRequestException,
  ConflictException,
  Inject,
  InternalServerErrorException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LocalAccessService } from '../local-access.service';
import { LESSONS_LEARNED_DATA_SOURCE } from '../database/database.module';
import { LessonHistory } from './lesson-history.entity';
import { Lesson } from './lesson.entity';
import type { CreateLessonRequest } from './create-lesson-request.dto';
import { ProjectCatalogService, type LessonProject } from './project-catalog.service';
import type { SubmitLessonRequest } from './submit-lesson-request.dto';
import type { UpdateLessonDraftRequest } from './update-lesson-draft-request.dto';
import type { LessonDraftResponse } from './lesson-response.dto';

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
    return lessons.map((lesson) => this.toResponse(lesson));
  }

  getProjects(localUserId: string | undefined): LessonProject[] {
    this.localAccess.getProfile(localUserId);
    return this.projectCatalog.list();
  }

  async updateOwnOpenDraft(
    localUserId: string | undefined,
    lessonId: number,
    input: UpdateLessonDraftRequest,
  ): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const repository = this.requireDataSource().getRepository(Lesson);
    const current = await repository.findOne({ where: { id: lessonId, authorId: profile.id } });
    if (!current) throw new NotFoundException('Lesson not found.');
    if (current.status !== 'Open') {
      throw new ConflictException({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be edited.' });
    }
    if (current.version !== input.version) throw this.staleVersionConflict();

    const projectId = input.projectId === undefined ? current.projectId : input.projectId;
    const projectName = input.projectName === undefined ? current.projectName : input.projectName;
    this.validateProjectSelection(current, projectId, projectName);

    const result = await repository.createQueryBuilder()
      .update(Lesson)
      .set({
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
        updatedBy: profile.id,
        version: () => '"version" + 1',
        updatedAt: () => 'CURRENT_TIMESTAMP',
      })
      .where('id = :lessonId AND author_id = :authorId AND status = :status AND version = :version', {
        lessonId,
        authorId: profile.id,
        status: 'Open',
        version: input.version,
      })
      .returning('*')
      .execute();

    if (!result.affected) {
      const latest = await repository.findOne({ where: { id: lessonId, authorId: profile.id } });
      if (!latest) throw new NotFoundException('Lesson not found.');
      if (latest.status !== 'Open') {
        throw new ConflictException({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be edited.' });
      }
      throw this.staleVersionConflict();
    }

    const updated = result.raw[0] as Record<string, unknown> | undefined;
    if (!updated) throw new InternalServerErrorException('The updated draft could not be returned.');
    return this.toResponseFromDatabaseRow(updated);
  }

  async submitOwnOpenDraft(
    localUserId: string | undefined,
    lessonId: number,
    input: SubmitLessonRequest,
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

  private staleVersionConflict(): ConflictException {
    return new ConflictException({
      code: 'STALE_LESSON_VERSION',
      message: 'This draft changed after you opened it. Reload the current version before saving again.',
    });
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
      createdAt: lesson.createdAt,
      updatedAt: lesson.updatedAt,
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
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
