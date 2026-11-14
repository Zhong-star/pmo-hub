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

  const profiles = [
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
    await dataSource.query('UPDATE lessons SET status = $2 WHERE id = $1', [created.body.id, 'PMOEvaluation']);

    await request(app!.getHttpServer())
      .patch(`/api/lessons-learned/v1/lessons/${created.body.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ version: created.body.version, title: 'Cannot edit submitted draft' })
      .expect(409)
      .expect({ code: 'LESSON_NOT_OPEN', message: 'Only Open lessons can be edited.' });
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
});
