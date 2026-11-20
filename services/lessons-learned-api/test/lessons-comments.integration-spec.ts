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

describe('Lessons Learned comments, single-level replies, and PMO moderation', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let temporaryDirectory: string;
  let profilesPath: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-lessons-comments-'));
    profilesPath = join(temporaryDirectory, 'local-users.json');
    writeFileSync(profilesPath, JSON.stringify([
      { id: 'local-author', displayName: 'Lesson Author', role: 'LESSONS_USER' },
      { id: 'local-contributor', displayName: 'Other Contributor', role: 'LESSONS_USER' },
      { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' },
    ]), 'utf8');
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = profilesPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';

    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('lessons_learned_comments_test')
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

  async function createPrivateDraft(authorId = 'local-author', title = 'Private draft lesson') {
    const server = request(app!.getHttpServer());
    const created = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', authorId)
      .send({
        title,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'Release runbook was outdated.',
        rootCause: 'No owner reviewed the checklist.',
        lessonType: 'Future Prevention',
        impact: 'Extra manual verification.',
        recommendation: 'Assign a checklist owner.',
        applicability: 'Shared releases.',
      })
      .expect(201);
    return created.body as { id: number; version: number };
  }

  async function createPublishedLesson(authorId = 'local-author', title = 'Published lesson') {
    const server = request(app!.getHttpServer());
    const draft = await createPrivateDraft(authorId, title);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${draft.id}/submit`)
      .set('X-PMO-Local-User-ID', authorId)
      .send({
        title,
        projectCategory: 'Technology',
        projectPhase: 'Execution',
        situationObserved: 'Release runbook was outdated.',
        rootCause: 'No owner reviewed the checklist.',
        lessonType: 'Future Prevention',
        impact: 'Extra manual verification.',
        recommendation: 'Assign a checklist owner.',
        applicability: 'Shared releases.',
        version: draft.version,
      })
      .expect(200);
    const approved = await server
      .post(`/api/lessons-learned/v1/lessons/${draft.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: submitted.body.version })
      .expect(200);
    return approved.body as { id: number; version: number };
  }

  it('supports root comments and single-level replies with newest-first root pagination, chronological replies, and validation', async () => {
    const server = request(app!.getHttpServer());
    const published = await createPublishedLesson();
    const privateDraft = await createPrivateDraft();

    // Unauthorized contributor cannot read or post comments on someone else's private draft
    await server
      .get(`/api/lessons-learned/v1/lessons/${privateDraft.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(404);
    await server
      .post(`/api/lessons-learned/v1/lessons/${privateDraft.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'Unauthorized comment' })
      .expect(404);

    // Author and PMO CAN comment on a private draft
    const authorPrivateComment = await server
      .post(`/api/lessons-learned/v1/lessons/${privateDraft.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .send({ body: 'Author note on private draft' })
      .expect(201);
    expect(authorPrivateComment.body).toMatchObject({
      lessonId: privateDraft.id,
      parentCommentId: null,
      authorId: 'local-author',
      authorDisplayName: 'Lesson Author',
      body: 'Author note on private draft',
      isHidden: false,
      moderation: null,
      replies: [],
    });

    await server
      .post(`/api/lessons-learned/v1/lessons/${privateDraft.id}/comments/${authorPrivateComment.body.id}/replies`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ body: 'PMO clarification on private draft' })
      .expect(201);

    // Validation: empty/whitespace and > 2000 characters are rejected
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: '   ' })
      .expect(400);
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'a'.repeat(2001) })
      .expect(400);

    // Create 3 root comments on published lesson
    const root1 = await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'First root comment' })
      .expect(201);
    const root2 = await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .send({ body: 'Second root comment' })
      .expect(201);
    const root3 = await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ body: 'Third root comment' })
      .expect(201);

    // Add 2 replies to root2 (must appear chronologically ascending)
    const reply1 = await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${root2.body.id}/replies`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'First reply to second root' })
      .expect(201);
    const reply2 = await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${root2.body.id}/replies`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ body: 'Second reply to second root' })
      .expect(201);

    // Block 3rd-level reply (replying to a reply)
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${reply1.body.id}/replies`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .send({ body: 'Nested 3rd-level reply should fail' })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('REPLY_DEPTH_EXCEEDED'));

    // Page 1 (limit=2): newest-first root comments -> [root3, root2]
    const page1 = await server
      .get(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .query({ limit: 2 })
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(page1.body.publicCommentCount).toBe(5);
    expect(page1.body.items.map((item: { id: number }) => item.id)).toEqual([root3.body.id, root2.body.id]);
    expect(page1.body.items[1].replies.map((reply: { id: number }) => reply.id)).toEqual([reply1.body.id, reply2.body.id]);
    expect(page1.body.page.nextCursor).toBeTruthy();

    // Page 2 using nextCursor -> [root1]
    const page2 = await server
      .get(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .query({ limit: 2, cursor: page1.body.page.nextCursor })
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(page2.body.items.map((item: { id: number }) => item.id)).toEqual([root1.body.id]);
    expect(page2.body.page.nextCursor).toBeNull();

    // Public commentCount is reflected in Library and Detail
    const library = await server
      .get('/api/lessons-learned/v1/lessons/library')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(library.body).toContainEqual(expect.objectContaining({
      id: published.id,
      commentCount: 5,
    }));

    const libraryDetail = await server
      .get(`/api/lessons-learned/v1/lessons/library/${published.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(libraryDetail.body.commentCount).toBe(5);

    const privateDetail = await server
      .get(`/api/lessons-learned/v1/lessons/${privateDraft.id}`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(privateDetail.body.commentCount).toBe(2);
  });

  it('enforces D6 moderation rules: PMO-only hide & audit, neutral placeholder, omission from pagination, and public counts', async () => {
    const server = request(app!.getHttpServer());
    const published = await createPublishedLesson();

    // Create 3 root comments: rootNoReplies, rootWithReplies, rootVisible
    const rootNoReplies = await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'Root without replies' })
      .expect(201);
    const rootWithReplies = await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .send({ body: 'Root with replies' })
      .expect(201);
    const rootVisible = await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'Newest visible root' })
      .expect(201);

    const visibleReply = await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${rootWithReplies.body.id}/replies`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'Visible reply' })
      .expect(201);
    const hiddenReply = await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${rootWithReplies.body.id}/replies`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .send({ body: 'Reply to be hidden' })
      .expect(201);

    // Contributor is forbidden from hiding or auditing hidden comments
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${rootNoReplies.body.id}/hide`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ reason: 'Contributor cannot hide' })
      .expect(403);
    await server
      .get(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .query({ includeHidden: 'true' })
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(403);

    // PMO must provide a non-empty reason
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${rootNoReplies.body.id}/hide`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ reason: '   ' })
      .expect(400);

    // PMO hides: rootNoReplies, hiddenReply, and rootWithReplies
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${rootNoReplies.body.id}/hide`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ reason: 'Off-topic standalone comment' })
      .expect(200);
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${hiddenReply.body.id}/hide`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ reason: 'Contains sensitive client name' })
      .expect(200);
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${rootWithReplies.body.id}/hide`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ reason: 'Contains outdated policy link' })
      .expect(200);

    // Hiding an already-hidden comment returns 409
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${rootNoReplies.body.id}/hide`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ reason: 'Duplicate hide' })
      .expect(409);

    // Replying to a hidden parent is blocked
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${rootWithReplies.body.id}/replies`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'Reply to hidden parent' })
      .expect(409);

    // Regular view (limit=2):
    // - rootVisible (visible)
    // - rootWithReplies (hidden parent WITH visible reply -> neutral placeholder)
    // - rootNoReplies (hidden parent WITHOUT visible replies -> omitted from view & pagination, so nextCursor is null!)
    // - publicCommentCount = 2 (rootVisible + visibleReply)
    const regularPage = await server
      .get(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .query({ limit: 2 })
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(regularPage.body.publicCommentCount).toBe(2);
    expect(regularPage.body.page.nextCursor).toBeNull();
    expect(regularPage.body.items).toHaveLength(2);
    expect(regularPage.body.items[0]).toMatchObject({
      id: rootVisible.body.id,
      body: 'Newest visible root',
      isHidden: false,
    });
    expect(regularPage.body.items[1]).toMatchObject({
      id: rootWithReplies.body.id,
      authorId: null,
      authorDisplayName: null,
      body: null,
      isHidden: true,
      moderation: null,
    });
    expect(regularPage.body.items[1].replies).toHaveLength(1);
    expect(regularPage.body.items[1].replies[0]).toMatchObject({
      id: visibleReply.body.id,
      body: 'Visible reply',
      isHidden: false,
    });

    // Library and Detail public commentCount both exclude hidden items (= 2)
    const library = await server
      .get('/api/lessons-learned/v1/lessons/library')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(library.body).toContainEqual(expect.objectContaining({
      id: published.id,
      commentCount: 2,
    }));
    const detail = await server
      .get(`/api/lessons-learned/v1/lessons/library/${published.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(detail.body.commentCount).toBe(2);

    // PMO audit view (includeHidden=true) reveals ALL hidden items with original body, reason, moderator, and timestamp
    const auditPage = await server
      .get(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .query({ includeHidden: 'true', limit: 10 })
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(auditPage.body.publicCommentCount).toBe(2);
    expect(auditPage.body.items.map((item: { id: number }) => item.id)).toEqual([
      rootVisible.body.id,
      rootWithReplies.body.id,
      rootNoReplies.body.id,
    ]);
    expect(auditPage.body.items[1]).toMatchObject({
      id: rootWithReplies.body.id,
      authorId: 'local-author',
      authorDisplayName: 'Lesson Author',
      body: 'Root with replies',
      isHidden: true,
      moderation: {
        hiddenByUserId: 'local-pmo',
        hiddenByDisplayName: 'Local PMO',
        reason: 'Contains outdated policy link',
      },
    });
    expect(auditPage.body.items[1].moderation.hiddenAt).toBeTruthy();
    expect(auditPage.body.items[1].replies).toHaveLength(2);
    expect(auditPage.body.items[1].replies[1]).toMatchObject({
      id: hiddenReply.body.id,
      body: 'Reply to be hidden',
      isHidden: true,
      moderation: {
        hiddenByUserId: 'local-pmo',
        hiddenByDisplayName: 'Local PMO',
        reason: 'Contains sensitive client name',
      },
    });

    // When the last visible reply under rootWithReplies is hidden, rootWithReplies disappears from regular view too
    await server
      .post(`/api/lessons-learned/v1/lessons/${published.id}/comments/${visibleReply.body.id}/hide`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ reason: 'Also outdated' })
      .expect(200);

    const regularAfterAllHidden = await server
      .get(`/api/lessons-learned/v1/lessons/${published.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(regularAfterAllHidden.body.page.limit).toBe(50);
    expect(regularAfterAllHidden.body.publicCommentCount).toBe(1);
    expect(regularAfterAllHidden.body.items.map((item: { id: number }) => item.id)).toEqual([rootVisible.body.id]);
  });
});
