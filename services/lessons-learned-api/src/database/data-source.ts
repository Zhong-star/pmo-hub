import { DataSource } from 'typeorm';
import {
  createLessonsLearnedDataSourceOptions,
  getLessonsLearnedDatabaseUrl,
  LESSONS_LEARNED_DATABASE_URL_ENV,
} from './database-options';

export function createLessonsLearnedDataSource(databaseUrl = getLessonsLearnedDatabaseUrl()): DataSource {
  if (!databaseUrl) {
    throw new Error(`Set ${LESSONS_LEARNED_DATABASE_URL_ENV} before running database migrations.`);
  }

  return new DataSource(createLessonsLearnedDataSourceOptions(databaseUrl));
}

export const LessonsLearnedDataSource = createLessonsLearnedDataSource();
