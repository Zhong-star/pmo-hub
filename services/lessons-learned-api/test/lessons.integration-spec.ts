import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import { DataSource, type EntitySubscriberInterface } from 'typeorm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { LESSONS_LEARNED_DATA_SOURCE } from '../src/database/database.module';
import { Lesson } from '../src/lessons/lesson.entity';
import { LessonHistory } from '../src/lessons/lesson-history.entity';

describe('Lessons Learned draft registration', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let temporaryDirectory: string;
  let profilesPath: string;
  let projectsPath: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;
  const previousProjectsFile = process.env.LESSONS_LEARNED_PROJECTS_FILE;
  const previousTokenFormat = process.env.LESSONS_LEARNED_TOKEN_FORMAT;

  const profiles = [
    { id: 'local-other-contributor', displayName: 'Other Contributor', role: 'LESSONS_USER' },
    { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' },
    { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' },
  ];

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-lessons-registration-'));
    profilesPath = join(temporaryDirectory, 'local-users.json');
    writeFileSync(profilesPath, JSON.stringify(profiles), 'utf8');
    projectsPath = join(temporaryDirectory, 'projects.json');
    writeFileSync(projectsPath, JSON.stringify([
      { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' },
      { id: 'LOCAL-PROJECT-002', name: 'Fictional Harbor Migration' },
    ]), 'utf8');
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = profilesPath;
    process.env.LESSONS_LEARNED_PROJECTS_FILE = projectsPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';
    process.env.LESSONS_LEARNED_TOKEN_FORMAT = 'representation';

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
      if (previousProjectsFile === undefined) delete process.env.LESSONS_LEARNED_PROJECTS_FILE;
      else process.env.LESSONS_LEARNED_PROJECTS_FILE = previousProjectsFile;
      if (previousLocalAuthEnabled === undefined) delete process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;
      else process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = previousLocalAuthEnabled;
      if (previousTokenFormat === undefined) delete process.env.LESSONS_LEARNED_TOKEN_FORMAT;
      else process.env.LESSONS_LEARNED_TOKEN_FORMAT = previousTokenFormat;
    }
  }, 120_000);

  beforeEach(async () => {
    await dataSource?.query('TRUNCATE lesson_history, lessons RESTART IDENTITY CASCADE');
    writeFileSync(projectsPath, JSON.stringify([
      { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' },
      { id: 'LOCAL-PROJECT-002', name: 'Fictional Harbor Migration' },
    ]), 'utf8');
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

  it('lets the author cancel an Open draft and retains the Archived lesson in their submissions', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Cancel a lesson that is no longer useful' })
      .expect(201);
    const reason = 'x'.repeat(1000);

    await server
      .get('/api/lessons-learned/v1/lessons/mine')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body).toEqual([created.body]));

    const cancelled = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/cancel`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: created.body.version, reason })
      .expect(200);

    expect(cancelled.body).toMatchObject({
      id: created.body.id,
      authorId: 'local-contributor',
      updatedBy: 'local-contributor',
      status: 'Archived',
      version: created.body.version + 1,
    });
    expect(await dataSource?.query(
      'SELECT event_type, previous_status, new_status, reason FROM lesson_history WHERE lesson_id = $1 ORDER BY id',
      [created.body.id],
    )).toEqual([
      { event_type: 'Created', previous_status: null, new_status: 'Open', reason: null },
      { event_type: 'Cancelled', previous_status: 'Open', new_status: 'Archived', reason },
    ]);

    await server
      .get('/api/lessons-learned/v1/lessons/mine')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body).toEqual([cancelled.body]));

    await server
      .get('/api/lessons-learned/v1/lessons/mine')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body).toEqual([]));

    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/cancel`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: cancelled.body.version, reason: 'Trying again.' })
      .expect(409);
    expect(await dataSource?.query(
      'SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id',
      [created.body.id],
    )).toEqual([{ event_type: 'Created' }, { event_type: 'Cancelled' }]);
  });

  it('filters My Submissions across every status without exposing another profile’s lessons and returns own detail history', async () => {
    const server = request(app!.getHttpServer());
    const create = async (profileId: string, title: string, project: boolean, lessonType: string) => server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', profileId)
      .send({
        title,
        ...(project ? { projectId: 'LOCAL-PROJECT-001', projectName: 'Fictional Atlas Modernization' } : {}),
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: `Observed ${title}`,
        rootCause: 'A handover checklist was not shared.',
        lessonType,
        impact: 'The team repeated verification work.',
        recommendation: 'Share the checklist before release.',
        applicability: 'Use for software releases.',
      })
      .expect(201);

    const open = await create('local-contributor', 'Zebra release checklist', false, 'Communication');
    const submitted = await create('local-contributor', 'Alpha release handover', true, 'Future Prevention');
    const approved = await create('local-contributor', 'Bravo deployment lesson', true, 'Communication');
    const closed = await create('local-contributor', 'Charlie migration lesson', false, 'Risk Avoided');
    const archived = await create('local-contributor', 'Delta cancelled lesson', false, 'Communication');
    const privateLesson = await create('local-pmo', 'Zebra private release checklist', false, 'Communication');

    await server
      .post(`/api/lessons-learned/v1/lessons/${submitted.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: submitted.body.version,
        title: submitted.body.title,
        projectId: submitted.body.projectId,
        projectName: submitted.body.projectName,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: submitted.body.situationObserved,
        rootCause: submitted.body.rootCause,
        lessonType: 'Future Prevention',
        impact: submitted.body.impact,
        recommendation: submitted.body.recommendation,
        applicability: submitted.body.applicability,
      })
      .expect(200);
    await server
      .post(`/api/lessons-learned/v1/lessons/${archived.body.id}/cancel`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: archived.body.version, reason: 'The project scope changed.' })
      .expect(200);
    await dataSource!.query('UPDATE lessons SET status = $2 WHERE id = $1', [approved.body.id, 'Approved']);
    await dataSource!.query('UPDATE lessons SET status = $2 WHERE id = $1', [closed.body.id, 'Closed']);

    const ownSubmissions = await server
      .get('/api/lessons-learned/v1/lessons/mine')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(ownSubmissions.body.map(({ status }: { status: string }) => status).sort()).toEqual([
      'Approved', 'Archived', 'Closed', 'Open', 'PMOEvaluation',
    ]);
    expect(ownSubmissions.body.every(({ authorId }: { authorId: string }) => authorId === 'local-contributor')).toBe(true);
    expect(ownSubmissions.body.map(({ updatedAt }: { updatedAt: string }) => Date.parse(updatedAt))).toEqual(
      [...ownSubmissions.body.map(({ updatedAt }: { updatedAt: string }) => Date.parse(updatedAt))]
        .sort((left, right) => right - left),
    );

    await server
      .get('/api/lessons-learned/v1/lessons/mine?search=Zebra&withoutProject=true&lessonType=Communication&status=Open')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([open.body.id]));
    await server
      .get(`/api/lessons-learned/v1/lessons/mine?search=${submitted.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([submitted.body.id]));
    await server
      .get('/api/lessons-learned/v1/lessons/mine?search=Alpha&projectId=LOCAL-PROJECT-001&lessonType=Future%20Prevention&status=PMOEvaluation')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([submitted.body.id]));
    await server
      .get(`/api/lessons-learned/v1/lessons/mine?search=${encodeURIComponent(privateLesson.body.title)}&withoutProject=true&status=Open`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body).toEqual([]));
    await server
      .get('/api/lessons-learned/v1/lessons/mine')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([privateLesson.body.id]));

    await server
      .get(`/api/lessons-learned/v1/lessons/${archived.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: archived.body.id,
          title: archived.body.title,
          status: 'Archived',
          authorId: 'local-contributor',
          updatedBy: 'local-contributor',
          projectCategory: 'Technology',
          projectPhase: 'Execution',
          situationObserved: archived.body.situationObserved,
          rootCause: 'A handover checklist was not shared.',
          lessonType: 'Communication',
          impact: 'The team repeated verification work.',
          recommendation: 'Share the checklist before release.',
          applicability: 'Use for software releases.',
          history: [
            { actorId: 'local-contributor', eventType: 'Created', previousStatus: null, newStatus: 'Open', reason: null },
            { actorId: 'local-contributor', eventType: 'Cancelled', previousStatus: 'Open', newStatus: 'Archived', reason: 'The project scope changed.' },
          ],
        });
        expect(body.createdAt).toBeTruthy();
        expect(body.updatedAt).toBeTruthy();
        expect(body.history[0].occurredAt).toBeTruthy();
      });
    await server
      .get(`/api/lessons-learned/v1/lessons/${privateLesson.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(404);
    await server
      .get(`/api/lessons-learned/v1/lessons/${submitted.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.history.map(({ eventType }: { eventType: string }) => eventType))
        .toEqual(['Created', 'Submitted']));
    await server
      .get(`/api/lessons-learned/v1/lessons/${privateLesson.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
  });

  it('matches numeric title prefixes and exact IDs within the selected author scope', async () => {
    const server = request(app!.getHttpServer());
    const create = async (profileId: string, title: string) => server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', profileId)
      .send({ title })
      .expect(201);

    const ownNumericTitle = await create('local-contributor', '2026 deployment practices');
    await create('local-pmo', '2026 deployment practices');
    const exactIdMatch = await create('local-contributor', 'Improve the deployment handover');
    const aboveIntegerLimit = await create('local-contributor', '2147483648 system migration');

    await server
      .get('/api/lessons-learned/v1/lessons/mine?search=2026')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([ownNumericTitle.body.id]));
    await server
      .get(`/api/lessons-learned/v1/lessons/mine?search=${exactIdMatch.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([exactIdMatch.body.id]));
    await server
      .get('/api/lessons-learned/v1/lessons/mine?search=2147483648')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([aboveIntegerLimit.body.id]));
  });

  it('returns a lesson state with the lifecycle history for that state', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Read a consistent lesson snapshot' })
      .expect(201);

    let transitionCommitted = false;
    const transitionAfterFirstRead: EntitySubscriberInterface<Lesson> = {
      listenTo: () => Lesson,
      async afterLoad(lesson) {
        if (lesson.id !== created.body.id || transitionCommitted) return;
        transitionCommitted = true;
        await dataSource!.transaction(async (manager) => {
          await manager.getRepository(Lesson).update(lesson.id, {
            status: 'PMOEvaluation',
            updatedBy: 'local-contributor',
            version: lesson.version + 1,
          });
          await manager.getRepository(LessonHistory).save({
            lessonId: lesson.id,
            actorId: 'local-contributor',
            eventType: 'Submitted',
            previousStatus: 'Open',
            newStatus: 'PMOEvaluation',
            reason: null,
          });
        });
      },
    };
    dataSource!.subscribers.push(transitionAfterFirstRead);

    try {
      const firstSnapshot = await server
        .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .expect(200);

      expect(transitionCommitted).toBe(true);
      expect(firstSnapshot.body.status).toBe('Open');
      expect(firstSnapshot.body.history).toMatchObject([
        { eventType: 'Created', previousStatus: null, newStatus: 'Open' },
      ]);

      await server
        .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .expect(200)
        .expect(({ body }) => {
          expect(body.status).toBe('PMOEvaluation');
          expect(body.history).toMatchObject([
            { eventType: 'Created', previousStatus: null, newStatus: 'Open' },
            { eventType: 'Submitted', previousStatus: 'Open', newStatus: 'PMOEvaluation' },
          ]);
          expect(body.history[body.history.length - 1]?.newStatus).toBe(body.status);
        });
    } finally {
      const subscriberIndex = dataSource!.subscribers.indexOf(transitionAfterFirstRead);
      if (subscriberIndex !== -1) dataSource!.subscribers.splice(subscriberIndex, 1);
    }
  });

  it('distinguishes a project whose ID is none from lessons without a project', async () => {
    const projects = [
      { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' },
      { id: 'LOCAL-PROJECT-002', name: 'Fictional Harbor Migration' },
      { id: 'none', name: 'Project None' },
    ];
    writeFileSync(projectsPath, JSON.stringify(projects), 'utf8');
    const server = request(app!.getHttpServer());
    const projectLesson = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'A real project named none', projectId: 'none', projectName: 'Project None' })
      .expect(201);
    const noProjectLesson = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'A lesson without a project' })
      .expect(201);

    await server
      .get('/api/lessons-learned/v1/lessons/mine?projectId=none')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([projectLesson.body.id]));
    await server
      .get('/api/lessons-learned/v1/lessons/mine?withoutProject=true')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([noProjectLesson.body.id]));
  });

  it('rejects invalid cancellation reasons without changing the draft or history', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Keep this draft open' })
      .expect(201);

    for (const reason of ['', '   ', 'x'.repeat(1001)]) {
      const response = await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/cancel`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({ version: created.body.version, reason });
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.code).toBe('INVALID_LESSON_CANCELLATION');
      expect(response.body.fieldErrors.reason).toBeTruthy();
    }

    expect(await dataSource?.query('SELECT status, version FROM lessons WHERE id = $1', [created.body.id]))
      .toEqual([{ status: 'Open', version: 1 }]);
    expect(await dataSource?.query('SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id', [created.body.id]))
      .toEqual([{ event_type: 'Created' }]);
  });

  it('does not let a Contributor cancel another profile’s draft', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ title: 'Keep another profile’s draft private' })
      .expect(201);

    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/cancel`)
      .send({ version: 1, reason: 'Unauthorized cancel attempt.' })
      .expect(401);
    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/cancel`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: 1, reason: 'Unauthorized cancel attempt.' })
      .expect(404);

    expect(await dataSource?.query('SELECT status, version, updated_by FROM lessons WHERE id = $1', [created.body.id]))
      .toEqual([{ status: 'Open', version: 1, updated_by: 'local-pmo' }]);
    expect(await dataSource?.query('SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id', [created.body.id]))
      .toEqual([{ event_type: 'Created' }]);
  });

  it('does not cancel a lesson that has already been submitted', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Do not cancel a submitted lesson' })
      .expect(201);
    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: created.body.title,
        projectId: null,
        projectName: null,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The handover omitted the current runbook.',
        rootCause: null,
        lessonType: 'Communication',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to review the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(200);

    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/cancel`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: created.body.version + 1, reason: 'Trying to cancel after submission.' })
      .expect(409);

    expect(await dataSource?.query('SELECT status, version FROM lessons WHERE id = $1', [created.body.id]))
      .toEqual([{ status: 'PMOEvaluation', version: 2 }]);
    expect(await dataSource?.query('SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id', [created.body.id]))
      .toEqual([{ event_type: 'Created' }, { event_type: 'Submitted' }]);
  });

  it('rolls back cancellation when recording its history fails', async () => {
    if (!dataSource) throw new Error('The PostgreSQL test database did not start.');
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Cancellation must be atomic' })
      .expect(201);

    await dataSource.query(`
      CREATE FUNCTION reject_lesson_cancellation_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'Cancelled' THEN RAISE EXCEPTION 'cancellation history write intentionally rejected'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_lesson_cancellation_history_insert
      BEFORE INSERT ON lesson_history FOR EACH ROW EXECUTE FUNCTION reject_lesson_cancellation_history();
    `);

    try {
      await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/cancel`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({ version: created.body.version, reason: 'This must not be committed alone.' })
        .expect(500);

      expect(await dataSource.query('SELECT status, version FROM lessons WHERE id = $1', [created.body.id]))
        .toEqual([{ status: 'Open', version: created.body.version }]);
      expect(await dataSource.query('SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id', [created.body.id]))
        .toEqual([{ event_type: 'Created' }]);
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS reject_lesson_cancellation_history_insert ON lesson_history');
      await dataSource.query('DROP FUNCTION IF EXISTS reject_lesson_cancellation_history()');
    }
  });

  it('lets the author complete an Open draft without adding an edit history event', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Improve release handover' })
      .expect(201);

    const updated = await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: 'Improve release handover',
        projectId: 'LOCAL-PROJECT-001',
        projectName: 'Fictional Atlas Modernization',
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The deployment handover did not include the latest runbook.',
        rootCause: 'The team had no shared release checklist.',
        lessonType: 'Future Prevention',
        impact: 'Operators spent extra time finding the current procedure.',
        recommendation: 'Review the runbook before each release.',
        applicability: 'Apply to software releases with an on-call handover.',
      })
      .expect(200);

    expect(updated.body).toMatchObject({
      id: created.body.id,
      title: 'Improve release handover',
      authorId: 'local-contributor',
      status: 'Open',
      version: created.body.version + 1,
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      lessonType: 'Future Prevention',
      situationObserved: 'The deployment handover did not include the latest runbook.',
    });
    expect(await dataSource?.query(
      'SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id',
      [created.body.id],
    )).toEqual([{ event_type: 'Created' }]);
  });

  it('creates a complete draft and its creation event together while still supporting a title-only draft', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        title: 'Complete a lesson in the create modal',
        projectId: 'LOCAL-PROJECT-001',
        projectName: 'Fictional Atlas Modernization',
        projectCategory: 'Business',
        projectPhase: 'Execution',
        situationObserved: 'The handover omitted the release checklist.',
        lessonType: 'Future Prevention',
        rootCause: 'No checklist owner had been assigned.',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to update the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(201);

    expect(created.body).toMatchObject({
      title: 'Complete a lesson in the create modal',
      authorId: 'local-contributor',
      updatedBy: 'local-contributor',
      status: 'Open',
      version: 1,
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
      projectCategory: 'Business',
      projectPhase: 'Execution',
      lessonType: 'Future Prevention',
      rootCause: 'No checklist owner had been assigned.',
    });
    expect(await dataSource?.query(
      'SELECT event_type, actor_id FROM lesson_history WHERE lesson_id = $1',
      [created.body.id],
    )).toEqual([{ event_type: 'Created', actor_id: 'local-contributor' }]);

    await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Still save a title-only draft' })
      .expect(201)
      .expect(({ body }) => {
        expect(body.title).toBe('Still save a title-only draft');
        expect(body.situationObserved).toBeNull();
      });
  });

  it('submits a complete Open draft for PMO evaluation with exactly one history event', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Submit a complete lesson' })
      .expect(201);

    const submittedResponse = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: created.body.title,
        projectId: null,
        projectName: null,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The release handover omitted the current runbook.',
        rootCause: 'No checklist owner had been assigned.',
        lessonType: 'Future Prevention',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to review the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(200);

    expect(submitted.body).toMatchObject({
      id: created.body.id,
      title: 'Submit a complete lesson',
      authorId: 'local-contributor',
      updatedBy: 'local-contributor',
      status: 'PMOEvaluation',
      version: created.body.version + 1,
      projectId: null,
      projectCategory: 'Technology',
    });
    expect(await dataSource?.query(
      'SELECT actor_id, event_type, previous_status, new_status FROM lesson_history WHERE lesson_id = $1 ORDER BY id',
      [created.body.id],
    )).toEqual([
      { actor_id: 'local-contributor', event_type: 'Created', previous_status: null, new_status: 'Open' },
      { actor_id: 'local-contributor', event_type: 'Submitted', previous_status: 'Open', new_status: 'PMOEvaluation' },
    ]);
  });

  it('validates submission fields before changing an Open draft', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Keep this draft Open when submission is invalid' })
      .expect(201);
    const complete = {
      version: created.body.version,
      title: created.body.title,
      projectId: null,
      projectName: null,
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      situationObserved: 'The release handover omitted the current runbook.',
      rootCause: 'No checklist owner had been assigned.',
      lessonType: 'Future Prevention',
      impact: 'The release team repeated verification work.',
      recommendation: 'Assign an owner to review the checklist.',
      applicability: 'Use for releases with shared operational ownership.',
    };
    const invalidInputs = [
      { ...complete, projectCategory: null },
      { ...complete, projectPhase: null },
      { ...complete, situationObserved: '   ' },
      { ...complete, lessonType: null },
      { ...complete, impact: null },
      { ...complete, recommendation: null },
      { ...complete, applicability: null },
      { ...complete, lessonType: 'Future Prevention', rootCause: '  ' },
      { ...complete, lessonType: 'Unsupported type' },
      { ...complete, title: 'x'.repeat(151) },
      { ...complete, situationObserved: 'x'.repeat(4001) },
      { ...complete, rootCause: 'x'.repeat(4001) },
      { ...complete, impact: 'x'.repeat(4001) },
      { ...complete, recommendation: 'x'.repeat(4001) },
      { ...complete, applicability: 'x'.repeat(4001) },
    ];

    for (const input of invalidInputs) {
      const response = await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send(input);
      expect(response.status, JSON.stringify(input)).toBe(400);
    }

    const missingCategory = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ ...complete, projectCategory: null });
    expect(missingCategory.status).toBe(400);
    expect(missingCategory.body.fieldErrors.projectCategory).toBeTruthy();

    const missingRootCause = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ ...complete, rootCause: '   ' });
    expect(missingRootCause.status).toBe(400);
    expect(missingRootCause.body.fieldErrors.rootCause).toBe('Root cause is required for Future Prevention.');

    await server
      .get('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body).toEqual([created.body]));
    expect(await dataSource?.query(
      'SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id',
      [created.body.id],
    )).toEqual([{ event_type: 'Created' }]);
  });

  it('reports a removed project selection as a submission field error', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Choose a project that is still available' })
      .expect(201);
    writeFileSync(projectsPath, JSON.stringify([
      { id: 'LOCAL-PROJECT-002', name: 'Fictional Harbor Migration' },
    ]), 'utf8');

    try {
      const response = await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({
          version: created.body.version,
          title: created.body.title,
          projectId: 'LOCAL-PROJECT-001',
          projectName: 'Fictional Atlas Modernization',
          projectCategory: 'Technology',
          projectPhase: 'Execution',
          situationObserved: 'The release handover omitted the current runbook.',
          rootCause: null,
          lessonType: 'Communication',
          impact: 'The release team repeated verification work.',
          recommendation: 'Assign an owner to review the checklist.',
          applicability: 'Use for releases with shared operational ownership.',
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        code: 'INVALID_LESSON_SUBMISSION',
        message: 'Choose a current project or No project before submitting.',
        fieldErrors: { projectId: 'Choose a current project or No project before submitting.' },
      });
      expect(await dataSource?.query('SELECT status FROM lessons WHERE id = $1', [created.body.id]))
        .toEqual([{ status: 'Open' }]);
      expect(await dataSource?.query(
        'SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id',
        [created.body.id],
      )).toEqual([{ event_type: 'Created' }]);
    } finally {
      writeFileSync(projectsPath, JSON.stringify([
        { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' },
        { id: 'LOCAL-PROJECT-002', name: 'Fictional Harbor Migration' },
      ]), 'utf8');
    }
  });

  it('allows only the author to submit and does not duplicate a completed transition', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Only my author can submit this lesson' })
      .expect(201);
    const complete = {
      version: created.body.version,
      title: created.body.title,
      projectId: null,
      projectName: null,
      projectCategory: 'Business',
      projectPhase: 'Planning',
      situationObserved: 'The team changed the release date without telling operations.',
      rootCause: null,
      lessonType: 'Communication',
      impact: 'Operations prepared the wrong weekend coverage.',
      recommendation: 'Share the approved release date with operations.',
      applicability: 'Use whenever a delivery schedule changes.',
    };

    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send(complete)
      .expect(404);

    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send(complete)
      .expect(200);

    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send(complete)
      .expect(409);

    await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: created.body.version, title: 'Cannot edit after submission' })
      .expect(409);

    expect(await dataSource?.query(
      'SELECT actor_id, event_type, previous_status, new_status FROM lesson_history WHERE lesson_id = $1 ORDER BY id',
      [created.body.id],
    )).toEqual([
      { actor_id: 'local-contributor', event_type: 'Created', previous_status: null, new_status: 'Open' },
      { actor_id: 'local-contributor', event_type: 'Submitted', previous_status: 'Open', new_status: 'PMOEvaluation' },
    ]);
  });

  it('allows a PMO to submit a complete lesson authored by that same PMO profile', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ title: 'PMO submits their own experience' })
      .expect(201);

    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({
        version: created.body.version,
        title: created.body.title,
        projectCategory: 'Data',
        projectPhase: 'Closure',
        situationObserved: 'The final migration report was not shared with the support team.',
        lessonType: 'Success to Repeat',
        impact: 'Support had less context for later maintenance.',
        recommendation: 'Share the migration report with support before closure.',
        applicability: 'Use for projects that hand over systems to support.',
      })
      .expect(200);

    expect(submitted.body).toMatchObject({ authorId: 'local-pmo', updatedBy: 'local-pmo', status: 'PMOEvaluation' });
    expect(await dataSource?.query(
      'SELECT actor_id, event_type, previous_status, new_status FROM lesson_history WHERE lesson_id = $1 ORDER BY id',
      [created.body.id],
    )).toEqual([
      { actor_id: 'local-pmo', event_type: 'Created', previous_status: null, new_status: 'Open' },
      { actor_id: 'local-pmo', event_type: 'Submitted', previous_status: 'Open', new_status: 'PMOEvaluation' },
    ]);
  });

  it('rolls back submission when recording its history fails', async () => {
    if (!dataSource) throw new Error('The PostgreSQL test database did not start.');
    const created = await request(app!.getHttpServer())
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Submission history must be atomic' })
      .expect(201);
    await dataSource.query(`
      CREATE FUNCTION reject_submission_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'Submitted' THEN RAISE EXCEPTION 'submission history write intentionally rejected'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_submission_history_insert
      BEFORE INSERT ON lesson_history FOR EACH ROW EXECUTE FUNCTION reject_submission_history();
    `);

    try {
      await request(app!.getHttpServer())
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({
          version: created.body.version,
          title: created.body.title,
          projectCategory: 'Technology',
          projectPhase: 'Execution',
          situationObserved: 'The release handover omitted the current runbook.',
          rootCause: null,
          lessonType: 'Communication',
          impact: 'The release team repeated verification work.',
          recommendation: 'Assign an owner to review the checklist.',
          applicability: 'Use for releases with shared operational ownership.',
        })
        .expect(500);

      expect(await dataSource.query('SELECT status FROM lessons WHERE id = $1', [created.body.id]))
        .toEqual([{ status: 'Open' }]);
      expect(await dataSource.query(
        "SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id",
        [created.body.id],
      )).toEqual([{ event_type: 'Created' }]);
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS reject_submission_history_insert ON lesson_history');
      await dataSource.query('DROP FUNCTION IF EXISTS reject_submission_history()');
    }
  });

  it('rejects a stale draft edit without overwriting the current version', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Improve release handover' })
      .expect(201);

    await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: created.body.version, title: 'Current title' })
      .expect(200);

    const stale = await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: created.body.version, title: 'Stale overwrite' })
      .expect(409);

    expect(stale.body.code).toBe('STALE_LESSON_VERSION');
    expect(stale.body.message).toBe(
      'This draft changed after you opened it. Reload the current version before saving again.',
    );
    await server
      .get('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body[0]).toMatchObject({ title: 'Current title' }));
  });

  it('returns a typed conflict when the draft is no longer Open', async () => {
    if (!dataSource) throw new Error('The PostgreSQL test database did not start.');
    const created = await request(app!.getHttpServer())
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Submitted draft' })
      .expect(201);
    await dataSource.query('UPDATE lessons SET status = $2 WHERE id = $1', [created.body.id, 'Approved']);

    await request(app!.getHttpServer())
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: created.body.version, title: 'Cannot edit submitted draft' })
      .expect(409)
      .expect({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be edited.' });
  });

  it('lets PMO edit a complete evaluation while preserving authorship, status, queue position, and transition history', async () => {
    const server = request(app!.getHttpServer());
    const submitCompleteLesson = async (title: string) => {
      const created = await server
        .post('/api/lessons-learned/v1/lessons')
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({ title })
        .expect(201);

      return server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({
          version: created.body.version,
          title,
          projectId: null,
          projectName: null,
          projectCategory: 'Technology',
          projectPhase: 'Execution',
          situationObserved: 'The release handover omitted the current runbook.',
          rootCause: 'No checklist owner had been assigned.',
          lessonType: 'Future Prevention',
          impact: 'The release team repeated verification work.',
          recommendation: 'Assign an owner to review the checklist.',
          applicability: 'Use for releases with shared operational ownership.',
        })
        .expect(200);
    };

    const first = await submitCompleteLesson('First evaluation');
    const second = await submitCompleteLesson('Second evaluation');
    const originalOrder = await server
      .get('/api/lessons-learned/v1/lessons/evaluation-queue')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .then(({ body }) => body.map(({ id }: { id: number }) => id));

    const edited = await server
      .patch(`/api/lessons-learned/v1/lessons/${first.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({
        version: first.body.version,
        title: 'First evaluation with PMO corrections',
        projectId: null,
        projectName: null,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The release handover omitted the approved runbook.',
        rootCause: 'No checklist owner had been assigned.',
        lessonType: 'Future Prevention',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to review the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(200);

    expect(edited.body).toMatchObject({
      title: 'First evaluation with PMO corrections',
      authorId: 'local-contributor',
      updatedBy: 'local-pmo',
      status: 'PMOEvaluation',
      version: first.body.version + 1,
    });
    const currentOrder = await server
      .get('/api/lessons-learned/v1/lessons/evaluation-queue')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .then(({ body }) => body.map(({ id }: { id: number }) => id));
    expect(originalOrder).toEqual([first.body.id, second.body.id]);
    expect(currentOrder).toEqual(originalOrder);

    await server
      .get(`/api/lessons-learned/v1/lessons/${first.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.history.map(({ eventType }: { eventType: string }) => eventType))
        .toEqual(['Created', 'Submitted']));
  });

  it('blocks evaluation edits from Contributors, rejects stale versions, and stops edits after evaluation', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Evaluation edit permissions' })
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: created.body.title,
        projectId: null,
        projectName: null,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The release handover omitted the current runbook.',
        rootCause: 'No checklist owner had been assigned.',
        lessonType: 'Future Prevention',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to review the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(200);
    const completeEdit = {
      title: 'Evaluation title edited by PMO',
      projectId: null,
      projectName: null,
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      situationObserved: 'The release handover omitted the approved runbook.',
      rootCause: 'No checklist owner had been assigned.',
      lessonType: 'Future Prevention',
      impact: 'The release team repeated verification work.',
      recommendation: 'Assign an owner to review the checklist.',
      applicability: 'Use for releases with shared operational ownership.',
    };

    await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: submitted.body.version, ...completeEdit })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('LESSON_NOT_OPEN'));

    await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version, ...completeEdit })
      .expect(200);

    await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version, ...completeEdit, title: 'Stale evaluation edit' })
      .expect(409)
      .expect({
        code: 'STALE_LESSON_VERSION',
        message: 'This draft changed after you opened it. Reload the current version before saving again.',
      });

    await dataSource!.query('UPDATE lessons SET status = $2 WHERE id = $1', [created.body.id, 'Approved']);
    await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version + 1, ...completeEdit })
      .expect(409)
      .expect({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be edited.' });
  });

  it('keeps a lesson in evaluation unchanged when PMO edit validation fails', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Evaluation content stays complete' })
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: created.body.title,
        projectId: null,
        projectName: null,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The release handover omitted the current runbook.',
        rootCause: null,
        lessonType: 'Communication',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to review the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(200);

    await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({
        version: submitted.body.version,
        title: 'A corrected title that must stay unsaved',
        projectCategory: null,
      })
      .expect(400)
      .expect(({ body }) => expect(body).toMatchObject({
        code: 'INVALID_LESSON_EDIT',
        fieldErrors: { projectCategory: 'Project category is required.' },
      }));

    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        title: 'Evaluation content stays complete',
        authorId: 'local-contributor',
        status: 'PMOEvaluation',
        version: submitted.body.version,
      }));
  });

  it('returns the row written by a version-checked update when a later writer changes it immediately', async () => {
    if (!dataSource) throw new Error('The PostgreSQL test database did not start.');
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Starting title' })
      .expect(201);

    await dataSource.query(`
      CREATE FUNCTION apply_later_lesson_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.title = 'First writer title' THEN
          UPDATE lessons
          SET title = 'Later writer title', version = NEW.version + 1, updated_at = clock_timestamp()
          WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER apply_later_lesson_update_trigger
      AFTER UPDATE ON lessons FOR EACH ROW EXECUTE FUNCTION apply_later_lesson_update();
    `);

    try {
      const response = await server
        .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({ version: created.body.version, title: 'First writer title' })
        .expect(200);

      expect(response.body).toMatchObject({
        title: 'First writer title',
        version: created.body.version + 1,
      });
      expect(await dataSource.query(
        'SELECT title, version FROM lessons WHERE id = $1',
        [created.body.id],
      )).toEqual([{ title: 'Later writer title', version: created.body.version + 2 }]);
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS apply_later_lesson_update_trigger ON lessons');
      await dataSource.query('DROP FUNCTION IF EXISTS apply_later_lesson_update()');
    }
  });

  it('validates lesson fields and preserves a selected project snapshot after catalog removal', async () => {
    const server = request(app!.getHttpServer());
    const catalog = await server
      .get('/api/lessons-learned/v1/lessons/projects')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(catalog.body).toContainEqual({ id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' });
    await server.get('/api/lessons-learned/v1/lessons/projects').expect(401);

    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Preserve project snapshot' })
      .expect(201);
    await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: 'Preserve project snapshot',
        projectId: catalog.body[0].id,
        projectName: catalog.body[0].name,
      })
      .expect(200);

    rmSync(projectsPath);
    const preserved = await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: created.body.version + 1, title: 'Preserve project snapshot after removal' })
      .expect(200);
    expect(preserved.body).toMatchObject({
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
    });

    writeFileSync(projectsPath, JSON.stringify([
      { id: 'LOCAL-PROJECT-002', name: 'Fictional Harbor Migration' },
    ]), 'utf8');
    await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: preserved.body.version,
        title: 'Reject an unconfigured project snapshot',
        projectId: 'LOCAL-PROJECT-999',
        projectName: 'Fictional Unknown Project',
      })
      .expect(400);

    const longTextFields = [
      'situationObserved',
      'rootCause',
      'impact',
      'recommendation',
      'applicability',
    ] as const;
    for (const field of longTextFields) {
      await server
        .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({ version: preserved.body.version, title: 'Valid', [field]: 'x'.repeat(4001) })
        .expect(400);
    }
    for (const input of [
      { title: 'Valid', version: preserved.body.version, lessonType: 'Unexpected' },
      { title: 'Valid', version: preserved.body.version, projectCategory: 'Unexpected' },
      { title: 'Valid', version: preserved.body.version, projectPhase: 'Unexpected' },
      { title: '   ', version: preserved.body.version },
      { title: 'x'.repeat(151), version: preserved.body.version },
    ]) {
      await server
        .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send(input)
        .expect(400);
    }

    const noProject = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'No project lesson' })
      .expect(201);
    const boundaryText = 'x'.repeat(4000);
    await server
      .patch(`/api/lessons-learned/v1/lessons/${noProject.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: noProject.body.version,
        title: 'No project lesson',
        projectCategory: 'Business',
        projectPhase: 'Not Applicable',
        situationObserved: boundaryText,
        rootCause: boundaryText,
        impact: boundaryText,
        recommendation: boundaryText,
        applicability: boundaryText,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.projectId).toBeNull();
        expect(body.projectCategory).toBe('Business');
        expect(body.situationObserved).toHaveLength(4000);
        expect(body.rootCause).toHaveLength(4000);
        expect(body.impact).toHaveLength(4000);
        expect(body.recommendation).toHaveLength(4000);
        expect(body.applicability).toHaveLength(4000);
      });
  });

  it('does not allow a contributor to edit another author’s draft', async () => {
    const created = await request(app!.getHttpServer())
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ title: 'PMO-owned draft' })
      .expect(201);

    await request(app!.getHttpServer())
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: created.body.version, title: 'Unauthorized edit' })
      .expect(404);
  });

  it('lets PMO read only the evaluation queue in order of last submission, even after later edits', async () => {
    const server = request(app!.getHttpServer());
    const submitCompleteLesson = async (title: string) => {
      const created = await server
        .post('/api/lessons-learned/v1/lessons')
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({ title })
        .expect(201);

      return server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({
          version: created.body.version,
          title,
          projectId: null,
          projectName: null,
          projectCategory: 'Technology',
          projectPhase: 'Execution',
          situationObserved: 'The release handover omitted the current runbook.',
          rootCause: 'No checklist owner had been assigned.',
          lessonType: 'Future Prevention',
          impact: 'The release team repeated verification work.',
          recommendation: 'Assign an owner to review the checklist.',
          applicability: 'Use for releases with shared operational ownership.',
        })
        .expect(200);
    };

    const oldestSubmission = await submitCompleteLesson('Oldest evaluation');
    const middleSubmission = await submitCompleteLesson('Middle evaluation');
    const newestSubmission = await submitCompleteLesson('Newest evaluation');
    const stillOpen = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Not submitted for evaluation' })
      .expect(201);

    const timestamps = [
      [oldestSubmission.body.id, '2026-11-14T09:00:00Z', '2026-11-14T10:30:00Z'],
      [middleSubmission.body.id, '2026-11-14T09:30:00.000001Z', '2026-11-14T09:00:00Z'],
      [newestSubmission.body.id, '2026-11-14T09:30:00.000001Z', '2026-11-14T10:15:00Z'],
    ] as const;

    for (const [lessonId, submittedAt, updatedAt] of timestamps) {
      await dataSource!.query(
        "UPDATE lesson_history SET occurred_at = $2 WHERE lesson_id = $1 AND event_type = 'Submitted'",
        [lessonId, submittedAt],
      );
      await dataSource!.query('UPDATE lessons SET updated_at = $2 WHERE id = $1', [lessonId, updatedAt]);
    }

    await server
      .get('/api/lessons-learned/v1/lessons/evaluation-queue')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(403);

    await server
      .get('/api/lessons-learned/v1/lessons/evaluation-queue')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => {
        expect(body.map(({ id, status }: { id: number; status: string }) => [id, status])).toEqual([
          [oldestSubmission.body.id, 'PMOEvaluation'],
          [middleSubmission.body.id, 'PMOEvaluation'],
          [newestSubmission.body.id, 'PMOEvaluation'],
        ]);
        expect(body.some(({ id }: { id: number }) => id === stillOpen.body.id)).toBe(false);
      });
    const path = '/api/lessons-learned/v1/lessons/evaluation-queue';
    const pmoHeaders = { 'X-PMO-Local-User-ID': 'local-pmo' };
    const first = await server.get(path).query({ limit: 1 }).set(pmoHeaders).expect(200);
    expect(first.body.items.map(({ id }: { id: number }) => id)).toEqual([oldestSubmission.body.id]);
    const cursor = first.body.page.nextCursor;
    expect(typeof cursor).toBe('string');
    const remaining = await server.get(path).query({ cursor, limit: 2 }).set(pmoHeaders).expect(200);
    expect(remaining.body.items.map(({ id }: { id: number }) => id)).toEqual([middleSubmission.body.id, newestSubmission.body.id]);
    expect(remaining.body.page.nextCursor).toBeNull();
    const second = await server.get(path).query({ cursor, limit: 1 }).set(pmoHeaders).expect(200);
    const third = await server.get(path).query({ cursor: second.body.page.nextCursor, limit: 1 }).set(pmoHeaders).expect(200);
    expect(third.body.items[0].id).toBe(newestSubmission.body.id);
    await server.get(path).query({ cursor, search: 'Changed filter' }).set(pmoHeaders).expect(400);
    await server.get(path).query({ limit: 101 }).set(pmoHeaders).expect(400);

    const search = '😀'.repeat(150);
    const projectId = '😀'.repeat(128);
    await dataSource!.query('UPDATE lessons SET title = $1, project_id = $2, project_name = $3 WHERE id IN ($4, $5)', [
      search, projectId, 'Removed project', oldestSubmission.body.id, middleSubmission.body.id,
    ]);
    await dataSource!.query('UPDATE lessons SET project_id = $1, project_name = $2 WHERE id = $3', [
      'Other project', 'Other project', newestSubmission.body.id,
    ]);
    const filtered = await server.get(path).query({ search, projectId, limit: 1 }).set(pmoHeaders).expect(200);
    expect(filtered.body.items[0].id).toBe(oldestSubmission.body.id);
    const filteredCursor = filtered.body.page.nextCursor;
    const next = await server.get(path).query({ search, projectId, cursor: filteredCursor }).set(pmoHeaders).expect(200);
    expect(next.body.items.map(({ id }: { id: number }) => id)).toEqual([middleSubmission.body.id]);
    await server.get(path).query({ search, cursor: filteredCursor }).set(pmoHeaders).expect(400);

    const projectsPath = `${path}/projects`;
    const legacyProjects = await server.get(projectsPath).set(pmoHeaders).expect(200);
    expect(legacyProjects.body).toHaveLength(2);
    expect(legacyProjects.body).toContainEqual({ id: projectId, name: 'Removed project' });
    const firstProject = await server.get(projectsPath).query({ limit: 1 }).set(pmoHeaders).expect(200);
    const projectCursor = firstProject.body.page.nextCursor;
    expect(typeof projectCursor).toBe('string');
    const secondProject = await server.get(projectsPath).query({ cursor: projectCursor }).set(pmoHeaders).expect(200);
    expect([...firstProject.body.items, ...secondProject.body.items]).toEqual(legacyProjects.body);
    expect(secondProject.body.page.nextCursor).toBeNull();
    await server.get(projectsPath).query({ cursor: filteredCursor }).set(pmoHeaders).expect(400);
    await server.get(projectsPath).query({ paged: 'true' }).set('X-PMO-Local-User-ID', 'local-contributor').expect(403);
  });

  it('serves the default cursor page without changing the legacy evaluation response', async () => {
    const server = request(app!.getHttpServer());
    const path = '/api/lessons-learned/v1/lessons/evaluation-queue';
    const pmo = { 'X-PMO-Local-User-ID': 'local-pmo' };
    await server.get(path).set(pmo).expect(200).expect(({ body }) => expect(body).toEqual([]));
    await server.get(`${path}?paged=true`).set(pmo).expect(200).expect(({ body }) => {
      expect(body).toEqual({ items: [], page: { limit: 50, nextCursor: null } });
    });
    await server.get(`${path}?paged=true`).set('X-PMO-Local-User-ID', 'local-contributor').expect(403);
  });

  it('searches the evaluation queue by title prefix or exact ID, combines project and type filters, and opens history', async () => {
    const server = request(app!.getHttpServer());
    const submitCompleteLesson = async (title: string, projectId: string, projectName: string, lessonType: string) => {
      const created = await server
        .post('/api/lessons-learned/v1/lessons')
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({ title, projectId, projectName })
        .expect(201);

      return server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({
          version: created.body.version,
          title,
          projectId,
          projectName,
          projectCategory: 'Technology',
          projectPhase: 'Execution',
          situationObserved: 'The release handover omitted the current runbook.',
          rootCause: 'No checklist owner had been assigned.',
          lessonType,
          impact: 'The release team repeated verification work.',
          recommendation: 'Assign an owner to review the checklist.',
          applicability: 'Use for releases with shared operational ownership.',
        })
        .expect(200);
    };

    const handover = await submitCompleteLesson(
      'Operations handover lesson',
      'LOCAL-PROJECT-001',
      'Fictional Atlas Modernization',
      'Communication',
    );
    const roadmap = await submitCompleteLesson(
      'Operations roadmap lesson',
      'LOCAL-PROJECT-001',
      'Fictional Atlas Modernization',
      'Communication',
    );
    await submitCompleteLesson(
      'Operations risk lesson',
      'LOCAL-PROJECT-002',
      'Fictional Harbor Migration',
      'Future Prevention',
    );
    await submitCompleteLesson(
      'Database backup lesson',
      'LOCAL-PROJECT-001',
      'Fictional Atlas Modernization',
      'Communication',
    );

    const queue = '/api/lessons-learned/v1/lessons/evaluation-queue';
    await server.get(`${queue}/projects`).set('X-PMO-Local-User-ID', 'local-pmo').expect(200)
      .expect(({ body }) => {
        expect(body).toContainEqual({ id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' });
        expect(body.filter(({ id }: { id: string }) => id === 'LOCAL-PROJECT-001')).toHaveLength(1);
      });
    await server.get(`${queue}/projects`).set('X-PMO-Local-User-ID', 'local-contributor').expect(403);
    await server
      .get(queue)
      .query({ search: 'Operations', projectId: 'LOCAL-PROJECT-001', lessonType: 'Communication' })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([
        handover.body.id,
        roadmap.body.id,
      ]));

    await server
      .get(queue)
      .query({ search: 'Operations handover' })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([handover.body.id]));

    await server
      .get(queue)
      .query({ search: String(handover.body.id) })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([handover.body.id]));

    await server
      .get(`/api/lessons-learned/v1/lessons/${handover.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ id: handover.body.id, title: 'Operations handover lesson' });
        expect(body.history).toMatchObject([
          { eventType: 'Created', newStatus: 'Open' },
          { eventType: 'Submitted', previousStatus: 'Open', newStatus: 'PMOEvaluation' },
        ]);
      });
  });

  it('lets PMO list lessons across authors and statuses with combined filters while denying Contributors', async () => {
    const server = request(app!.getHttpServer());
    const create = async (profileId: string, title: string, lessonType: string, project: boolean) => server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', profileId)
      .send({
        title,
        lessonType,
        ...(project ? { projectId: 'LOCAL-PROJECT-001', projectName: 'Fictional Atlas Modernization' } : {}),
      })
      .expect(201);

    const contributorDraft = await create('local-contributor', 'PMO handover checklist', 'Communication', true);
    const pmoDraft = await create('local-pmo', 'PMO own review', 'Future Prevention', false);
    const otherDraft = await create('local-contributor', 'Database migration review', 'Risk Avoided', false);
    await dataSource!.query('UPDATE lessons SET status = $2 WHERE id = $1', [otherDraft.body.id, 'Closed']);
    await dataSource!.query('UPDATE lessons SET updated_at = CURRENT_TIMESTAMP - INTERVAL \'2 seconds\' WHERE id = $1', [contributorDraft.body.id]);
    await dataSource!.query('UPDATE lessons SET updated_at = CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE id = $1', [pmoDraft.body.id]);

    await server
      .get('/api/lessons-learned/v1/lessons/pmo-drafts')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(403);

    await server
      .get('/api/lessons-learned/v1/lessons/pmo-drafts')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => {
        expect(body.map(({ id }: { id: number }) => id)).toEqual([
          otherDraft.body.id,
          pmoDraft.body.id,
          contributorDraft.body.id,
        ]);
        expect(body.map(({ updatedAt }: { updatedAt: string }) => Date.parse(updatedAt))).toEqual(
          [...body.map(({ updatedAt }: { updatedAt: string }) => Date.parse(updatedAt))]
            .sort((left, right) => right - left),
        );
      });

    await server
      .get('/api/lessons-learned/v1/lessons/pmo-drafts?search=PMO&authorId=local-contributor&projectId=LOCAL-PROJECT-001&lessonType=Communication&status=Open')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([contributorDraft.body.id]));
  });

  it('lets PMO inspect, edit, and cancel Open lessons without changing authorship or duplicating history', async () => {
    const server = request(app!.getHttpServer());
    const create = (title: string) => server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title })
      .expect(201);

    const editedDraft = await create('Contributor draft for PMO help');
    const cancelledDraft = await create('Contributor draft for PMO cancellation');

    await server
      .get(`/api/lessons-learned/v1/lessons/${editedDraft.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.history).toMatchObject([
        { actorId: 'local-contributor', eventType: 'Created', newStatus: 'Open' },
      ]));

    const saved = await server
      .patch(`/api/lessons-learned/v1/lessons/${editedDraft.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: editedDraft.body.version, title: 'PMO assisted lesson' })
      .expect(200);
    expect(saved.body).toMatchObject({
      id: editedDraft.body.id,
      title: 'PMO assisted lesson',
      authorId: 'local-contributor',
      updatedBy: 'local-pmo',
      version: editedDraft.body.version + 1,
      status: 'Open',
    });

    await server
      .patch(`/api/lessons-learned/v1/lessons/${editedDraft.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: editedDraft.body.version, title: 'Stale PMO edit must not replace this' })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('STALE_LESSON_VERSION'));

    const cancelled = await server
      .post(`/api/lessons-learned/v1/lessons/${cancelledDraft.body.id}/cancel`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: cancelledDraft.body.version, reason: 'The author asked PMO to close this draft.' })
      .expect(200);
    expect(cancelled.body).toMatchObject({
      authorId: 'local-contributor',
      updatedBy: 'local-pmo',
      status: 'Archived',
    });
    await server
      .get(`/api/lessons-learned/v1/lessons/${cancelledDraft.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.history).toMatchObject([
        { actorId: 'local-contributor', eventType: 'Created', previousStatus: null, newStatus: 'Open', reason: null },
        { actorId: 'local-pmo', eventType: 'Cancelled', previousStatus: 'Open', newStatus: 'Archived', reason: 'The author asked PMO to close this draft.' },
      ]));
    await server
      .post(`/api/lessons-learned/v1/lessons/${cancelledDraft.body.id}/cancel`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: cancelled.body.version, reason: 'A repeated cancel must not add history.' })
      .expect(409);
    expect(await dataSource!.query('SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id', [cancelledDraft.body.id]))
      .toEqual([{ event_type: 'Created' }, { event_type: 'Cancelled' }]);
  });

  it('does not let PMO submit an Open lesson on behalf of its author', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        title: 'A complete lesson remains author controlled',
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'A required test was missed.',
        rootCause: 'The checklist was outdated.',
        lessonType: 'Future Prevention',
        impact: 'The release needed extra work.',
        recommendation: 'Update the release checklist.',
        applicability: 'Apply to every release.',
      })
      .expect(201);

    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ ...created.body })
      .expect(404);
    expect(await dataSource!.query('SELECT status FROM lessons WHERE id = $1', [created.body.id]))
      .toEqual([{ status: 'Open' }]);
    expect(await dataSource!.query('SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id', [created.body.id]))
      .toEqual([{ event_type: 'Created' }]);
  });

  it('checks the displayed ETag while preserving the legacy version contract', async () => {
    const server = request(app!.getHttpServer());
    const contributor = { 'X-PMO-Local-User-ID': 'local-contributor' };
    const collection = '/api/lessons-learned/v1/lessons';
    const created = await server.post(collection).set(contributor).send({ title: 'Conditional draft' }).expect(201);
    const path = `${collection}/${created.body.id}`;
    const details = await server.get(path).set(contributor).expect(200).expect('ETag', /^"/);
    const etag = details.headers.etag;
    const accept = { Accept: 'application/json, application/problem+json' };
    const negotiated = await server.get(path).set(contributor).set(accept).expect(200);
    expect(negotiated.body.etag).toBe(negotiated.headers.etag);
    expect(negotiated.headers.etag).not.toBe(etag);
    expect(created.headers.etag).not.toBe(etag);
    await server.get(path).set(contributor).set(accept).expect('ETag', negotiated.headers.etag);

    await server.patch(path).set(contributor).set(accept).set('If-Match', etag)
      .send({ title: 'Conflicting preconditions', version: created.body.version + 1 })
      .expect(400).expect('Content-Type', /application\/problem\+json/);
    const updated = await server.patch(path).set(contributor).set(accept).set('If-Match', etag)
      .send({ title: 'Updated with ETag' }).expect(200).expect('ETag', /^"/);
    expect(updated.headers.etag).not.toBe(etag);
    await server.patch(path).set(contributor).set(accept).set('If-Match', etag)
      .send({ title: 'Stale ETag' }).expect(412).expect('Content-Type', /application\/problem\+json/)
      .expect(({ body }) => expect(body).toMatchObject({ status: 412, code: 'PRECONDITION_FAILED' }));
    await server.patch(path).set(contributor).send({ title: 'Stale version', version: created.body.version })
      .expect(409).expect(({ body }) => expect(body.code).toBe('STALE_LESSON_VERSION'));
    await server.post(`${path}/cancel`).set(contributor).set(accept).set('If-Match', updated.headers.etag)
      .send({ reason: '' }).expect(400).expect('Content-Type', /application\/problem\+json/)
      .expect(({ body }) => expect(body.errors).toContainEqual(expect.objectContaining({ path: 'reason' })));
    const cancelled = await server.post(`${path}/cancel`).set(contributor).set(accept).set('If-Match', updated.headers.etag)
      .send({ reason: 'The project changed direction.' }).expect(200);
    await server.patch(path).set(contributor).set(accept).set('If-Match', updated.headers.etag)
      .send({ title: 'Stale after cancellation' }).expect(412);
    await server.patch(path).set(contributor).set(accept).set('If-Match', cancelled.headers.etag)
      .send({ title: 'Current version but invalid state' }).expect(409)
      .expect(({ body }) => expect(body.code).toBe('LESSON_NOT_OPEN'));
  });

  it('rejects an ETag when the displayed representation changed at the same version', async () => {
    const server = request(app!.getHttpServer());
    const headers = { 'X-PMO-Local-User-ID': 'local-contributor', Accept: 'application/json, application/problem+json' };
    const collection = '/api/lessons-learned/v1/lessons';
    const created = await server.post(collection).set(headers).send({ title: 'Displayed draft' }).expect(201);
    const path = `${collection}/${created.body.id}`;
    const displayed = await server.get(path).set(headers).expect(200);

    // An independent correction to the displayed history does not edit the lesson version.
    await dataSource!.query('UPDATE lesson_history SET occurred_at = occurred_at - interval \'1 hour\' WHERE lesson_id = $1', [
      created.body.id,
    ]);
    const corrected = await server.get(path).set(headers).expect(200);
    expect(corrected.body.version).toBe(displayed.body.version);
    expect(corrected.headers.etag).not.toBe(displayed.headers.etag);
    await server.patch(path).set(headers).set('If-Match', displayed.headers.etag)
      .send({ title: 'Must not overwrite' }).expect(412)
      .expect(({ body }) => expect(body.code).toBe('PRECONDITION_FAILED'));
    await server.patch(path).set(headers).set('If-Match', corrected.headers.etag)
      .send({ title: 'Save after reload' }).expect(200);
  });

  it('continues an open edit and both paginated lists after rolling back to legacy emission', async () => {
    const active = request(app!.getHttpServer());
    const contributor = { 'X-PMO-Local-User-ID': 'local-contributor', Accept: 'application/json, application/problem+json' };
    const pmo = { 'X-PMO-Local-User-ID': 'local-pmo' };
    const collection = '/api/lessons-learned/v1/lessons';
    const draft = await active.post(collection).set(contributor).send({ title: 'Open on the new API' }).expect(201);
    const path = `${collection}/${draft.body.id}`;
    const displayed = await active.get(path).set(contributor).expect(200);

    for (const title of ['Queued one', 'Queued two', 'Published one', 'Published two']) {
      const lesson = await active.post(collection).set(contributor).send({ title }).expect(201);
      const lessonPath = `${collection}/${lesson.body.id}`;
      const submitted = await active.post(`${lessonPath}/submit`).set(contributor).send({
        version: lesson.body.version,
        title,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The release omitted the handover.',
        lessonType: 'Communication',
        impact: 'Verification was repeated.',
        recommendation: 'Assign an owner.',
        applicability: 'Shared releases.',
      }).expect(200);
      if (title.startsWith('Published')) {
        await active.post(`${lessonPath}/approve`).set(pmo).send({ version: submitted.body.version }).expect(200);
      }
    }

    process.env.LESSONS_LEARNED_TOKEN_FORMAT = 'legacy';
    let rollbackApp: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.register(container!.getConnectionUri())],
      }).compile();
      rollbackApp = moduleRef.createNestApplication();
      configureApp(rollbackApp);
      await rollbackApp.init();
      const rollback = request(rollbackApp.getHttpServer());
      const legacy = await rollback.get(path).set(contributor).expect(200);
      expect(legacy.headers.etag).toBe(`"lesson-${draft.body.id}-v${draft.body.version}"`);
      expect(displayed.headers.etag).not.toBe(legacy.headers.etag);
      const saved = await rollback.patch(path).set(contributor).set('If-Match', displayed.headers.etag)
        .send({ title: 'Saved after rollback' }).expect(200);
      await active.patch(path).set(contributor).set('If-Match', saved.headers.etag)
        .send({ title: 'Saved using a legacy ETag' }).expect(200);

      for (const [endpoint, headers] of [['evaluation-queue', pmo], ['library', contributor]] as const) {
        const url = `${collection}/${endpoint}`;
        const first = await active.get(url).query({ limit: 1 }).set(headers).expect(200);
        const legacyFirst = await rollback.get(url).query({ limit: 1 }).set(headers).expect(200);
        expect(legacyFirst.body.items[0].id).toBe(first.body.items[0].id);
        expect(first.body.page.nextCursor).not.toBe(legacyFirst.body.page.nextCursor);
        const second = await rollback.get(url).query({ cursor: first.body.page.nextCursor }).set(headers).expect(200);
        const newSecond = await active.get(url).query({ cursor: legacyFirst.body.page.nextCursor }).set(headers).expect(200);
        expect(second.body.items.map((item: { id: number }) => item.id)).toEqual(
          newSecond.body.items.map((item: { id: number }) => item.id),
        );
        expect(second.body.items).toHaveLength(1);
        expect(second.body.page.nextCursor).toBeNull();
      }
    } finally {
      process.env.LESSONS_LEARNED_TOKEN_FORMAT = 'representation';
      await rollbackApp?.close();
    }
  });

  it('keeps the draft content and version when saving cannot read PMO guidance', async () => {
    const server = request(app!.getHttpServer());
    const profile = 'local-contributor';
    const lessonsPath = '/api/lessons-learned/v1/lessons';
    const created = await server.post(lessonsPath)
      .set('X-PMO-Local-User-ID', profile)
      .send({ title: 'Original draft', impact: 'Original impact' })
      .expect(201);
    const lessonPath = `${lessonsPath}/${created.body.id}`;
    const before = await server.get(lessonPath).set('X-PMO-Local-User-ID', profile).expect(200);

    // Make history unavailable in the isolated PostgreSQL database for this request.
    await dataSource!.query('ALTER TABLE lesson_history RENAME TO unavailable_lesson_history');
    try {
      await server.patch(lessonPath)
        .set('X-PMO-Local-User-ID', profile)
        .send({ title: 'Changed draft', impact: 'Changed impact', version: before.body.version })
        .expect(500);
    } finally {
      await dataSource!.query('ALTER TABLE unavailable_lesson_history RENAME TO lesson_history');
    }

    const after = await server.get(lessonPath).set('X-PMO-Local-User-ID', profile).expect(200);
    expect(after.body).toEqual(before.body);
  });

  it('lets only PMO return a submitted lesson with required guidance of at most 1000 characters', async () => {
    const server = request(app!.getHttpServer());
    const title = 'A returned lesson can be corrected and resubmitted';
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title })
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The release handover omitted the current runbook.',
        rootCause: null,
        lessonType: 'Communication',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to review the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(200);

    const returnPath = `/api/lessons-learned/v1/lessons/${created.body.id}/return`;
    await server
      .post(returnPath)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: submitted.body.version, guidance: 'Please add the missing context.' })
      .expect(403);

    for (const guidance of [undefined, '', '   ', 'x'.repeat(1001)]) {
      const payload = { version: submitted.body.version, ...(guidance === undefined ? {} : { guidance }) };
      await server
        .post(returnPath)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send(payload)
        .expect(400);
    }

    await server
      .post(returnPath)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version - 1, guidance: 'This decision is stale.' })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('STALE_LESSON_VERSION'));

    const guidance = 'Please add the missing context. ' + 'x'.repeat(1000 - 'Please add the missing context. '.length);
    const returned = await server
      .post(returnPath)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version, guidance })
      .expect(200);

    expect(returned.body).toMatchObject({
      id: created.body.id,
      authorId: 'local-contributor',
      updatedBy: 'local-pmo',
      status: 'Open',
      version: submitted.body.version + 1,
      latestReviewGuidance: guidance,
    });
    await server
      .get('/api/lessons-learned/v1/lessons/evaluation-queue')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.some(({ id }: { id: number }) => id === created.body.id)).toBe(false));
    await server
      .get('/api/lessons-learned/v1/lessons/mine')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body[0]).toMatchObject({
        id: created.body.id,
        status: 'Open',
        latestReviewGuidance: guidance,
      }));
    await server
      .get('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body[0].latestReviewGuidance).toBe(guidance));
    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => {
        expect(body.latestReviewGuidance).toBe(guidance);
        expect(body.history).toMatchObject([
          { eventType: 'Created', newStatus: 'Open', reason: null },
          { eventType: 'Submitted', previousStatus: 'Open', newStatus: 'PMOEvaluation', reason: null },
          { actorId: 'local-pmo', eventType: 'Returned', previousStatus: 'PMOEvaluation', newStatus: 'Open', reason: guidance },
        ]);
      });
  });

  it('keeps every return in history, shows the latest guidance, and allows only the author to resubmit', async () => {
    const server = request(app!.getHttpServer());
    const title = 'Repeated return keeps each instruction';
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title })
      .expect(201);
    const submissionInput = (version: number, submissionTitle = title) => ({
      version,
      title: submissionTitle,
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      situationObserved: 'The release handover omitted the current runbook.',
      rootCause: null,
      lessonType: 'Communication',
      impact: 'The release team repeated verification work.',
      recommendation: 'Assign an owner to review the checklist.',
      applicability: 'Use for releases with shared operational ownership.',
    });
    const firstSubmission = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send(submissionInput(created.body.version))
      .expect(200);
    const firstGuidance = 'Please include the date of the project decision.';
    const firstReturn = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/return`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: firstSubmission.body.version, guidance: firstGuidance })
      .expect(200);

    const submitPath = `/api/lessons-learned/v1/lessons/${created.body.id}/submit`;
    await server
      .post(submitPath)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send(submissionInput(firstReturn.body.version))
      .expect(404);

    const revisedTitle = `${title} after author changes`;
    const edited = await server
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: firstReturn.body.version, title: revisedTitle })
      .expect(200);
    expect(edited.body.latestReviewGuidance).toBe(firstGuidance);
    await server
      .post(submitPath)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ ...submissionInput(edited.body.version), lessonType: 'Future Prevention', rootCause: '   ' })
      .expect(400);
    const secondSubmission = await server
      .post(submitPath)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send(submissionInput(edited.body.version, revisedTitle))
      .expect(200);
    await server
      .get('/api/lessons-learned/v1/lessons/mine')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body[0]).toMatchObject({
        id: created.body.id,
        status: 'PMOEvaluation',
        latestReviewGuidance: null,
      }));

    const secondGuidance = 'Please explain why the proposed mitigation addresses the cause.';
    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/return`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: secondSubmission.body.version, guidance: secondGuidance })
      .expect(200);

    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/return`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: firstReturn.body.version, guidance: 'This version is stale.' })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('LESSON_NOT_AWAITING_EVALUATION'));
    await server
      .get('/api/lessons-learned/v1/lessons/mine')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body[0]).toMatchObject({
        id: created.body.id,
        status: 'Open',
        latestReviewGuidance: secondGuidance,
      }));
    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.history).toMatchObject([
        { eventType: 'Created', previousStatus: null, newStatus: 'Open' },
        { eventType: 'Submitted', previousStatus: 'Open', newStatus: 'PMOEvaluation' },
        { eventType: 'Returned', previousStatus: 'PMOEvaluation', newStatus: 'Open', reason: firstGuidance },
        { eventType: 'Submitted', previousStatus: 'Open', newStatus: 'PMOEvaluation' },
        { eventType: 'Returned', previousStatus: 'PMOEvaluation', newStatus: 'Open', reason: secondGuidance },
      ]));
  });

  it('rolls back a return when history fails and permits only one concurrent PMO decision', async () => {
    if (!dataSource) throw new Error('The PostgreSQL test database did not start.');
    const server = request(app!.getHttpServer());
    const title = 'Return decisions are atomic';
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title })
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The release handover omitted the current runbook.',
        rootCause: null,
        lessonType: 'Communication',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to review the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(200);
    await dataSource.query(`
      CREATE FUNCTION reject_return_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'Returned' THEN RAISE EXCEPTION 'return history write intentionally rejected'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_return_history_insert
      BEFORE INSERT ON lesson_history FOR EACH ROW EXECUTE FUNCTION reject_return_history();
    `);

    try {
      await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/return`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version, guidance: 'The failed event must roll back.' })
        .expect(500);

      expect(await dataSource.query('SELECT status, version FROM lessons WHERE id = $1', [created.body.id]))
        .toEqual([{ status: 'PMOEvaluation', version: submitted.body.version }]);
      expect(await dataSource.query(
        "SELECT event_type FROM lesson_history WHERE lesson_id = $1 AND event_type = 'Returned'",
        [created.body.id],
      )).toEqual([]);
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS reject_return_history_insert ON lesson_history');
      await dataSource.query('DROP FUNCTION IF EXISTS reject_return_history()');
    }

    const returnPath = `/api/lessons-learned/v1/lessons/${created.body.id}/return`;
    const decisions = await Promise.all([
      server.post(returnPath)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version, guidance: 'Add a current support owner.' }),
      server.post(returnPath)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version, guidance: 'Add a current support contact.' }),
    ]);
    expect(decisions.map(({ status }) => status).sort()).toEqual([200, 409]);
    const conflict = decisions.find(({ status }) => status === 409);
    expect(conflict?.body.code).toBe('LESSON_NOT_AWAITING_EVALUATION');
    expect(await dataSource.query('SELECT status, version FROM lessons WHERE id = $1', [created.body.id]))
      .toEqual([{ status: 'Open', version: submitted.body.version + 1 }]);
    expect(await dataSource.query(
      "SELECT actor_id, event_type FROM lesson_history WHERE lesson_id = $1 AND event_type = 'Returned'",
      [created.body.id],
    )).toEqual([{ actor_id: 'local-pmo', event_type: 'Returned' }]);
  });

  it('lets PMO approve the complete version it reviewed and records its publication date with history', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        title: 'Publish a verified handover lesson',
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
      .send({
        ...created.body,
        projectId: null,
        projectName: null,
        version: created.body.version,
      })
      .expect(200);

    const approved = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.version })
      .expect(200);

    expect(approved.body).toMatchObject({
      id: created.body.id,
      authorId: 'local-contributor',
      updatedBy: 'local-pmo',
      status: 'Approved',
      version: submitted.body.version + 1,
    });
    expect(Date.parse(approved.body.approvedAt)).not.toBeNaN();
    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.history.at(-1)).toMatchObject({
        actorId: 'local-pmo',
        eventType: 'Approved',
        previousStatus: 'PMOEvaluation',
        newStatus: 'Approved',
      }));
  });

  it('checks PMO permission, the displayed version, and stored completeness before approval', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        title: 'Revalidate the reviewed lesson',
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The handover omitted the current runbook.',
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
      .send({
        ...created.body,
        projectId: null,
        projectName: null,
        version: created.body.version,
      })
      .expect(200);

    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: submitted.body.version })
      .expect(403);
    await dataSource!.query(
      'UPDATE lessons SET version = version + 1, recommendation = NULL WHERE id = $1',
      [created.body.id],
    );

    const stale = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version })
      .expect(409);
    expect(stale.body.code).toBe('STALE_LESSON_VERSION');

    const incomplete = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version + 1 })
      .expect(400);
    expect(incomplete.body).toMatchObject({
      code: 'INVALID_LESSON_APPROVAL',
      fieldErrors: { recommendation: 'Recommendation is required.' },
    });
    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('PMOEvaluation');
        expect(body.approvedAt).toBeNull();
        expect(body.history.map(({ eventType }: { eventType: string }) => eventType)).toEqual(['Created', 'Submitted']);
      });
  });

  it('rolls back approval when recording its history fails', async () => {
    if (!dataSource) throw new Error('The PostgreSQL test database did not start.');
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        title: 'Rollback failed approval history',
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The handover omitted the current runbook.',
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
    await dataSource.query(`
      CREATE FUNCTION reject_approval_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'Approved' THEN RAISE EXCEPTION 'approval history write intentionally rejected'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_approval_history_insert
      BEFORE INSERT ON lesson_history FOR EACH ROW EXECUTE FUNCTION reject_approval_history();
    `);

    try {
      await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version })
        .expect(500);
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS reject_approval_history_insert ON lesson_history');
      await dataSource.query('DROP FUNCTION IF EXISTS reject_approval_history()');
    }

    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('PMOEvaluation');
        expect(body.approvedAt).toBeNull();
        expect(body.history.map(({ eventType }: { eventType: string }) => eventType)).toEqual(['Created', 'Submitted']);
      });
  });

  it('records one approval event when two PMO decisions race on the same version', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        title: 'Resolve concurrent approval decisions',
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The handover omitted the current runbook.',
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

    const decisions = await Promise.all([
      server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version }),
      server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version }),
    ]);
    expect(decisions.map(({ status }) => status).sort()).toEqual([200, 409]);
    const successfulDecision = decisions.find(({ status }) => status === 200)!;
    const rejectedDecision = decisions.find(({ status }) => status === 409)!;
    expect(rejectedDecision.body.code).toBe('LESSON_NOT_AWAITING_EVALUATION');

    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('Approved');
        expect(body.approvedAt).toBe(successfulDecision.body.approvedAt);
        expect(body.history.filter(({ eventType }: { eventType: string }) => eventType === 'Approved')).toHaveLength(1);
      });
  });

  it('lets another Contributor find published lessons while keeping drafts and full history private', async () => {
    const server = request(app!.getHttpServer());
    const publish = async (title: string) => {
      const created = await server
        .post('/api/lessons-learned/v1/lessons')
        .set('X-PMO-Local-User-ID', 'local-contributor')
        .send({
          title,
          projectCategory: 'Technology',
          projectPhase: 'Execution',
          situationObserved: 'The handover omitted the current runbook.',
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
      return approved.body;
    };
    const olderPublication = await publish('Published handover checklist');
    const newerPublication = await publish('Published release verification');
    const privateDraft = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Private lesson still under evaluation' })
      .expect(201);
    const privateSubmission = await server
      .post(`/api/lessons-learned/v1/lessons/${privateDraft.body.id}/submit`)
      .set('X-PMO-Local-USER-ID', 'local-contributor')
      .send({
        ...privateDraft.body,
        version: privateDraft.body.version,
        projectId: null,
        projectName: null,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The handover omitted the current runbook.',
        rootCause: 'No checklist owner had been assigned.',
        lessonType: 'Future Prevention',
        impact: 'The release team repeated verification work.',
        recommendation: 'Assign an owner to review the checklist.',
        applicability: 'Use for releases with shared operational ownership.',
      })
      .expect(200);

    await server
      .get('/api/lessons-learned/v1/lessons/library')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.map(({ id }: { id: number }) => id)).toEqual([
        newerPublication.id,
        olderPublication.id,
      ]));
    await server
      .get('/api/lessons-learned/v1/lessons/library')
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(200)
      .expect(({ body }) => {
        expect(body.map(({ id }: { id: number }) => id)).toEqual([newerPublication.id, olderPublication.id]);
        expect(body.map(({ approvedAt }: { approvedAt: string | null }) => approvedAt)).toEqual([
          newerPublication.approvedAt,
          olderPublication.approvedAt,
        ]);
      });
    const libraryPath = '/api/lessons-learned/v1/lessons/library';
    const reader = { 'X-PMO-Local-User-ID': 'local-other-contributor' };
    const first = await server.get(libraryPath).query({ limit: 1 }).set(reader).expect(200);
    expect(first.body.items[0].id).toBe(newerPublication.id);
    const second = await server.get(libraryPath).query({ cursor: first.body.page.nextCursor, limit: 1 }).set(reader).expect(200);
    expect(second.body.items[0].id).toBe(olderPublication.id);
    expect(second.body.page.nextCursor).toBeNull();
    await server
      .get(`/api/lessons-learned/v1/lessons/${newerPublication.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body.history.at(-1)?.eventType).toBe('Approved'));
    await server
      .get(`/api/lessons-learned/v1/lessons/${newerPublication.id}`)
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(200)
      .expect(({ body }) => {
        expect(body.title).toBe('Published release verification');
        expect(body.history).toEqual([]);
      });
    await server
      .get(`/api/lessons-learned/v1/lessons/${privateSubmission.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(404);
  });

  it('serves Library detail only for published lessons and keeps private and missing IDs indistinguishable', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Published lesson for the Library detail URL' })
      .expect(201);
    const submittedResponse = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: created.body.title,
        projectId: null,
        projectName: null,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The release handover omitted the runbook.',
        rootCause: 'No checklist owner had been assigned.',
        lessonType: 'Future Prevention',
        impact: 'The team repeated verification work.',
        recommendation: 'Assign an owner to maintain the checklist.',
        applicability: 'Use for releases with shared ownership.',
      });
    expect(submittedResponse.status, JSON.stringify(submittedResponse.body)).toBe(200);
    const submitted = submittedResponse.body;
    const published = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.version })
      .expect(200);
    const privateDraft = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Private lesson outside the Library' })
      .expect(201);

    for (const [profileId, canReadHistory] of [
      ['local-contributor', true],
      ['local-other-contributor', false],
      ['local-pmo', true],
    ] as const) {
      const detailsResponse = await server
        .get(`/api/lessons-learned/v1/lessons/library/${published.body.id}`)
        .set('X-PMO-Local-User-ID', profileId);
      expect(detailsResponse.status, JSON.stringify(detailsResponse.body)).toBe(200);
      expect(detailsResponse.body).toMatchObject({
        id: published.body.id,
        title: published.body.title,
        authorName: 'Local Contributor',
        status: 'Approved',
        approvedAt: published.body.approvedAt,
        rootCause: 'No checklist owner had been assigned.',
      });
      expect(detailsResponse.body.history.length > 0).toBe(canReadHistory);
    }

    const hiddenLesson = await server
      .get(`/api/lessons-learned/v1/lessons/library/${privateDraft.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(404);
    const missingLesson = await server
      .get('/api/lessons-learned/v1/lessons/library/2147483000')
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(404);
    expect(hiddenLesson.body).toEqual(missingLesson.body);

    await server.get(`/api/lessons-learned/v1/lessons/library/${published.body.id}`).expect(401);
    await server
      .get(`/api/lessons-learned/v1/lessons/library/${published.body.id}`)
      .set('X-PMO-Local-User-ID', 'revoked-profile')
      .expect(403);

    await server
      .get(`/api/lessons-learned/v1/lessons/${privateDraft.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
  });

  it('lets PMO reject an evaluation with a reason and keeps the archived lesson private to its author', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'A lesson rejected during PMO evaluation' })
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: created.body.title,
        projectId: null,
        projectName: null,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'A previous lesson already covers this scenario.',
        rootCause: 'The lessons were not checked before the report was sent.',
        lessonType: 'Future Prevention',
        impact: 'Readers received duplicate guidance.',
        recommendation: 'Search the existing lessons before adding a new one.',
        applicability: 'Use when preparing a new lesson for PMO review.',
      })
      .expect(200);
    const reason = 'This scenario is already covered by lesson #8.';

    const rejected = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/reject`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version, reason })
      .expect(200);

    expect(rejected.body).toMatchObject({
      id: created.body.id,
      authorId: 'local-contributor',
      updatedBy: 'local-pmo',
      status: 'Archived',
      version: submitted.body.version + 1,
    });
    await server
      .get('/api/lessons-learned/v1/lessons/evaluation-queue')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => expect(body).toEqual([]));
    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.history.at(-1)).toMatchObject({
        actorId: 'local-pmo',
        eventType: 'Rejected',
        previousStatus: 'PMOEvaluation',
        newStatus: 'Archived',
        reason,
      }));
    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(404);
  });

  it('requires a nonblank rejection reason of at most 1,000 characters', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Rejection reason boundary' })
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: created.body.title,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The submitted experience is incomplete.',
        rootCause: 'Some required details are missing.',
        lessonType: 'Future Prevention',
        impact: 'The team could not apply the guidance.',
        recommendation: 'Provide enough detail for PMO review.',
        applicability: 'Use when preparing a new lesson.',
      })
      .expect(200);

    for (const reason of ['', '   ', 'x'.repeat(1001)]) {
      await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/reject`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version, reason })
        .expect(400)
        .expect(({ body }) => {
          expect(body.code).toBe('INVALID_LESSON_REJECTION');
          expect(body.fieldErrors.reason).toBeDefined();
        });
    }

    expect(await dataSource!.query('SELECT status, version FROM lessons WHERE id = $1', [created.body.id]))
      .toEqual([{ status: 'PMOEvaluation', version: submitted.body.version }]);

    const maxLengthReason = 'x'.repeat(1000);
    await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/reject`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version, reason: maxLengthReason })
      .expect(200);
    await server
      .get(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200)
      .expect(({ body }) => expect(body.history.at(-1).reason).toBe(maxLengthReason));
  });

  it('restricts rejection to PMO and validates the evaluation state and current version', async () => {
    const server = request(app!.getHttpServer());
    const open = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'A draft cannot be rejected' })
      .expect(201);
    await server
      .post(`/api/lessons-learned/v1/lessons/${open.body.id}/reject`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: open.body.version, reason: 'Not awaiting evaluation.' })
      .expect(409)
      .expect({
        code: 'LESSON_NOT_AWAITING_EVALUATION',
        message: 'Only lessons awaiting PMO evaluation can be rejected.',
      });

    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${open.body.id}/submit`)
      .set('X-PMO-Local-USER-ID', 'local-contributor')
      .send({
        version: open.body.version,
        title: open.body.title,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The submitted experience needs PMO review.',
        rootCause: 'The team did not identify the gap in time.',
        lessonType: 'Future Prevention',
        impact: 'The planned work needed additional effort.',
        recommendation: 'Review the applicable process before release.',
        applicability: 'Use for similar releases.',
      })
      .expect(200);

    await server
      .post(`/api/lessons-learned/v1/lessons/${open.body.id}/reject`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: submitted.body.version, reason: 'A Contributor cannot decide.' })
      .expect(403);
    await server
      .post(`/api/lessons-learned/v1/lessons/${open.body.id}/reject`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version - 1, reason: 'This version is stale.' })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('STALE_LESSON_VERSION'));
    expect(await dataSource!.query('SELECT status, version FROM lessons WHERE id = $1', [open.body.id]))
      .toEqual([{ status: 'PMOEvaluation', version: submitted.body.version }]);
  });

  it('rolls back rejection when the history event cannot be recorded', async () => {
    if (!dataSource) throw new Error('The PostgreSQL test database did not start.');
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Rejection history is atomic' })
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: created.body.title,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The submitted experience does not apply to this module.',
        rootCause: 'The submission is outside the intended scope.',
        lessonType: 'Future Prevention',
        impact: 'The entry could mislead other project teams.',
        recommendation: 'Confirm the Lessons Learned scope first.',
        applicability: 'Use for submissions to this module.',
      })
      .expect(200);
    await dataSource.query(`
      CREATE FUNCTION reject_rejection_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'Rejected' THEN RAISE EXCEPTION 'rejection history write intentionally rejected'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_rejection_history_insert
      BEFORE INSERT ON lesson_history FOR EACH ROW EXECUTE FUNCTION reject_rejection_history();
    `);

    try {
      await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/reject`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version, reason: 'This rejection must roll back.' })
        .expect(500);
      expect(await dataSource.query('SELECT status, version FROM lessons WHERE id = $1', [created.body.id]))
        .toEqual([{ status: 'PMOEvaluation', version: submitted.body.version }]);
      expect(await dataSource.query(
        'SELECT event_type FROM lesson_history WHERE lesson_id = $1 ORDER BY id',
        [created.body.id],
      )).toEqual([{ event_type: 'Created' }, { event_type: 'Submitted' }]);
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS reject_rejection_history_insert ON lesson_history');
      await dataSource.query('DROP FUNCTION IF EXISTS reject_rejection_history()');
    }
  });

  it('records one rejection when two PMO decisions use the same evaluation version', async () => {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ title: 'Only one rejection should win' })
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        version: created.body.version,
        title: created.body.title,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'The lesson duplicates an existing submission.',
        rootCause: 'Existing entries were not searched.',
        lessonType: 'Future Prevention',
        impact: 'The library could contain repeated guidance.',
        recommendation: 'Search the library before submitting.',
        applicability: 'Use for future lesson contributions.',
      })
      .expect(200);

    const decisions = await Promise.all([
      server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/reject`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version, reason: 'First review decision.' }),
      server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/reject`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: submitted.body.version, reason: 'Competing review decision.' }),
    ]);

    expect(decisions.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(await dataSource!.query('SELECT status FROM lessons WHERE id = $1', [created.body.id]))
      .toEqual([{ status: 'Archived' }]);
    expect(await dataSource!.query(
      "SELECT event_type, reason FROM lesson_history WHERE lesson_id = $1 AND event_type = 'Rejected'",
      [created.body.id],
    )).toHaveLength(1);
  });
});
