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

describe('Rankings API (Most Voted Lessons, Top Contributors, and Profile Ranking Position)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let temporaryDirectory: string;
  let profilesPath: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-rankings-'));
    profilesPath = join(temporaryDirectory, 'local-users.json');
    writeFileSync(profilesPath, JSON.stringify([
      { id: 'user-ana', displayName: 'Ana Costa', role: 'LESSONS_USER' },
      { id: 'user-bruno', displayName: 'Bruno Lima', role: 'LESSONS_USER' },
      { id: 'user-carla', displayName: 'Carla Dias', role: 'LESSONS_USER' },
      { id: 'user-diego', displayName: 'Diego Alves', role: 'LESSONS_USER' },
      { id: 'user-zero', displayName: 'Zoe Zero', role: 'LESSONS_USER' },
      { id: 'local-pmo', displayName: 'Clara PMO', role: 'LESSONS_MODERATOR' },
    ]), 'utf8');
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = profilesPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';

    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('lessons_learned_rankings_test')
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

  async function createPublishedLesson(
    authorId: string,
    title: string,
    options: { close?: boolean; approvedAt?: string } = {},
  ) {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', authorId)
      .send({
        title,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'Observed situation during rollout.',
        rootCause: 'Checklist lacked clear ownership.',
        lessonType: 'Future Prevention',
        impact: 'Extra rework during deployment.',
        recommendation: 'Assign a checklist owner.',
        applicability: 'All production releases.',
      })
      .expect(201);

    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/submit`)
      .set('X-PMO-Local-User-ID', authorId)
      .send({ ...created.body, version: created.body.version })
      .expect(200);

    let result = (await server
      .post(`/api/lessons-learned/v1/lessons/${created.body.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version })
      .expect(200)).body;

    if (options.close) {
      result = (await server
        .post(`/api/lessons-learned/v1/lessons/${created.body.id}/close`)
        .set('X-PMO-Local-User-ID', 'local-pmo')
        .send({ version: result.version })
        .expect(200)).body;
    }

    if (options.approvedAt) {
      await dataSource!.query(
        'UPDATE lessons SET approved_at = $1 WHERE id = $2',
        [options.approvedAt, result.id],
      );
    }

    return result;
  }

  async function voteForLesson(lessonId: number, voterId: string) {
    await request(app!.getHttpServer())
      .put(`/api/lessons-learned/v1/lessons/${lessonId}/vote`)
      .set('X-PMO-Local-User-ID', voterId)
      .expect(200);
  }

  it('rejects unauthenticated and unauthorized access and returns empty rankings when nothing is eligible', async () => {
    const server = request(app!.getHttpServer());

    await server.get('/api/lessons-learned/v1/rankings').expect(401);
    await server
      .get('/api/lessons-learned/v1/rankings')
      .set('X-PMO-Local-User-ID', 'unauthorized-user')
      .expect(403);

    // Unpublished Open draft does not qualify for either ranking
    await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'user-ana')
      .send({ title: 'Unpublished draft' })
      .expect(201);

    const empty = await server
      .get('/api/lessons-learned/v1/rankings')
      .set('X-PMO-Local-User-ID', 'user-ana')
      .expect(200);

    expect(empty.body).toEqual({
      mostVotedLessons: [],
      topContributors: [],
    });
  });

  it('ranks top 3 Most Voted Lessons using published lessons with >= 1 vote and D5 tie-breakers (votesCount DESC, approvedAt DESC, id ASC)', async () => {
    const server = request(app!.getHttpServer());

    // Published lesson with 0 votes -> must be excluded from Most Voted Lessons
    await createPublishedLesson('user-ana', 'Zero votes lesson', { approvedAt: '2026-10-10T10:00:00.000Z' });

    // 4 voted lessons (including Closed) to verify top 3 limit and exact tie-breakers:
    // L2: 2 votes, approved 2026-10-05T10:00:00Z, lower id -> ties on votes & approvedAt with L3
    // L3: 2 votes, approved 2026-10-05T10:00:00Z, higher id -> loses to L2 by id ASC
    // L4: 2 votes, approved 2026-10-06T10:00:00Z (newer approvedAt, Closed) -> beats L2 & L3 by approvedAt DESC
    // L5: 3 votes, approved 2026-10-01T10:00:00Z -> #1 by votesCount DESC
    const l2 = await createPublishedLesson('user-ana', 'Tie older id', { approvedAt: '2026-10-05T10:00:00.000Z' });
    const l3 = await createPublishedLesson('user-bruno', 'Tie higher id', { approvedAt: '2026-10-05T10:00:00.000Z' });
    const l4 = await createPublishedLesson('user-carla', 'Closed newer approved', {
      close: true,
      approvedAt: '2026-10-06T10:00:00.000Z',
    });
    const l5 = await createPublishedLesson('user-diego', 'Most voted overall', { approvedAt: '2026-10-01T10:00:00.000Z' });

    await voteForLesson(l2.id, 'user-ana');
    await voteForLesson(l2.id, 'user-bruno');

    await voteForLesson(l3.id, 'user-ana');
    await voteForLesson(l3.id, 'user-bruno');

    await voteForLesson(l4.id, 'user-ana');
    await voteForLesson(l4.id, 'user-bruno');

    await voteForLesson(l5.id, 'user-ana');
    await voteForLesson(l5.id, 'user-bruno');
    await voteForLesson(l5.id, 'user-carla');

    const response = await server
      .get('/api/lessons-learned/v1/rankings')
      .set('X-PMO-Local-User-ID', 'user-zero')
      .expect(200);

    expect(response.body.mostVotedLessons).toHaveLength(3);
    expect(response.body.mostVotedLessons.map((item: { position: number; id: number; votesCount: number; status: string }) => ({
      position: item.position,
      id: item.id,
      votesCount: item.votesCount,
      status: item.status,
    }))).toEqual([
      { position: 1, id: l5.id, votesCount: 3, status: 'Approved' },
      { position: 2, id: l4.id, votesCount: 2, status: 'Closed' },
      { position: 3, id: l2.id, votesCount: 2, status: 'Approved' },
    ]);
    expect(response.body.mostVotedLessons[0]).toMatchObject({
      title: 'Most voted overall',
      authorId: 'user-diego',
      authorName: 'Diego Alves',
    });
  });

  it('ranks top 3 Contributors by publishedLessonsCount DESC, latestApprovedAt DESC, displayName ASC, excludes unauthorized/0-published users, and populates profile rankingPosition', async () => {
    const server = request(app!.getHttpServer());

    // user-diego: 2 published lessons (1 Approved, 1 Closed), latestApprovedAt = 2026-10-02 -> #1 (most published)
    await createPublishedLesson('user-diego', 'Diego lesson 1', { approvedAt: '2026-10-01T10:00:00.000Z' });
    await createPublishedLesson('user-diego', 'Diego lesson 2', { close: true, approvedAt: '2026-10-02T10:00:00.000Z' });

    // user-carla: 1 published lesson, approvedAt = 2026-10-08 -> #2 (newer latestApprovedAt than Ana & Bruno)
    await createPublishedLesson('user-carla', 'Carla lesson 1', { approvedAt: '2026-10-08T10:00:00.000Z' });

    // user-bruno and user-ana: both have 1 published lesson at exact same approvedAt = 2026-10-05
    // Tie-breaker displayName ASC -> Ana Costa (#3) beats Bruno Lima (#4)
    await createPublishedLesson('user-bruno', 'Bruno lesson 1', { approvedAt: '2026-10-05T10:00:00.000Z' });
    await createPublishedLesson('user-ana', 'Ana lesson 1', { approvedAt: '2026-10-05T10:00:00.000Z' });

    // user-zero: only has an unpublished Open draft -> must be excluded (rankingPosition = null)
    await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', 'user-zero')
      .send({ title: 'Zoe unpublished draft' })
      .expect(201);

    // Insert a published lesson authored by a user NOT in local-users.json -> must be excluded from Top Contributors
    await dataSource!.query(`
      INSERT INTO lessons (title, author_id, updated_by, status, version, approved_at)
      VALUES ('Removed author lesson', 'former-user', 'former-user', 'Approved', 1, '2026-10-20T10:00:00.000Z')
    `);

    const rankings = await server
      .get('/api/lessons-learned/v1/rankings')
      .set('X-PMO-Local-User-ID', 'user-ana')
      .expect(200);

    expect(rankings.body.topContributors).toHaveLength(3);
    expect(rankings.body.topContributors.map((item: {
      position: number;
      id: string;
      displayName: string;
      publishedLessonsCount: number;
    }) => ({
      position: item.position,
      id: item.id,
      displayName: item.displayName,
      publishedLessonsCount: item.publishedLessonsCount,
    }))).toEqual([
      { position: 1, id: 'user-diego', displayName: 'Diego Alves', publishedLessonsCount: 2 },
      { position: 2, id: 'user-carla', displayName: 'Carla Dias', publishedLessonsCount: 1 },
      { position: 3, id: 'user-ana', displayName: 'Ana Costa', publishedLessonsCount: 1 },
    ]);

    // Contributor Profile rankingPosition uses the exact same deterministic order (including #4 and null for 0 published)
    const diegoProfile = await server
      .get('/api/lessons-learned/v1/profiles/user-diego')
      .set('X-PMO-Local-User-ID', 'user-ana')
      .expect(200);
    expect(diegoProfile.body.rankingPosition).toBe(1);

    const anaProfile = await server
      .get('/api/lessons-learned/v1/profiles/user-ana')
      .set('X-PMO-Local-User-ID', 'user-ana')
      .expect(200);
    expect(anaProfile.body.rankingPosition).toBe(3);

    const brunoProfile = await server
      .get('/api/lessons-learned/v1/profiles/user-bruno')
      .set('X-PMO-Local-User-ID', 'user-ana')
      .expect(200);
    expect(brunoProfile.body.rankingPosition).toBe(4);

    const zeroProfile = await server
      .get('/api/lessons-learned/v1/profiles/user-zero')
      .set('X-PMO-Local-User-ID', 'user-ana')
      .expect(200);
    expect(zeroProfile.body.rankingPosition).toBeNull();
  });

  it('returns only eligible positions when fewer than 3 items qualify', async () => {
    const server = request(app!.getHttpServer());

    const lesson = await createPublishedLesson('user-ana', 'Single voted lesson', {
      approvedAt: '2026-10-05T10:00:00.000Z',
    });
    await voteForLesson(lesson.id, 'local-pmo');

    const response = await server
      .get('/api/lessons-learned/v1/rankings')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);

    expect(response.body.mostVotedLessons).toHaveLength(1);
    expect(response.body.mostVotedLessons[0].position).toBe(1);
    expect(response.body.topContributors).toHaveLength(1);
    expect(response.body.topContributors[0]).toMatchObject({
      position: 1,
      id: 'user-ana',
      publishedLessonsCount: 1,
      votesReceivedCount: 1,
    });
  });
});
