import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { LESSONS_LEARNED_DATA_SOURCE } from '../src/database/database.module';

const execFileAsync = promisify(execFile);

describe('Lessons Learned PostgreSQL persistence', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('lessons_learned_test')
      .withUsername('lessons_learned_test')
      .withPassword('test_only_password')
      .start();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(container.getConnectionUri())],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    dataSource = app.get<DataSource>(LESSONS_LEARNED_DATA_SOURCE);
  }, 120_000);

  afterAll(async () => {
    try {
      if (app) {
        await app.close();
        if (dataSource) {
          expect(dataSource.isInitialized).toBe(false);
        }
      }
    } finally {
      await container?.stop();
    }
  }, 120_000);

  it('connects the API to its own PostgreSQL and serves health', async () => {
    if (!app || !dataSource) {
      throw new Error('The PostgreSQL integration environment did not start.');
    }

    expect(dataSource.isInitialized).toBe(true);
    expect(await dataSource.query('SELECT 1 AS connected')).toEqual([{ connected: 1 }]);

    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('runs the documented migration command when there are no business migrations', async () => {
    if (!container) {
      throw new Error('The PostgreSQL integration container did not start.');
    }

    const result = await execFileAsync('npm', ['run', 'migration:run'], {
      cwd: resolve(__dirname, '..'),
      env: {
        ...process.env,
        LESSONS_LEARNED_DATABASE_URL: container.getConnectionUri(),
      },
      maxBuffer: 1024 * 1024,
      shell: process.platform === 'win32',
      timeout: 120_000,
      windowsHide: true,
    });

    expect(result.stdout).toContain('No migrations are pending');
  });
});
