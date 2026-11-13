import { DataSource } from 'typeorm';
import {
  createLessonsLearnedDataSourceOptions,
  getLessonsLearnedDatabaseUrl,
  LESSONS_LEARNED_DATABASE_URL_ENV,
} from './database-options';

const databaseUrl = getLessonsLearnedDatabaseUrl();
if (!databaseUrl) {
  throw new Error(`Set ${LESSONS_LEARNED_DATABASE_URL_ENV} before running database migrations.`);
}

export const LessonsLearnedDataSource = new DataSource(
  createLessonsLearnedDataSourceOptions(databaseUrl),
);
