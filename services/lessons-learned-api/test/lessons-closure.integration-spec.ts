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

describe('Lessons Learned closure', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let temporaryDirectory: string;
  let profilesPath: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-lessons-closure-'));
    profilesPath = join(temporaryDirectory, 'local-users.json');
    writeFileSync(profilesPath, JSON.stringify([
      { id: 'local-other-contributor', displayName: 'Other Contributor', role: 'LESSONS_USER' },
      { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' },
      { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' },
    ]), 'utf8');
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = profilesPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';

    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('lessons_learned_closure_test')
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

  it('lets PMO close an approved lesson while preserving its original Library publication date', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        title: 'Preserve the publication when a lesson closes',
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The release handover omitted the current runbook.',
        rootCause: 'No checklist owner had been assigned.',
        lessonType: 'Future Prevention',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to review the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ ...created.body, version: created.body.version })
      .expect(200);
    const approved = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version })
      .expect(200);

    const closed = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/close`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: approved.body.version })
      .expect(200);

    expect(closed.body).toMatchObject({
      id: created.body.id,
      authorId: 'local-contributor',
      updatedBy: 'local-pmo',
      status: 'Closed',
      version: approved.body.version + 1,
      approvedAt: approved.body.approvedAt,
    });
    await server
      .get('/api/lessons-learned/v1/lessons/library')
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(200)
      .expect(({ body }) => expect(body).toContainEqual(expect.objectContaining({
        id: created.body.id,
        status: 'Closed',
        approvedAt: approved.body.approvedAt,
      })));
    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.history.at(-1)).toMatchObject({
        actorId: 'local-pmo',
        eventType: 'Closed',
        previousStatus: 'Approved',
        newStatus: 'Closed',
      }));
    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('Closed');
        expect(body.approvedAt).toBe(approved.body.approvedAt);
        expect(body.history).toEqual([]);
      });
  });

  it('checks PMO permission, Approved state, and the submitted version before closing', async () => {
    const server = request(app!.getHttpServer());
    const publish = async (title: string) => {
      const created = await server
        .post('/api/lessons-learned/v1/lessons')
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({
          title,
          projectCategory: 'Technology',
          projectPhase: 'Execution',
          situationObserved: 'The release handover omitted the current runbook.',
          rootCause: 'No checklist owner had been assigned.',
          lessonType: 'Future Prevention',
          impact: 'The release team repeated verification work.',
          recommendation: 'Assign an owner to review the checklist.',
          applicability: 'Use for releases with shared operational ownership.',
        })
        .expect(201);
      const submitted = await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({ ...created.body, version: created.body.version })
        .expect(200);
      return server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version })
        .expect(200);
    };

    const approved = await publish('Reject unauthorized and stale closure decisions');
    await server
      .post(`/api/lessons-learned/v1/lessons/${approved.body.id}/close`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: approved.body.version })
      .expect(403);

    await dataSource!.query(
      'UPDATE lessons SET version = version + 1 WHERE id = $1',
      [approved.body.id],
    );
    const stale = await server
      .post(`/api/lessons-learned/v1/lessons/${approved.body.id}/close`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: approved.body.version })
      .expect(409);
    expect(stale.body.code).toBe('STALE_LESSON_VERSION');

    const openDraft = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'A draft cannot be closed as published' })
      .expect(201);
    const wrongState = await server
      .post(`/api/lessons-learned/v1/lessons/${openDraft.body.id}/close`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: openDraft.body.version })
      .expect(409);
    expect(wrongState.body.code).toBe('LESSON_NOT_APPROVED');

    await server
      .get(`/api/lessons-learned/v1/lessons/${approved.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('Approved');
        expect(body.history.filter(({ eventType }: { eventType: string }) => eventType === 'Closed')).toHaveLength(0);
      });
  });

  it('rolls back a failed history write and records one event for concurrent closure decisions', async () => {
    if (!dataSource) throw new Error('The PostgreSQL test database did not start.');
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        title: 'Keep closure and history atomic',
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The release handover omitted the current runbook.',
        rootCause: 'No checklist owner had been assigned.',
        lessonType: 'Future Prevention',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to review the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ ...created.body, version: created.body.version })
      .expect(200);
    const approved = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version })
      .expect(200);
    await dataSource.query(`
      CREATE FUNCTION reject_closed_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'Closed' THEN RAISE EXCEPTION 'closure history write intentionally rejected'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_closed_history_insert
      BEFORE INSERT ON lesson_history FOR EACH ROW EXECUTE FUNCTION reject_closed_history();
    `);

    try {
      await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/close`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: approved.body.version })
        .expect(500);

      expect(await dataSource.query(
        'SELECT status, version, approved_at FROM lessons WHERE id = $1',
        [created.body.id],
      )).toEqual([{
        status: 'Approved',
        version: approved.body.version,
        approved_at: new Date(approved.body.approvedAt),
      }]);
      expect(await dataSource.query(
        "SELECT event_type FROM lesson_history WHERE lesson_id = $1 AND event_type = 'Closed'",
        [created.body.id],
      )).toEqual([]);
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS reject_closed_history_insert ON lesson_history');
      await dataSource.query('DROP FUNCTION IF EXISTS reject_closed_history()');
    }

    const closePath = `/api/lessons-learned/v1/lessons/${created.body.id}/close`;
    const decisions = await Promise.all([
      server.post(closePath)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: approved.body.version }),
      server.post(closePath)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: approved.body.version }),
    ]);
    expect(decisions.map(({ status }) => status).sort()).toEqual([200, 409]);
    const conflict = decisions.find(({ status }) => status === 409);
    expect(conflict?.body.code).toBe('LESSON_NOT_APPROVED');
    expect(await dataSource.query('SELECT status, version, approved_at FROM lessons WHERE id = $1', [created.body.id]))
      .toEqual([{
        status: 'Closed',
        version: approved.body.version + 1,
        approved_at: new Date(approved.body.approvedAt),
      }]);
    expect(await dataSource.query(
      "SELECT actor_id, event_type, previous_status, new_status FROM lesson_history WHERE lesson_id = $1 AND event_type = 'Closed'",
      [created.body.id],
    )).toEqual([{
      actor_id: 'local-pmo',
      event_type: 'Closed',
      previous_status: 'Approved',
      new_status: 'Closed',
    }]);
  });
});
