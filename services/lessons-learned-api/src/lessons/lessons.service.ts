import {
  BadRequestException,
  ConflictException,
  Inject,
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
      .execute();

    if (!result.affected) {
      const latest = await repository.findOne({ where: { id: lessonId, authorId: profile.id } });
      if (!latest) throw new NotFoundException('Lesson not found.');
      if (latest.status !== 'Open') {
        throw new ConflictException({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be edited.' });
      }
      throw this.staleVersionConflict();
    }

    const updated = await repository.findOneByOrFail({ id: lessonId });
    return this.toResponse(updated);
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
    const catalogMatches = this.projectCatalog.list().some(
      (project) => project.id === projectId && project.name === projectName,
    );
    if (!unchangedSnapshot && !catalogMatches) {
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
}
