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

describe('PMO Dashboard operational API', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let temporaryDirectory: string;
  let profilesPath: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-pmo-dashboard-'));
    profilesPath = join(temporaryDirectory, 'local-users.json');
    writeFileSync(profilesPath, JSON.stringify([
      { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' },
      { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' },
    ]), 'utf8');
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = profilesPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';

    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('lessons_learned_dashboard_test')
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
    await dataSource?.query('TRUNCATE lesson_library_views, lesson_history, lessons RESTART IDENTITY CASCADE');
  });

  async function createCompleteDraft(
    overrides: Record<string, unknown> = {},
    authorId = 'local-contributor',
  ) {
    const server = request(app!.getHttpServer());
    const response = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', authorId)
      .send({
        title: 'Standard release checklist',
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'Observed situation during rollout.',
        rootCause: 'Checklist lacked clear ownership.',
        lessonType: 'Future Prevention',
        impact: 'Extra rework during deployment.',
        recommendation: 'Assign a checklist owner.',
        applicability: 'All production releases.',
        ...overrides,
      })
      .expect(201);
    return response.body;
  }

  async function submitLesson(lesson: Record<string, unknown>, authorId = 'local-contributor') {
    const server = request(app!.getHttpServer());
    const response = await server
      .post(`/api/lessons-learned/v1/lessons/${lesson.id}/submit`)
      .set('X-PMO-Local-User-ID', authorId)
      .send({ ...lesson, version: lesson.version })
      .expect(200);
    return response.body;
  }

  async function approveLesson(lesson: Record<string, unknown>) {
    const server = request(app!.getHttpServer());
    const response = await server
      .post(`/api/lessons-learned/v1/lessons/${lesson.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: lesson.version })
      .expect(200);
    return response.body;
  }

  async function closeLesson(lesson: Record<string, unknown>) {
    const server = request(app!.getHttpServer());
    const response = await server
      .post(`/api/lessons-learned/v1/lessons/${lesson.id}/close`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: lesson.version })
      .expect(200);
    return response.body;
  }

  async function returnLesson(lesson: Record<string, unknown>, guidance = 'Clarify root cause.') {
    const server = request(app!.getHttpServer());
    const response = await server
      .post(`/api/lessons-learned/v1/lessons/${lesson.id}/return`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: lesson.version, guidance })
      .expect(200);
    return response.body;
  }

  it('restricts PMO Dashboard access to PMO moderators and returns 401/403 otherwise', async () => {
    const server = request(app!.getHttpServer());

    await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .expect(401);

    await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .set('Accept', 'application/problem+json')
      .expect(403)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 403,
          code: 'ACCESS_DENIED',
        });
      });

    await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect(({ body }) => {
        expect(body.windowDays).toBe(30);
        expect(body.summary).toEqual({
          awaitingEvaluation: 0,
          recentlyApproved: 0,
          recentlyClosed: 0,
          recentlyReturned: 0,
        });
        expect(body.items).toEqual([]);
        expect(body.projects).toEqual([]);
      });
  });

  it('computes the 4 summary cards strictly over a 30-day UTC window using approval date and history events, and sorts by most recent activity DESC', async () => {
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

    // 1. Awaiting evaluation (submitted 2 days ago)
    const awaiting = await submitLesson(await createCompleteDraft({
      title: 'Awaiting evaluation lesson',
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
    }));
    await dataSource!.query(`UPDATE lessons SET updated_at = $1 WHERE id = $2`, [daysAgo(2), awaiting.id]);
    await dataSource!.query(`UPDATE lesson_history SET occurred_at = $1 WHERE lesson_id = $2`, [daysAgo(2), awaiting.id]);

    // 2. Recently approved (approved 5 days ago)
    const recentApproved = await approveLesson(await submitLesson(await createCompleteDraft({
      title: 'Recently approved lesson',
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
    })));
    await dataSource!.query(`UPDATE lessons SET approved_at = $1, updated_at = $1 WHERE id = $2`, [daysAgo(5), recentApproved.id]);
    await dataSource!.query(`UPDATE lesson_history SET occurred_at = $1 WHERE lesson_id = $2`, [daysAgo(5), recentApproved.id]);

    // 3. Old approved (approved 35 days ago — outside 30-day window)
    const oldApproved = await approveLesson(await submitLesson(await createCompleteDraft({
      title: 'Old approved lesson',
    })));
    await dataSource!.query(`UPDATE lessons SET approved_at = $1, updated_at = $1 WHERE id = $2`, [daysAgo(35), oldApproved.id]);
    await dataSource!.query(`UPDATE lesson_history SET occurred_at = $1 WHERE lesson_id = $2`, [daysAgo(35), oldApproved.id]);

    // 4. Approved 45 days ago, closed 3 days ago (counts in recentlyClosed only, NOT recentlyApproved)
    const recentClosed = await closeLesson(await approveLesson(await submitLesson(await createCompleteDraft({
      title: 'Recently closed lesson',
      lessonType: 'Risk Avoided',
    }))));
    await dataSource!.query(`UPDATE lessons SET approved_at = $1, updated_at = $2 WHERE id = $3`, [daysAgo(45), daysAgo(3), recentClosed.id]);
    await dataSource!.query(`UPDATE lesson_history SET occurred_at = $1 WHERE lesson_id = $2 AND event_type <> 'Closed'`, [daysAgo(45), recentClosed.id]);
    await dataSource!.query(`UPDATE lesson_history SET occurred_at = $1 WHERE lesson_id = $2 AND event_type = 'Closed'`, [daysAgo(3), recentClosed.id]);

    // 5. Approved 50 days ago, closed 32 days ago (outside 30-day window)
    const oldClosed = await closeLesson(await approveLesson(await submitLesson(await createCompleteDraft({
      title: 'Old closed lesson',
    }))));
    await dataSource!.query(`UPDATE lessons SET approved_at = $1, updated_at = $2 WHERE id = $3`, [daysAgo(50), daysAgo(32), oldClosed.id]);
    await dataSource!.query(`UPDATE lesson_history SET occurred_at = $1 WHERE lesson_id = $2 AND event_type <> 'Closed'`, [daysAgo(50), oldClosed.id]);
    await dataSource!.query(`UPDATE lesson_history SET occurred_at = $1 WHERE lesson_id = $2 AND event_type = 'Closed'`, [daysAgo(32), oldClosed.id]);

    // 6. Returned 1 day ago (most recent activity overall)
    const recentReturned = await returnLesson(await submitLesson(await createCompleteDraft({
      title: 'Éxample returned lesson',
      lessonType: 'Communication',
    })));
    await dataSource!.query(`UPDATE lessons SET updated_at = $1 WHERE id = $2`, [daysAgo(4), recentReturned.id]);
    await dataSource!.query(`UPDATE lesson_history SET occurred_at = $1 WHERE lesson_id = $2 AND event_type <> 'Returned'`, [daysAgo(4), recentReturned.id]);
    await dataSource!.query(`UPDATE lesson_history SET occurred_at = $1 WHERE lesson_id = $2 AND event_type = 'Returned'`, [daysAgo(1), recentReturned.id]);

    // 7. Returned 31 days ago (outside 30-day window)
    const oldReturned = await returnLesson(await submitLesson(await createCompleteDraft({
      title: 'Old returned lesson',
    })));
    await dataSource!.query(`UPDATE lessons SET updated_at = $1 WHERE id = $2`, [daysAgo(31), oldReturned.id]);
    await dataSource!.query(`UPDATE lesson_history SET occurred_at = $1 WHERE lesson_id = $2`, [daysAgo(31), oldReturned.id]);

    const server = request(app!.getHttpServer());
    const response = await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);

    expect(response.body.summary).toEqual({
      awaitingEvaluation: 1,
      recentlyApproved: 1,
      recentlyClosed: 1,
      recentlyReturned: 1,
    });

    // Default sort: most recent relevant activity DESC (recentReturned 1d > awaiting 2d > recentClosed 3d > recentApproved 5d > oldReturned 31d > oldClosed 32d > oldApproved 35d)
    expect(response.body.items.map((item: { id: number }) => item.id)).toEqual([
      recentReturned.id,
      awaiting.id,
      recentClosed.id,
      recentApproved.id,
      oldReturned.id,
      oldClosed.id,
      oldApproved.id,
    ]);

    expect(response.body.projects).toEqual([
      { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' },
    ]);

    // Quick-filter cards narrow the list while keeping summary derived from the base filtered set
    const closedCard = await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .query({ card: 'recently-closed' })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(closedCard.body.summary).toEqual(response.body.summary);
    expect(closedCard.body.items.map((item: { id: number }) => item.id)).toEqual([recentClosed.id]);

    const returnedCard = await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .query({ card: 'recently-returned' })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(returnedCard.body.items.map((item: { id: number }) => item.id)).toEqual([recentReturned.id]);

    // Combined search & filters derive summary strictly from the filtered set
    const apolloFiltered = await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .query({ projectId: 'LOCAL-PROJECT-001' })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(apolloFiltered.body.summary).toEqual({
      awaitingEvaluation: 1,
      recentlyApproved: 1,
      recentlyClosed: 0,
      recentlyReturned: 0,
    });
    expect(apolloFiltered.body.items.map((item: { id: number }) => item.id)).toEqual([
      awaiting.id,
      recentApproved.id,
    ]);

    // Accent-insensitive title prefix search
    const prefixSearch = await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .query({ search: 'example' })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(prefixSearch.body.items.map((item: { id: number }) => item.id)).toEqual([recentReturned.id]);
    expect(prefixSearch.body.summary).toEqual({
      awaitingEvaluation: 0,
      recentlyApproved: 0,
      recentlyClosed: 0,
      recentlyReturned: 1,
    });

    // Exact ID search with and without '#'
    const hashIdSearch = await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .query({ search: `#${recentClosed.id}` })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(hashIdSearch.body.items.map((item: { id: number }) => item.id)).toEqual([recentClosed.id]);
    expect(hashIdSearch.body.summary.recentlyClosed).toBe(1);

    const plainIdSearch = await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .query({ search: String(awaiting.id) })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(plainIdSearch.body.items.map((item: { id: number }) => item.id)).toEqual([awaiting.id]);

    // Filter withoutProject + lessonType + status + alternate sort
    const noProjectFiltered = await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .query({ withoutProject: 'true', lessonType: 'Risk Avoided', status: 'Closed', sort: 'title' })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(noProjectFiltered.body.items.map((item: { id: number }) => item.id)).toEqual([recentClosed.id]);
    expect(noProjectFiltered.body.summary).toEqual({
      awaitingEvaluation: 0,
      recentlyApproved: 0,
      recentlyClosed: 1,
      recentlyReturned: 0,
    });

    // D7: Opening lesson detail via GET /lessons/:id from PMO Dashboard does NOT increment viewCount
    await server
      .get(`/api/lessons-learned/v1/lessons/${recentApproved.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    const afterDetailOpen = await server
      .get('/api/lessons-learned/v1/pmo/dashboard')
      .query({ search: `#${recentApproved.id}` })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(afterDetailOpen.body.items[0].viewCount).toBe(0);
  });
});
