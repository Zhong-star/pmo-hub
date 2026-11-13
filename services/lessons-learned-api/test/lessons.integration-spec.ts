import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { LESSONS_LEARNED_DATA_SOURCE } from '../src/database/database.module';

describe('Lessons Learned draft registration', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let temporaryDirectory: string;
  let profilesPath: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;

  const profiles = [
    { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' },
    { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' },
  ];

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-lessons-registration-'));
    profilesPath = join(temporaryDirectory, 'local-users.json');
    writeFileSync(profilesPath, JSON.stringify(profiles), 'utf8');
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = profilesPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';

    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('lessons_learned_registration_test')
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
    await dataSource.runMigrations();
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await container?.stop();
      rmSync(temporaryDirectory, { recursive: true, force: true });
      if (previousProfilesFile === undefined) delete process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
      else process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = previousProfilesFile;
      if (previousLocalAuthEnabled === undefined) delete process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;
      else process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = previousLocalAuthEnabled;
    }
  }, 120_000);

  beforeEach(async () => {
    await dataSource?.query('TRUNCATE lesson_history, lessons RESTART IDENTITY CASCADE');
  });

  it.each(['local-contributor', 'local-pmo'])(
    '%s creates a title-only Open draft and can retrieve only their own drafts',
    async (profileId) => {
      const created = await request(app!.getHttpServer())
        .post('/api/lessons-learned/v1/lessons')
        .set('X-PMO-Local-User-ID', profileId)
        .send({ title: 'Improve release handover' })
        .expect(201);

      expect(created.body).toMatchObject({
        id: expect.any(Number),
        title: 'Improve release handover',
        authorId: profileId,
        status: 'Open',
      });
      expect(await dataSource?.query(
        'SELECT actor_id, event_type, previous_status, new_status FROM lesson_history WHERE lesson_id = $1',
        [created.body.id],
      )).toEqual([{
        actor_id: profileId,
        event_type: 'Created',
        previous_status: null,
        new_status: 'Open',
      }]);

      await request(app!.getHttpServer())
        .get('/api/lessons-learned/v1/lessons')
        .set('X-PMO-Local-User-ID', profileId)
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual([created.body]);
        });

      await request(app!.getHttpServer())
        .get('/api/lessons-learned/v1/lessons')
        .set('X-PMO-Local-User-ID', profileId === 'local-pmo' ? 'local-contributor' : 'local-pmo')
        .expect(200)
        .expect(({ body }) => expect(body).toEqual([]));
    },
  );

  it('requires an authorized current profile and validates a nonempty title up to 150 characters', async () => {
    await request(app!.getHttpServer())
      .post('/api/lessons-learned/v1/lessons')
      .send({ title: 'Unauthorized' })
      .expect(401);

    await request(app!.getHttpServer())
      .get('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'unknown-profile')
      .expect(403);

    await request(app!.getHttpServer())
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'unknown-profile')
      .send({ title: 'Unauthorized' })
      .expect(403);

    for (const title of ['', '   ', 'x'.repeat(151)]) {
      const response = await request(app!.getHttpServer())
        .post('/api/lessons-learned/v1/lessons')
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({ title });
      expect(response.status, `title ${JSON.stringify(title)}; response ${JSON.stringify(response.body)}`).toBe(400);
    }

    await request(app!.getHttpServer())
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'x'.repeat(150) })
      .expect(201);
  });

  it('rolls back the draft when recording its creation history fails', async () => {
    if (!dataSource) throw new Error('The PostgreSQL test database did not start.');
    await dataSource.query(`
      CREATE FUNCTION reject_lesson_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'history write intentionally rejected'; END;
      $$;
      CREATE TRIGGER reject_lesson_history_insert
      BEFORE INSERT ON lesson_history FOR EACH ROW EXECUTE FUNCTION reject_lesson_history();
    `);

    await request(app!.getHttpServer())
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'This draft must roll back' })
      .expect(500);

    expect(await dataSource.query('SELECT title FROM lessons WHERE title = $1', ['This draft must roll back']))
      .toEqual([]);
    expect(await dataSource.query('SELECT id FROM lesson_history')).toEqual([]);
    await dataSource.query('DROP TRIGGER reject_lesson_history_insert ON lesson_history');
    await dataSource.query('DROP FUNCTION reject_lesson_history()');
  });
});
