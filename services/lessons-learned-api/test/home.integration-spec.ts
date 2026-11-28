import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { LESSONS_LEARNED_DATA_SOURCE } from '../src/database/database.module';

describe('Lessons Learned role-aware Home API (#52)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let temporaryDirectory: string;
  let profilesPath: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-lessons-home-'));
    profilesPath = join(temporaryDirectory, 'local-users.json');
    writeFileSync(profilesPath, JSON.stringify([
      { id: 'local-author', displayName: 'Lesson Author', role: 'LESSONS_USER' },
      { id: 'local-other', displayName: 'Other Contributor', role: 'LESSONS_USER' },
      { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' },
    ]), 'utf8');
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = profilesPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';

    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('lessons_learned_home_test')
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
    await dataSource?.query('TRUNCATE lesson_notifications, lesson_comments, lesson_votes, lesson_library_views, lesson_history, lessons RESTART IDENTITY CASCADE');
  });

  const completeLessonPayload = (title: string) => ({
    title,
    projectCategory: 'Technology',
    projectPhase: 'Execution',
    situationObserved: 'Release checklists missed validation steps.',
    rootCause: 'No automated pre-release verification gate.',
    lessonType: 'Future Prevention',
    impact: 'Rework after deployment.',
    recommendation: 'Add a mandatory verification checklist.',
    applicability: 'All delivery teams.',
  });

  async function createDraft(authorId: string, title: string) {
    const response = await request(app!.getHttpServer())
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', authorId)
      .send(completeLessonPayload(title))
      .expect(201);
    return response.body as { id: number; version: number; title: string };
  }

  async function submitDraft(authorId: string, lessonId: number, version: number, title: string) {
    const response = await request(app!.getHttpServer())
      .post(`/api/lessons-learned/v1/lessons/${lessonId}/submit`)
      .set('X-PMO-Local-User-ID', authorId)
      .send({ ...completeLessonPayload(title), version })
      .expect(200);
    return response.body as { id: number; version: number; title: string };
  }

  it('returns Contributor Home with create-lesson primary action, role-scoped shortcuts, and zero leakage of third-party private lessons', async () => {
    const otherDraft = await createDraft('local-other', 'Private draft by other contributor');
    const otherPendingDraft = await createDraft('local-other', 'Pending submission by other contributor');
    await submitDraft('local-other', otherPendingDraft.id, otherPendingDraft.version, otherPendingDraft.title);

    const response = await request(app!.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);

    expect(response.body.profile).toEqual({
      id: 'local-author',
      displayName: 'Lesson Author',
      role: 'LESSONS_USER',
    });
    expect(response.body.notifications).toEqual({
      unreadCount: 0,
      items: [],
    });
    expect(response.body.recentWork).toEqual([]);
    expect(response.body.recentlyApprovedLessons).toEqual([]);
    expect(response.body.highlights).toEqual({
      returnedCount: 0,
      returnedLessons: [],
      openDraftCount: 0,
      openDraftLessons: [],
      pendingEvaluationCount: 0,
      pendingEvaluationLessons: [],
    });
    expect(response.body.primaryAction).toMatchObject({
      kind: 'create-lesson',
      targetPage: 'create-lesson',
      lessonId: null,
    });

    const shortcutIds = (response.body.shortcuts as { id: string }[]).map((s) => s.id);
    expect(shortcutIds).toEqual(expect.arrayContaining(['create-lesson', 'my-submissions', 'library', 'profiles']));
    expect(shortcutIds).not.toContain('pmo-drafts');
    expect(shortcutIds).not.toContain('evaluation-queue');
    expect(shortcutIds).not.toContain('pmo-dashboard');
    expect(JSON.stringify(response.body)).not.toContain(otherDraft.title);
    expect(JSON.stringify(response.body)).not.toContain(otherPendingDraft.title);
  });

  it('prioritizes Contributor contextual primary actions: returned > draft > explore-library, and surfaces unread notifications', async () => {
    const draft = await createDraft('local-author', 'My open draft');

    const withDraft = await request(app!.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);

    expect(withDraft.body.primaryAction).toMatchObject({
      kind: 'continue-draft',
      targetPage: 'my-submissions',
      lessonId: draft.id,
    });
    expect(withDraft.body.highlights.openDraftCount).toBe(1);
    expect(withDraft.body.highlights.openDraftLessons).toHaveLength(1);
    expect(withDraft.body.highlights.openDraftLessons[0]).toMatchObject({
      id: draft.id,
      title: 'My open draft',
      status: 'Open',
      isReturned: false,
    });
    expect(withDraft.body.recentWork).toHaveLength(1);
    expect(withDraft.body.recentWork[0]).toMatchObject({
      id: draft.id,
      title: 'My open draft',
      status: 'Open',
      isReturned: false,
    });

    // Submit a second lesson and have PMO return it
    const toReturn = await createDraft('local-author', 'Needs more root cause detail');
    const submitted = await submitDraft('local-author', toReturn.id, toReturn.version, toReturn.title);
    await request(app!.getHttpServer())
      .post(`/api/lessons-learned/v1/lessons/${submitted.id}/return`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.version, guidance: 'Please expand the root cause section.' })
      .expect(200);

    const withReturned = await request(app!.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);

    expect(withReturned.body.primaryAction).toMatchObject({
      kind: 'review-returned',
      targetPage: 'my-submissions',
      lessonId: submitted.id,
    });
    expect(withReturned.body.highlights.returnedCount).toBe(1);
    expect(withReturned.body.highlights.returnedLessons).toHaveLength(1);
    expect(withReturned.body.highlights.openDraftLessons.map((l: { id: number }) => l.id)).toEqual([draft.id]);
    expect(withReturned.body.highlights.returnedLessons[0]).toMatchObject({
      id: submitted.id,
      title: 'Needs more root cause detail',
      isReturned: true,
      latestReviewGuidance: 'Please expand the root cause section.',
    });
    expect(withReturned.body.notifications.unreadCount).toBe(1);
    expect(withReturned.body.notifications.items).toHaveLength(1);
    expect(withReturned.body.notifications.items[0]).toMatchObject({
      eventType: 'LESSON_RETURNED',
      lessonId: submitted.id,
      isRead: false,
    });

    // Cancel the first draft and resubmit+approve the second so Contributor has only published work
    await request(app!.getHttpServer())
      .post(`/api/lessons-learned/v1/lessons/${draft.id}/cancel`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .send({ version: draft.version, reason: 'Superseded' })
      .expect(200);

    const returnedDetails = await request(app!.getHttpServer())
      .get(`/api/lessons-learned/v1/lessons/${submitted.id}`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    const resubmitted = await submitDraft('local-author', submitted.id, returnedDetails.body.version, submitted.title);
    await request(app!.getHttpServer())
      .post(`/api/lessons-learned/v1/lessons/${resubmitted.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: resubmitted.version })
      .expect(200);

    const withPublishedOnly = await request(app!.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);

    expect(withPublishedOnly.body.primaryAction).toMatchObject({
      kind: 'explore-library',
      targetPage: 'library',
      lessonId: null,
    });
    expect(withPublishedOnly.body.highlights.returnedCount).toBe(0);
    expect(withPublishedOnly.body.highlights.openDraftLessons).toEqual([]);
    expect(withPublishedOnly.body.recentlyApprovedLessons).toHaveLength(1);
    expect(withPublishedOnly.body.recentlyApprovedLessons[0]).toMatchObject({
      id: resubmitted.id,
      title: 'Needs more root cause detail',
      status: 'Approved',
    });
    expect(withPublishedOnly.body.notifications.unreadCount).toBe(2);

    // D7: opening the approved lesson from Home via GET /lessons/:id does not increment viewCount
    await request(app!.getHttpServer())
      .get(`/api/lessons-learned/v1/lessons/${resubmitted.id}`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);

    const libraryRes = await request(app!.getHttpServer())
      .get('/api/lessons-learned/v1/lessons/library')
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    const publishedItem = (libraryRes.body as { id: number; viewCount: number }[]).find((l) => l.id === resubmitted.id);
    expect(publishedItem?.viewCount).toBe(0);
  });

  it('returns PMO Home with pending evaluation highlights, FIFO primary action, PMO shortcuts, and scoped notifications', async () => {
    const first = await createDraft('local-author', 'Oldest pending submission');
    await submitDraft('local-author', first.id, first.version, first.title);
    const second = await createDraft('local-other', 'Second pending submission');
    await submitDraft('local-other', second.id, second.version, second.title);
    const privateDraft = await createDraft('local-other', 'Private contributor draft');

    const approvedFirst = await createDraft('local-author', 'Earlier approved lesson');
    const approvedFirstSub = await submitDraft('local-author', approvedFirst.id, approvedFirst.version, approvedFirst.title);
    await request(app!.getHttpServer())
      .post(`/api/lessons-learned/v1/lessons/${approvedFirstSub.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: approvedFirstSub.version })
      .expect(200);

    const approvedSecond = await createDraft('local-other', 'Newest approved lesson');
    const approvedSecondSub = await submitDraft('local-other', approvedSecond.id, approvedSecond.version, approvedSecond.title);
    await request(app!.getHttpServer())
      .post(`/api/lessons-learned/v1/lessons/${approvedSecondSub.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: approvedSecondSub.version })
      .expect(200);

    const response = await request(app!.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);

    expect(response.body.profile).toEqual({
      id: 'local-pmo',
      displayName: 'Local PMO',
      role: 'LESSONS_MODERATOR',
    });
    expect(response.body.highlights.pendingEvaluationCount).toBe(2);
    expect(response.body.highlights.pendingEvaluationLessons.map((l: { id: number }) => l.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(response.body.recentlyApprovedLessons.map((l: { id: number }) => l.id)).toEqual([
      approvedSecond.id,
      approvedFirst.id,
    ]);
    expect(JSON.stringify(response.body.recentlyApprovedLessons)).not.toContain(privateDraft.title);
    expect(JSON.stringify(response.body.recentlyApprovedLessons)).not.toContain(first.title);
    expect(response.body.primaryAction).toMatchObject({
      kind: 'evaluate-pending',
      targetPage: 'evaluation-queue',
      lessonId: first.id,
    });

    const shortcutIds = (response.body.shortcuts as { id: string }[]).map((s) => s.id);
    expect(shortcutIds).toEqual(expect.arrayContaining([
      'evaluation-queue',
      'pmo-dashboard',
      'library',
      'create-lesson',
      'pmo-drafts',
    ]));
    expect(response.body.recentWork.length).toBeGreaterThanOrEqual(2);
    expect(response.body.notifications.unreadCount).toBe(0);
  });

  it('translates unexpected persistence errors in /home into RFC 9457 application/problem+json without leaking internals', async () => {
    vi.spyOn(dataSource!, 'transaction').mockRejectedValueOnce(new Error('db outage: postgres://secret'));

    const response = await request(app!.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-author')
      .set('Accept', 'application/json, application/problem+json')
      .expect('Content-Type', /application\/problem\+json/)
      .expect('Cache-Control', 'no-store')
      .expect(500);

    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.body).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'Internal Server Error',
      instance: '/api/lessons-learned/v1/home',
    });
    expect(JSON.stringify(response.body)).not.toContain('postgres://secret');
  });
});
