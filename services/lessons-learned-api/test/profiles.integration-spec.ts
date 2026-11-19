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

describe('Profile Search and Contributor Profile API', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let temporaryDirectory: string;
  let profilesPath: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-profiles-'));
    profilesPath = join(temporaryDirectory, 'local-users.json');
    writeFileSync(profilesPath, JSON.stringify([
      { id: 'user-jose', displayName: 'José Silva', role: 'LESSONS_USER' },
      { id: 'user-ana', displayName: 'Ana Costa', role: 'LESSONS_USER' },
      { id: 'user-zero', displayName: 'Bruno Zero', role: 'LESSONS_USER' },
      { id: 'local-pmo', displayName: 'Clara PMO', role: 'LESSONS_MODERATOR' },
    ]), 'utf8');
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = profilesPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';

    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('lessons_learned_profiles_test')
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
    await dataSource?.query('TRUNCATE lesson_votes, lesson_library_views, lesson_history, lessons RESTART IDENTITY CASCADE');
  });

  async function createCompleteDraft(
    overrides: Record<string, unknown> = {},
    authorId = 'user-ana',
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

  async function submitLesson(lesson: Record<string, unknown>, authorId = 'user-ana') {
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

  async function cancelLesson(lesson: Record<string, unknown>, authorId = 'user-ana') {
    const server = request(app!.getHttpServer());
    const response = await server
      .post(`/api/lessons-learned/v1/lessons/${lesson.id}/cancel`)
      .set('X-PMO-Local-User-ID', authorId)
      .send({ version: lesson.version, reason: 'No longer needed.' })
      .expect(200);
    return response.body;
  }

  async function castVote(lessonId: number, voterId: string) {
    const server = request(app!.getHttpServer());
    await server
      .put(`/api/lessons-learned/v1/lessons/${lessonId}/vote`)
      .set('X-PMO-Local-User-ID', voterId)
      .expect(200);
  }

  async function recordView(lessonId: number, viewerId: string, openingId: string) {
    const server = request(app!.getHttpServer());
    const response = await server
      .post(`/api/lessons-learned/v1/lessons/library/${lessonId}/views`)
      .set('X-PMO-Local-User-ID', viewerId)
      .send({ openingId })
      .expect(200);
    return response.body;
  }

  it('requires authentication and authorization for profile endpoints', async () => {
    const server = request(app!.getHttpServer());
    await server.get('/api/lessons-learned/v1/profiles').expect(401);
    await server
      .get('/api/lessons-learned/v1/profiles')
      .set('X-PMO-Local-User-ID', 'unknown-user')
      .expect(403);
    await server
      .get('/api/lessons-learned/v1/profiles/user-ana')
      .set('X-PMO-Local-User-ID', 'unknown-user')
      .expect(403);
  });

  it('lists authorized users sorted alphabetically by displayName ASC including users with zero published lessons and computes public aggregates strictly over Approved + Closed lessons', async () => {
    const server = request(app!.getHttpServer());

    // Ana has 1 Approved, 1 Closed, 1 Open draft, 1 PMOEvaluation, 1 Archived
    const anaApproved = await approveLesson(await submitLesson(await createCompleteDraft({ title: 'Ana Approved' }, 'user-ana'), 'user-ana'));
    const anaClosed = await closeLesson(await approveLesson(await submitLesson(await createCompleteDraft({ title: 'Ana Closed' }, 'user-ana'), 'user-ana')));
    await createCompleteDraft({ title: 'Ana Private Open' }, 'user-ana');
    await submitLesson(await createCompleteDraft({ title: 'Ana Private Pending' }, 'user-ana'), 'user-ana');
    await cancelLesson(await createCompleteDraft({ title: 'Ana Private Archived' }, 'user-ana'), 'user-ana');

    // Bruno Zero has only a private draft (0 published)
    await createCompleteDraft({ title: 'Bruno Secret Draft' }, 'user-zero');

    // Votes and views on Ana's published lessons
    await castVote(anaApproved.id, 'user-jose');
    await castVote(anaApproved.id, 'local-pmo');
    await castVote(anaClosed.id, 'user-ana');
    await recordView(anaApproved.id, 'user-jose', '11111111-1111-4111-8111-111111111111');
    await recordView(anaApproved.id, 'local-pmo', '22222222-2222-4222-8222-222222222222');
    await recordView(anaClosed.id, 'user-jose', '33333333-3333-4333-8333-333333333333');

    const response = await server
      .get('/api/lessons-learned/v1/profiles')
      .set('X-PMO-Local-User-ID', 'user-jose')
      .expect(200);

    expect(response.body.map((p: { id: string }) => p.id)).toEqual([
      'user-ana',
      'user-zero',
      'local-pmo',
      'user-jose',
    ]);

    expect(response.body[0]).toEqual({
      id: 'user-ana',
      displayName: 'Ana Costa',
      initials: 'AC',
      role: 'LESSONS_USER',
      publishedLessonsCount: 2,
      votesReceivedCount: 3,
      viewsReceivedCount: 3,
    });

    expect(response.body[1]).toEqual({
      id: 'user-zero',
      displayName: 'Bruno Zero',
      initials: 'BZ',
      role: 'LESSONS_USER',
      publishedLessonsCount: 0,
      votesReceivedCount: 0,
      viewsReceivedCount: 0,
    });

    // Accent-insensitive search
    const searchResponse = await server
      .get('/api/lessons-learned/v1/profiles')
      .query({ search: 'jose' })
      .set('X-PMO-Local-User-ID', 'user-ana')
      .expect(200);

    expect(searchResponse.body).toHaveLength(1);
    expect(searchResponse.body[0].id).toBe('user-jose');
    expect(searchResponse.body[0].initials).toBe('JS');
  });

  it('enforces Contributor Profile visibility by role and authorship while keeping public aggregates strictly over published lessons', async () => {
    const server = request(app!.getHttpServer());

    const approved = await approveLesson(await submitLesson(await createCompleteDraft({
      title: 'Published Alpha',
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
      lessonType: 'Success to Repeat',
    }, 'user-ana'), 'user-ana'));

    const closed = await closeLesson(await approveLesson(await submitLesson(await createCompleteDraft({
      title: 'Published Beta',
      projectId: null,
      projectName: null,
      lessonType: 'Communication',
    }, 'user-ana'), 'user-ana')));

    const openDraft = await createCompleteDraft({
      title: 'Private Open Draft',
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
      lessonType: 'Future Prevention',
    }, 'user-ana');

    const pendingDraft = await submitLesson(await createCompleteDraft({
      title: 'Private Pending Lesson',
      projectId: null,
      projectName: null,
      lessonType: 'Risk Avoided',
    }, 'user-ana'), 'user-ana');

    const archivedDraft = await cancelLesson(await createCompleteDraft({
      title: 'Private Archived Lesson',
      projectId: null,
      projectName: null,
      lessonType: 'Communication',
    }, 'user-ana'), 'user-ana');

    await castVote(approved.id, 'user-jose');
    await recordView(closed.id, 'user-jose', '44444444-4444-4444-8444-444444444444');

    // Another Contributor sees ONLY published lessons
    const otherRes = await server
      .get('/api/lessons-learned/v1/profiles/user-ana')
      .set('X-PMO-Local-User-ID', 'user-jose')
      .expect(200);

    expect(otherRes.body.includesPrivateLessons).toBe(false);
    expect(otherRes.body.profile).toEqual({
      id: 'user-ana',
      displayName: 'Ana Costa',
      initials: 'AC',
      role: 'LESSONS_USER',
      publishedLessonsCount: 2,
      votesReceivedCount: 1,
      viewsReceivedCount: 1,
    });
    expect(otherRes.body.items.map((item: { id: number }) => item.id)).toEqual([closed.id, approved.id]);
    expect(otherRes.body.items.find((item: { id: number }) => item.id === approved.id).hasVoted).toBe(true);

    // Self sees published + private lessons, but public aggregates remain strictly published (2, 1, 1)
    const selfRes = await server
      .get('/api/lessons-learned/v1/profiles/user-ana')
      .set('X-PMO-Local-User-ID', 'user-ana')
      .expect(200);

    expect(selfRes.body.includesPrivateLessons).toBe(true);
    expect(selfRes.body.profile.publishedLessonsCount).toBe(2);
    expect(selfRes.body.profile.votesReceivedCount).toBe(1);
    expect(selfRes.body.profile.viewsReceivedCount).toBe(1);
    expect(selfRes.body.items.map((item: { id: number }) => item.id).sort((a: number, b: number) => a - b)).toEqual(
      [approved.id, closed.id, openDraft.id, pendingDraft.id, archivedDraft.id].sort((a, b) => a - b),
    );

    // PMO sees all lessons, public aggregates still strictly published (2, 1, 1)
    const pmoRes = await server
      .get('/api/lessons-learned/v1/profiles/user-ana')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);

    expect(pmoRes.body.includesPrivateLessons).toBe(true);
    expect(pmoRes.body.profile.publishedLessonsCount).toBe(2);
    expect(pmoRes.body.items).toHaveLength(5);

    // Unknown profile returns 404
    await server
      .get('/api/lessons-learned/v1/profiles/does-not-exist')
      .set('X-PMO-Local-User-ID', 'user-jose')
      .expect(404);
  });

  it('supports filtering by project (including withoutProject) and lessonType, and deterministic sorting on Contributor Profile', async () => {
    const server = request(app!.getHttpServer());

    const lessonA = await approveLesson(await submitLesson(await createCompleteDraft({
      title: 'Beta Lesson',
      projectId: 'LOCAL-PROJECT-001',
      projectName: 'Fictional Atlas Modernization',
      lessonType: 'Success to Repeat',
    }, 'user-ana'), 'user-ana'));

    const lessonB = await approveLesson(await submitLesson(await createCompleteDraft({
      title: 'Alpha Lesson',
      projectId: null,
      projectName: null,
      lessonType: 'Communication',
    }, 'user-ana'), 'user-ana'));

    await castVote(lessonA.id, 'user-jose');
    await castVote(lessonA.id, 'local-pmo');

    // Filter by withoutProject=true
    const noProjectRes = await server
      .get('/api/lessons-learned/v1/profiles/user-ana')
      .query({ withoutProject: 'true' })
      .set('X-PMO-Local-User-ID', 'user-jose')
      .expect(200);

    expect(noProjectRes.body.items.map((item: { id: number }) => item.id)).toEqual([lessonB.id]);
    // Public aggregates remain unfiltered totals
    expect(noProjectRes.body.profile.publishedLessonsCount).toBe(2);
    expect(noProjectRes.body.profile.votesReceivedCount).toBe(2);

    // Filter by projectId + lessonType
    const projectTypeRes = await server
      .get('/api/lessons-learned/v1/profiles/user-ana')
      .query({ projectId: 'LOCAL-PROJECT-001', lessonType: 'Success to Repeat' })
      .set('X-PMO-Local-User-ID', 'user-jose')
      .expect(200);

    expect(projectTypeRes.body.items.map((item: { id: number }) => item.id)).toEqual([lessonA.id]);

    // Sort by most-voted
    const mostVotedRes = await server
      .get('/api/lessons-learned/v1/profiles/user-ana')
      .query({ sort: 'most-voted' })
      .set('X-PMO-Local-User-ID', 'user-jose')
      .expect(200);

    expect(mostVotedRes.body.items.map((item: { id: number }) => item.id)).toEqual([lessonA.id, lessonB.id]);

    // Sort by title
    const titleRes = await server
      .get('/api/lessons-learned/v1/profiles/user-ana')
      .query({ sort: 'title' })
      .set('X-PMO-Local-User-ID', 'user-jose')
      .expect(200);

    expect(titleRes.body.items.map((item: { id: number }) => item.id)).toEqual([lessonB.id, lessonA.id]);
  });

  it('increments viewsReceivedCount idempotently when recording a view for a published lesson (D7)', async () => {
    const server = request(app!.getHttpServer());
    const published = await approveLesson(await submitLesson(await createCompleteDraft({
      title: 'Discoverable Lesson',
    }, 'user-ana'), 'user-ana'));

    const openingId = '55555555-5555-4555-8555-555555555555';
    const first = await recordView(published.id, 'user-jose', openingId);
    expect(first.viewCount).toBe(1);

    // Duplicate openingId is idempotent
    const duplicate = await recordView(published.id, 'user-jose', openingId);
    expect(duplicate.viewCount).toBe(1);

    const profileRes = await server
      .get('/api/lessons-learned/v1/profiles/user-ana')
      .set('X-PMO-Local-User-ID', 'user-jose')
      .expect(200);

    expect(profileRes.body.profile.viewsReceivedCount).toBe(1);
    expect(profileRes.body.items[0].viewCount).toBe(1);
  });
});
