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
import { LessonNotificationStore } from '../src/lessons/lesson-notification-store';

describe('Lessons Learned internal notifications (D8)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;
  let temporaryDirectory: string;
  let profilesPath: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-lessons-notifications-'));
    profilesPath = join(temporaryDirectory, 'local-users.json');
    writeFileSync(profilesPath, JSON.stringify([
      { id: 'local-author', displayName: 'Lesson Author', role: 'LESSONS_USER' },
      { id: 'local-contributor', displayName: 'Other Contributor', role: 'LESSONS_USER' },
      { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' },
    ]), 'utf8');
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = profilesPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';

    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('lessons_learned_notifications_test')
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
    vi.restoreAllMocks();
    await dataSource?.query('TRUNCATE lesson_notifications, lesson_comments, lesson_history, lessons RESTART IDENTITY CASCADE');
  });

  async function createSubmittedLesson(authorId = 'local-author', title = 'Notification test lesson') {
    const server = request(app!.getHttpServer());
    const payload = {
      title,
      projectCategory: 'Technology',
      projectPhase: 'Execution',
      situationObserved: 'Deployment alerts were missed during rollout.',
      rootCause: 'Alert routing lacked owner assignment.',
      lessonType: 'Future Prevention',
      impact: 'Delayed incident triage.',
      recommendation: 'Assign an explicit alert recipient.',
      applicability: 'All delivery squads.',
    };
    const draft = await server
      .post('/api/lessons-learned/v1/lessons')
      .set('X-PMO-Local-User-ID', authorId)
      .send(payload)
      .expect(201);
    const submitted = await server
      .post(`/api/lessons-learned/v1/lessons/${draft.body.id}/submit`)
      .set('X-PMO-Local-User-ID', authorId)
      .send({ ...payload, version: draft.body.version })
      .expect(200);
    return submitted.body as { id: number; version: number; title: string };
  }

  it('generates notifications for all 5 events, suppresses self-notifications, and deduplicates in Postgres', async () => {
    const server = request(app!.getHttpServer());

    // 1. LESSON_RETURNED -> lesson author
    const returnedLesson = await createSubmittedLesson('local-author', 'Returned rollout lesson');
    await server
      .post(`/api/lessons-learned/v1/lessons/${returnedLesson.id}/return`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: returnedLesson.version, guidance: 'Clarify the mitigation steps.' })
      .expect(200);

    // 2. LESSON_APPROVED -> lesson author
    const approvedLesson = await createSubmittedLesson('local-author', 'Approved rollout lesson');
    await server
      .post(`/api/lessons-learned/v1/lessons/${approvedLesson.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: approvedLesson.version })
      .expect(200);

    // 3. LESSON_REJECTED -> lesson author
    const rejectedLesson = await createSubmittedLesson('local-author', 'Rejected rollout lesson');
    await server
      .post(`/api/lessons-learned/v1/lessons/${rejectedLesson.id}/reject`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: rejectedLesson.version, reason: 'Out of scope for the library.' })
      .expect(200);

    // 4. COMMENT_ADDED -> lesson author (and self-comment by author must be suppressed)
    const commentRes = await server
      .post(`/api/lessons-learned/v1/lessons/${approvedLesson.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'Helpful lesson for our next release.' })
      .expect(201);
    const contributorCommentId = commentRes.body.id as number;

    await server
      .post(`/api/lessons-learned/v1/lessons/${approvedLesson.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .send({ body: 'Author self comment should not notify author.' })
      .expect(201);

    // 5. REPLY_ADDED -> parent comment author (and self-reply must be suppressed)
    await server
      .post(`/api/lessons-learned/v1/lessons/${approvedLesson.id}/comments/${contributorCommentId}/replies`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .send({ body: 'Thanks for the feedback!' })
      .expect(201);

    await server
      .post(`/api/lessons-learned/v1/lessons/${approvedLesson.id}/comments/${contributorCommentId}/replies`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'Self reply should not notify contributor.' })
      .expect(201);

    // Also verify PMO approving their own submitted lesson suppresses self-notification
    const pmoOwnLesson = await createSubmittedLesson('local-pmo', 'PMO self-approved lesson');
    await server
      .post(`/api/lessons-learned/v1/lessons/${pmoOwnLesson.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: pmoOwnLesson.version })
      .expect(200);

    const authorNotifications = await server
      .get('/api/lessons-learned/v1/notifications')
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);

    expect(authorNotifications.body.unreadCount).toBe(4);
    expect(authorNotifications.body.items.map((item: { eventType: string }) => item.eventType)).toEqual([
      'COMMENT_ADDED',
      'LESSON_REJECTED',
      'LESSON_APPROVED',
      'LESSON_RETURNED',
    ]);
    expect(authorNotifications.body.items[0]).toMatchObject({
      eventType: 'COMMENT_ADDED',
      actorUserId: 'local-contributor',
      actorDisplayName: 'Other Contributor',
      lessonId: approvedLesson.id,
      lessonTitle: 'Approved rollout lesson',
      isRead: false,
      readAt: null,
    });

    const contributorNotifications = await server
      .get('/api/lessons-learned/v1/notifications')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);

    expect(contributorNotifications.body.unreadCount).toBe(1);
    expect(contributorNotifications.body.items[0]).toMatchObject({
      eventType: 'REPLY_ADDED',
      actorUserId: 'local-author',
      actorDisplayName: 'Lesson Author',
      lessonId: approvedLesson.id,
      lessonTitle: 'Approved rollout lesson',
      isRead: false,
    });

    const pmoNotifications = await server
      .get('/api/lessons-learned/v1/notifications')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(pmoNotifications.body.unreadCount).toBe(0);
    expect(pmoNotifications.body.items).toEqual([]);

    // Verify DB unique constraint deduplication via LessonNotificationStore
    const store = app!.get(LessonNotificationStore);
    await store.insertNotification({
      recipientUserId: 'local-contributor',
      actorUserId: 'local-author',
      actorDisplayName: 'Lesson Author',
      eventType: 'REPLY_ADDED',
      lessonId: approvedLesson.id,
      lessonTitleSnapshot: 'Approved rollout lesson',
      summary: 'Duplicate attempt',
      sourceEventKey: `comment:${contributorCommentId + 2}`,
    });
    const afterDuplicate = await server
      .get('/api/lessons-learned/v1/notifications')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(afterDuplicate.body.unreadCount).toBe(1);
    expect(afterDuplicate.body.items).toHaveLength(1);
  });

  it('isolates notification persistence failures so all 5 primary actions still succeed and commit (D8)', async () => {
    const server = request(app!.getHttpServer());
    const store = app!.get(LessonNotificationStore);
    const failSpy = vi.spyOn(store, 'insertNotification').mockRejectedValue(
      new Error('Simulated notification storage outage'),
    );

    // 1. Return
    const toReturn = await createSubmittedLesson('local-author', 'Return despite notification outage');
    const returnedRes = await server
      .post(`/api/lessons-learned/v1/lessons/${toReturn.id}/return`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: toReturn.version, guidance: 'Add deployment metrics.' })
      .expect(200);
    expect(returnedRes.body.status).toBe('Open');

    // 2. Approve
    const toApprove = await createSubmittedLesson('local-author', 'Approve despite notification outage');
    const approvedRes = await server
      .post(`/api/lessons-learned/v1/lessons/${toApprove.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: toApprove.version })
      .expect(200);
    expect(approvedRes.body.status).toBe('Approved');

    // 3. Reject
    const toReject = await createSubmittedLesson('local-author', 'Reject despite notification outage');
    const rejectedRes = await server
      .post(`/api/lessons-learned/v1/lessons/${toReject.id}/reject`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: toReject.version, reason: 'Duplicate initiative.' })
      .expect(200);
    expect(rejectedRes.body.status).toBe('Archived');

    // 4. Comment
    const commentRes = await server
      .post(`/api/lessons-learned/v1/lessons/${toApprove.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .send({ body: 'Comment persists even when notification insert fails.' })
      .expect(201);
    expect(commentRes.body.body).toBe('Comment persists even when notification insert fails.');

    // 5. Reply
    const replyRes = await server
      .post(`/api/lessons-learned/v1/lessons/${toApprove.id}/comments/${commentRes.body.id}/replies`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .send({ body: 'Reply persists even when notification insert fails.' })
      .expect(201);
    expect(replyRes.body.body).toBe('Reply persists even when notification insert fails.');

    expect(failSpy).toHaveBeenCalledTimes(5);

    // Verify all 5 primary actions remained committed in PostgreSQL
    const checkReturned = await server
      .get(`/api/lessons-learned/v1/lessons/${toReturn.id}`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(checkReturned.body.status).toBe('Open');

    const checkApproved = await server
      .get(`/api/lessons-learned/v1/lessons/${toApprove.id}`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(checkApproved.body.status).toBe('Approved');

    const checkRejected = await server
      .get(`/api/lessons-learned/v1/lessons/${toReject.id}`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(checkRejected.body.status).toBe('Archived');

    const comments = await server
      .get(`/api/lessons-learned/v1/lessons/${toApprove.id}/comments`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(comments.body.publicCommentCount).toBe(2);
    expect(comments.body.items[0].replies).toHaveLength(1);

    // No notifications were persisted during the simulated outage
    const authorNotifications = await server
      .get('/api/lessons-learned/v1/notifications')
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(authorNotifications.body.items).toEqual([]);
    expect(authorNotifications.body.unreadCount).toBe(0);
  });

  it('supports newest-first Load more pagination, single read, loaded-only batch read, and strict recipient isolation', async () => {
    const server = request(app!.getHttpServer());

    const l1 = await createSubmittedLesson('local-author', 'Lesson One');
    await server
      .post(`/api/lessons-learned/v1/lessons/${l1.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: l1.version })
      .expect(200);

    const l2 = await createSubmittedLesson('local-author', 'Lesson Two');
    await server
      .post(`/api/lessons-learned/v1/lessons/${l2.id}/approve`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: l2.version })
      .expect(200);

    const l3 = await createSubmittedLesson('local-author', 'Lesson Three');
    await server
      .post(`/api/lessons-learned/v1/lessons/${l3.id}/return`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .send({ version: l3.version, guidance: 'Refine impact section.' })
      .expect(200);

    // Default page limit follows API conventions (50) when omitted
    const defaultPage = await server
      .get('/api/lessons-learned/v1/notifications')
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(defaultPage.body.page.limit).toBe(50);

    // Page 1 (limit=2): newest-first
    const page1 = await server
      .get('/api/lessons-learned/v1/notifications?limit=2')
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(page1.body.unreadCount).toBe(3);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items.map((item: { lessonTitle: string }) => item.lessonTitle)).toEqual([
      'Lesson Three',
      'Lesson Two',
    ]);
    expect(page1.body.page.nextCursor).toBeTruthy();

    const loadedIds = page1.body.items.map((item: { id: number }) => item.id) as number[];

    // Strict recipient isolation: another user cannot read/mark author's notifications
    await server
      .post(`/api/lessons-learned/v1/notifications/${loadedIds[0]}/read`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .set('Accept', 'application/problem+json')
      .expect(403);

    await server
      .post('/api/lessons-learned/v1/notifications/read-batch')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .set('Accept', 'application/problem+json')
      .send({ notificationIds: loadedIds })
      .expect(403);

    await server
      .post('/api/lessons-learned/v1/notifications/99999/read')
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(404);

    // Mark ONLY loaded IDs from page 1 as read
    const batchRes = await server
      .post('/api/lessons-learned/v1/notifications/read-batch')
      .set('X-PMO-Local-User-ID', 'local-author')
      .send({ notificationIds: loadedIds })
      .expect(200);
    expect(batchRes.body.updatedIds).toHaveLength(2);
    expect(batchRes.body.unreadCount).toBe(1);

    // Page 2 (unloaded item) is still unread!
    const page2 = await server
      .get(`/api/lessons-learned/v1/notifications?limit=2&cursor=${encodeURIComponent(page1.body.page.nextCursor)}`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].lessonTitle).toBe('Lesson One');
    expect(page2.body.items[0].isRead).toBe(false);
    expect(page2.body.page.nextCursor).toBeNull();
    expect(page2.body.unreadCount).toBe(1);

    // Mark single notification as read (and verify idempotency)
    const singleRead = await server
      .post(`/api/lessons-learned/v1/notifications/${page2.body.items[0].id}/read`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(singleRead.body.notification.isRead).toBe(true);
    expect(singleRead.body.notification.readAt).toBeTruthy();
    expect(singleRead.body.unreadCount).toBe(0);

    const repeatRead = await server
      .post(`/api/lessons-learned/v1/notifications/${page2.body.items[0].id}/read`)
      .set('X-PMO-Local-User-ID', 'local-author')
      .expect(200);
    expect(repeatRead.body.notification.readAt).toBe(singleRead.body.notification.readAt);
    expect(repeatRead.body.unreadCount).toBe(0);
  });
});
