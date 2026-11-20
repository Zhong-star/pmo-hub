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

describe('Lessons Learned votes', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let temporaryDirectory: string;
  let profilesPath: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;
  const previousTokenFormat = process.env.LESSONS_LEARNED_TOKEN_FORMAT;

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-lessons-votes-'));
    profilesPath = join(temporaryDirectory, 'local-users.json');
    writeFileSync(profilesPath, JSON.stringify([
      { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' },
      { id: 'local-other-contributor', displayName: 'Other Contributor', role: 'LESSONS_USER' },
      { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' },
    ]), 'utf8');
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = profilesPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';
    process.env.LESSONS_LEARNED_TOKEN_FORMAT = 'representation';

    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('lessons_learned_votes_test')
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
      if (previousTokenFormat === undefined) delete process.env.LESSONS_LEARNED_TOKEN_FORMAT;
      else process.env.LESSONS_LEARNED_TOKEN_FORMAT = previousTokenFormat;
    }
  }, 120_000);

  beforeEach(async () => {
    await dataSource?.query('TRUNCATE lesson_history, lessons RESTART IDENTITY CASCADE');
  });

  async function createPublishedLesson(
    title: string,
    options: { authorId?: string; close?: boolean; projectId?: string; projectName?: string; lessonType?: string } = {},
  ): Promise<{ id: number; version: number; approvedAt: string }> {
    const server = request(app!.getHttpServer());
    const authorId = options.authorId ?? 'local-contributor';
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', authorId)
      .send({
        title,
        ...(options.projectId ? { projectId: options.projectId, projectName: options.projectName } : {}),
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'Release handover omitted the checklist.',
        rootCause: 'No owner was assigned.',
        lessonType: options.lessonType ?? 'Future Prevention',
        impact: 'Verification work was repeated.',
        recommendation: 'Assign a checklist owner.',
        applicability: 'Shared operational releases.',
      })
      .expect(201);

    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', authorId)
      .send({ ...created.body, version: created.body.version })
      .expect(200);

    const approved = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version })
      .expect(200);

    if (options.close) {
      const closed = await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/close`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: approved.body.version })
        .expect(200);
      return { id: closed.body.id, version: closed.body.version, approvedAt: closed.body.approvedAt };
    }

    return { id: approved.body.id, version: approved.body.version, approvedAt: approved.body.approvedAt };
  }

  it('closes a voted lesson using the current ETag from its Library Detail', async () => {
    const server = request(app!.getHttpServer());
    const lesson = await createPublishedLesson('Voted lesson ready to close');
    const collection = '/api/lessons-learned/v1/lessons';
    const pmo = { 'X-PMO-Local-User-ID': 'local-pmo', Accept: 'application/json, application/problem+json' };
    const detailPath = `${collection}/library/${lesson.id}`;
    const closePath = `${collection}/${lesson.id}/close`;
    const beforeVote = await server.get(detailPath).set(pmo).expect(200);

    await server.put(`${collection}/${lesson.id}/vote`).set(pmo).expect(200);
    const current = await server.get(detailPath).set(pmo).expect(200);
    expect(current.body).toMatchObject({ votesCount: 1, hasVoted: true, version: lesson.version });
    expect(current.headers.etag).toMatch(/-[a-f0-9]{64}"$/);
    await server.post(closePath).set(pmo).set('If-Match', beforeVote.headers.etag).send({}).expect(412);
    await server.post(closePath).set(pmo).set('If-Match', current.headers.etag).send({}).expect(200)
      .expect(({ body }) => expect(body.status).toBe('Closed'));
  });

  it('lets Contributor and PMO vote and remove their own vote on Approved and Closed lessons with consistent Library and Detail counts', async () => {
    const server = request(app!.getHttpServer());
    const approvedLesson = await createPublishedLesson('Approved lesson for voting');
    const closedLesson = await createPublishedLesson('Closed lesson for voting', { close: true });

    // Contributor votes on Approved lesson
    const contributorVote = await server
      .put(`/api/lessons-learned/v1/lessons/${approvedLesson.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(contributorVote.body).toEqual({
      lessonId: approvedLesson.id,
      votesCount: 1,
      hasVoted: true,
    });

    // PMO votes on the same Approved lesson -> total becomes 2
    const pmoVote = await server
      .put(`/api/lessons-learned/v1/lessons/${approvedLesson.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(pmoVote.body).toEqual({
      lessonId: approvedLesson.id,
      votesCount: 2,
      hasVoted: true,
    });

    // Contributor also votes on Closed lesson
    const closedVote = await server
      .put(`/api/lessons-learned/v1/lessons/${closedLesson.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(closedVote.body).toEqual({
      lessonId: closedLesson.id,
      votesCount: 1,
      hasVoted: true,
    });

    // Library shows votesCount and caller-specific hasVoted
    const contributorLibrary = await server
      .get('/api/lessons-learned/v1/lessons/library')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(contributorLibrary.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: approvedLesson.id, votesCount: 2, hasVoted: true }),
      expect.objectContaining({ id: closedLesson.id, votesCount: 1, hasVoted: true }),
    ]));

    const otherContributorLibrary = await server
      .get('/api/lessons-learned/v1/lessons/library')
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(200);
    expect(otherContributorLibrary.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: approvedLesson.id, votesCount: 2, hasVoted: false }),
      expect.objectContaining({ id: closedLesson.id, votesCount: 1, hasVoted: false }),
    ]));

    // Detail endpoints reflect the same counts and caller-specific hasVoted
    const libraryDetail = await server
      .get(`/api/lessons-learned/v1/lessons/library/${approvedLesson.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(libraryDetail.body).toMatchObject({
      id: approvedLesson.id,
      votesCount: 2,
      hasVoted: true,
    });

    const lessonDetail = await server
      .get(`/api/lessons-learned/v1/lessons/${approvedLesson.id}`)
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(200);
    expect(lessonDetail.body).toMatchObject({
      id: approvedLesson.id,
      votesCount: 2,
      hasVoted: false,
    });

    // Contributor removes own vote -> total becomes 1, PMO vote stays intact
    const removed = await server
      .delete(`/api/lessons-learned/v1/lessons/${approvedLesson.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(removed.body).toEqual({
      lessonId: approvedLesson.id,
      votesCount: 1,
      hasVoted: false,
    });

    const pmoDetailAfterRemoval = await server
      .get(`/api/lessons-learned/v1/lessons/library/${approvedLesson.id}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(pmoDetailAfterRemoval.body).toMatchObject({
      id: approvedLesson.id,
      votesCount: 1,
      hasVoted: true,
    });
  });

  it('prevents duplicate votes and preserves exact totals under repeated and concurrent requests', async () => {
    const server = request(app!.getHttpServer());
    const lesson = await createPublishedLesson('Concurrent vote uniqueness');

    // Concurrent repeated PUTs from the same user
    const sameUserResults = await Promise.all(
      Array.from({ length: 6 }, () =>
        server
          .put(`/api/lessons-learned/v1/lessons/${lesson.id}/vote`)
          .set('X-PMO-Local-User-ID', 'local-contributor')
          .expect(200),
      ),
    );
    for (const res of sameUserResults) {
      expect(res.body).toEqual({ lessonId: lesson.id, votesCount: 1, hasVoted: true });
    }

    // Concurrent PUTs from multiple distinct users
    await Promise.all([
      server.put(`/api/lessons-learned/v1/lessons/${lesson.id}/vote`).set('X-PMO-Local-User-ID', 'local-other-contributor').expect(200),
      server.put(`/api/lessons-learned/v1/lessons/${lesson.id}/vote`).set('X-PMO-Local-User-ID', 'local-pmo').expect(200),
      server.put(`/api/lessons-learned/v1/lessons/${lesson.id}/vote`).set('X-PMO-Local-User-ID', 'local-contributor').expect(200),
    ]);

    const detailAfterConcurrentVotes = await server
      .get(`/api/lessons-learned/v1/lessons/library/${lesson.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(detailAfterConcurrentVotes.body).toMatchObject({ votesCount: 3, hasVoted: true });

    // Concurrent repeated DELETEs from the same user
    const sameUserRemovals = await Promise.all(
      Array.from({ length: 4 }, () =>
        server
          .delete(`/api/lessons-learned/v1/lessons/${lesson.id}/vote`)
          .set('X-PMO-Local-User-ID', 'local-contributor')
          .expect(200),
      ),
    );
    for (const res of sameUserRemovals) {
      expect(res.body).toEqual({ lessonId: lesson.id, votesCount: 2, hasVoted: false });
    }
  });

  it('blocks voting on Open, PMOEvaluation, and Archived lessons and enforces authentication/visibility', async () => {
    const server = request(app!.getHttpServer());

    // Open draft
    const openDraft = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({
        title: 'Open draft cannot be voted',
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'Situation.',
        rootCause: 'Root cause.',
        lessonType: 'Future Prevention',
        impact: 'Impact.',
        recommendation: 'Recommendation.',
        applicability: 'Applicability.',
      })
      .expect(201);

    // Author and PMO see 409 LESSON_NOT_PUBLISHED on Open draft
    await server
      .put(`/api/lessons-learned/v1/lessons/${openDraft.body.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('LESSON_NOT_PUBLISHED'));
    await server
      .delete(`/api/lessons-learned/v1/lessons/${openDraft.body.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('LESSON_NOT_PUBLISHED'));

    // Another contributor cannot discover a private Open draft (404)
    await server
      .put(`/api/lessons-learned/v1/lessons/${openDraft.body.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(404);

    // Submit -> PMOEvaluation
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${openDraft.body.id}/submit`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ ...openDraft.body, version: openDraft.body.version })
      .expect(200);

    await server
      .put(`/api/lessons-learned/v1/lessons/${submitted.body.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('LESSON_NOT_PUBLISHED'));
    await server
      .put(`/api/lessons-learned/v1/lessons/${submitted.body.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(404);

    // Reject -> Archived
    const rejected = await server
      .post(`/api/lessons-learned/v1/lessons/${submitted.body.id}/reject`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version, reason: 'Out of scope for this catalog.' })
      .expect(200);

    await server
      .put(`/api/lessons-learned/v1/lessons/${rejected.body.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('LESSON_NOT_PUBLISHED'));
    await server
      .put(`/api/lessons-learned/v1/lessons/${rejected.body.id}/vote`)
      .set('X-PMO-Local-User-ID', 'local-other-contributor')
      .expect(404);

    // Missing profile -> 401; unknown profile -> 403; nonexistent lesson -> 404
    await server.put(`/api/lessons-learned/v1/lessons/${rejected.body.id}/vote`).expect(401);
    await server
      .put(`/api/lessons-learned/v1/lessons/${rejected.body.id}/vote`)
      .set('X-PMO-Local-User-ID', 'unknown-user')
      .expect(403);
    await server
      .put('/api/lessons-learned/v1/lessons/999999/vote')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(404);
  });

  it('sorts Lessons Library by most-voted (votesCount DESC, approvedAt DESC, id ASC) while preserving filters and cursor pagination', async () => {
    const server = request(app!.getHttpServer());
    const alphaOlder = await createPublishedLesson('Alpha older one vote', {
      projectId: 'LOCAL-PROJECT-001', projectName: 'Fictional Atlas Modernization', lessonType: 'Future Prevention',
    });
    const alphaTieFirst = await createPublishedLesson('Alpha tie first', {
      projectId: 'LOCAL-PROJECT-001', projectName: 'Fictional Atlas Modernization', lessonType: 'Future Prevention',
    });
    const alphaTieSecond = await createPublishedLesson('Alpha tie second', {
      projectId: 'LOCAL-PROJECT-001', projectName: 'Fictional Atlas Modernization', lessonType: 'Future Prevention',
    });
    const alphaMostVoted = await createPublishedLesson('Alpha top two votes', {
      projectId: 'LOCAL-PROJECT-001', projectName: 'Fictional Atlas Modernization', lessonType: 'Future Prevention',
    });
    const alphaZeroVotes = await createPublishedLesson('Alpha zero votes', {
      projectId: 'LOCAL-PROJECT-001', projectName: 'Fictional Atlas Modernization', lessonType: 'Future Prevention',
    });
    await createPublishedLesson('Beta excluded by filter', {
      projectId: 'LOCAL-PROJECT-002', projectName: 'Fictional Harbor Migration', lessonType: 'Risk Avoided',
    });

    // Give deterministic approved_at timestamps to verify tie-breakers:
    // alphaTieFirst & alphaTieSecond share identical approved_at and identical 1 vote -> id ASC (alphaTieFirst before alphaTieSecond)
    // alphaOlder has an earlier approved_at and 1 vote -> comes after the tied pair
    await dataSource!.query(
      'UPDATE lessons SET approved_at = $1 WHERE id = $2',
      ['2026-11-10T10:00:00.000Z', alphaOlder.id],
    );
    await dataSource!.query(
      'UPDATE lessons SET approved_at = $1 WHERE id IN ($2, $3)',
      ['2026-11-12T10:00:00.000Z', alphaTieFirst.id, alphaTieSecond.id],
    );
    await dataSource!.query(
      'UPDATE lessons SET approved_at = $1 WHERE id = $2',
      ['2026-11-09T10:00:00.000Z', alphaMostVoted.id],
    );
    await dataSource!.query(
      'UPDATE lessons SET approved_at = $1 WHERE id = $2',
      ['2026-11-15T10:00:00.000Z', alphaZeroVotes.id],
    );

    // Cast votes: alphaMostVoted = 2; alphaTieFirst = 1; alphaTieSecond = 1; alphaOlder = 1; alphaZeroVotes = 0
    await server.put(`/api/lessons-learned/v1/lessons/${alphaMostVoted.id}/vote`).set('X-PMO-Local-User-ID', 'local-contributor').expect(200);
    await server.put(`/api/lessons-learned/v1/lessons/${alphaMostVoted.id}/vote`).set('X-PMO-Local-User-ID', 'local-pmo').expect(200);
    await server.put(`/api/lessons-learned/v1/lessons/${alphaTieFirst.id}/vote`).set('X-PMO-Local-User-ID', 'local-contributor').expect(200);
    await server.put(`/api/lessons-learned/v1/lessons/${alphaTieSecond.id}/vote`).set('X-PMO-Local-User-ID', 'local-contributor').expect(200);
    await server.put(`/api/lessons-learned/v1/lessons/${alphaOlder.id}/vote`).set('X-PMO-Local-User-ID', 'local-contributor').expect(200);

    const expectedOrder = [
      alphaMostVoted.id,
      alphaTieFirst.id,
      alphaTieSecond.id,
      alphaOlder.id,
      alphaZeroVotes.id,
    ];

    // Unpaged with filters
    const unpaged = await server
      .get('/api/lessons-learned/v1/lessons/library')
      .query({ sort: 'most-voted', search: 'Alpha', projectId: 'LOCAL-PROJECT-001', lessonType: 'Future Prevention' })
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(unpaged.body.map((item: { id: number }) => item.id)).toEqual(expectedOrder);

    // Cursor pagination with limit=2 across all 3 pages
    const page1 = await server
      .get('/api/lessons-learned/v1/lessons/library')
      .query({ sort: 'most-voted', search: 'Alpha', projectId: 'LOCAL-PROJECT-001', lessonType: 'Future Prevention', paged: 'true', limit: '2' })
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(page1.body.items.map((item: { id: number }) => item.id)).toEqual(expectedOrder.slice(0, 2));
    expect(page1.body.page.nextCursor).toBeTruthy();

    const page2 = await server
      .get('/api/lessons-learned/v1/lessons/library')
      .query({
        sort: 'most-voted',
        search: 'Alpha',
        projectId: 'LOCAL-PROJECT-001',
        lessonType: 'Future Prevention',
        paged: 'true',
        limit: '2',
        cursor: page1.body.page.nextCursor,
      })
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(page2.body.items.map((item: { id: number }) => item.id)).toEqual(expectedOrder.slice(2, 4));
    expect(page2.body.page.nextCursor).toBeTruthy();

    const page3 = await server
      .get('/api/lessons-learned/v1/lessons/library')
      .query({
        sort: 'most-voted',
        search: 'Alpha',
        projectId: 'LOCAL-PROJECT-001',
        lessonType: 'Future Prevention',
        paged: 'true',
        limit: '2',
        cursor: page2.body.page.nextCursor,
      })
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(page3.body.items.map((item: { id: number }) => item.id)).toEqual(expectedOrder.slice(4, 5));
    expect(page3.body.page.nextCursor).toBeNull();
  });
});
