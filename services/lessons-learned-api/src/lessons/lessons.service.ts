import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LocalAccessService } from '../local-access.service';
import { LESSONS_LEARNED_DATA_SOURCE } from '../database/database.module';
import { LessonHistory } from './lesson-history.entity';
import { Lesson } from './lesson.entity';
import type { LessonDraftResponse } from './lesson-response.dto';

@Injectable()
export class LessonsService {
  constructor(
    @Inject(LocalAccessService) private readonly localAccess: LocalAccessService,
    @Optional() @Inject(LESSONS_LEARNED_DATA_SOURCE) private readonly dataSource?: DataSource,
  ) {}

  async createDraft(localUserId: string | undefined, title: string): Promise<LessonDraftResponse> {
    const profile = this.localAccess.getProfile(localUserId);
    const dataSource = this.requireDataSource();

    const lesson = await dataSource.transaction(async (manager) => {
      const lessons = manager.getRepository(Lesson);
      const created = await lessons.save(lessons.create({
        title,
        authorId: profile.id,
        status: 'Open',
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
      status: lesson.status,
      createdAt: lesson.createdAt,
      updatedAt: lesson.updatedAt,
    };
  }
}
