import { resolve } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { LessonHistory } from '../lessons/lesson-history.entity';
import { Lesson } from '../lessons/lesson.entity';

export const LESSONS_LEARNED_DATABASE_URL_ENV = 'LESSONS_LEARNED_DATABASE_URL';

export function getLessonsLearnedDatabaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  const databaseUrl = environment[LESSONS_LEARNED_DATABASE_URL_ENV]?.trim();
  return databaseUrl || undefined;
}

export function createLessonsLearnedDataSourceOptions(databaseUrl: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    entities: [Lesson, LessonHistory],
    migrations: [resolve(__dirname, 'migrations/*{.js,.ts}')],
    migrationsRun: false,
    synchronize: false,
  };
}
