import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { RESOURCE_ALLOCATION_DATA_SOURCE } from '../src/database/database.module';
import { ResourceAllocationRole } from '../src/people/resource-allocation-role';
import { ResourcePerson } from '../src/people/resource-person.entity';
import { ResourceGroup } from '../src/groups/resource-group.entity';
import { ResourceProfile } from '../src/resource-profiles/resource-profile.entity';
import { ResourceInitiative } from '../src/initiatives/resource-initiative.entity';
import { ResourceAllocationSubmissionWorker } from '../src/submissions/resource-allocation-submission.worker';

describe('Tech Resource Allocation notifications (#70)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_notifications_test')
      .withUsername('resource_allocation_test')
      .withPassword('test_only_password')
      .start();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(container.getConnectionUri())],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    dataSource = app.get<DataSource>(RESOURCE_ALLOCATION_DATA_SOURCE);
    await dataSource.runMigrations();
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await container?.stop();
    }
  }, 120_000);

  beforeEach(async () => {
    await dataSource?.query('TRUNCATE TABLE resource_people, resource_initiatives RESTART IDENTITY CASCADE');
  });

  async function setup() {
    const people = dataSource!.getRepository(ResourcePerson);
    const admin = await people.save(people.create({
      localUserId: 'notifications-admin', displayName: 'Admin One', email: 'admin@example.test',
      role: ResourceAllocationRole.Admin, active: true, coveredGroupIds: [], groupId: null,
    }));
    const requester = await people.save(people.create({
      localUserId: 'notifications-requester', displayName: 'Requester One', email: 'requester@example.test',
      role: ResourceAllocationRole.User, active: true, coveredGroupIds: [], groupId: null,
    }));
    const outsider = await people.save(people.create({
      localUserId: 'notifications-outsider', displayName: 'Outsider', email: 'outsider@example.test',
      role: ResourceAllocationRole.User, active: true, coveredGroupIds: [], groupId: null,
    }));
    const groupRepo = dataSource!.getRepository(ResourceGroup);
    const group = await groupRepo.save(groupRepo.create({
      name: 'Engineering', active: true, supervisorId: admin.id, managerId: admin.id,
    }));
    const profileRepo = dataSource!.getRepository(ResourceProfile);
    const profile = await profileRepo.save(profileRepo.create({ name: 'Developer', active: true, groupId: group.id }));
    const initiativeRepo = dataSource!.getRepository(ResourceInitiative);
    const initiative = await initiativeRepo.save(initiativeRepo.create({ code: 'ITDM-070', name: 'Inbox allocation', active: true }));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const [year, month, day] = today.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, month - 1, day + 2)).toISOString().slice(0, 10);
    const endDate = new Date(Date.UTC(year, month - 1, day + 9)).toISOString().slice(0, 10);
    await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({
        initiativeId: initiative.id,
        category: 'EXECUTION_PROJECT',
        lines: [{
          attemptKey: randomUUID(), groupId: group.id, resourceProfileId: profile.id,
          startDate, endDate, weeklyHours: 8,
        }],
      })
      .expect(202);
    await app!.get(ResourceAllocationSubmissionWorker).processBatch(1);
    const [{ id: requestId }] = await dataSource!.query('SELECT id FROM resource_requests');
    await dataSource!.query('DELETE FROM resource_allocation_notifications');
    return { admin, requester, outsider, requestId: String(requestId) };
  }

  async function insertNotices(
    recipientId: string,
    requestId: string,
    count: number,
    titlePrefix = 'Notice',
    eventPrefix = 'TEST_EVENT',
  ) {
    const values = Array.from({ length: count }, (_, index) => {
      const valueIndex = index * 6;
      return `($${valueIndex + 1}::uuid, $${valueIndex + 2}::uuid, $${valueIndex + 3}, $${valueIndex + 4}, $${valueIndex + 5}, clock_timestamp() - ($${valueIndex + 6}::int * interval '1 second'))`;
    });
    const parameters = Array.from({ length: count }, (_, index) => [
      recipientId,
      requestId,
      `${eventPrefix}_${index}`,
      `${titlePrefix} ${index}`,
      `Message ${index}`,
      index,
    ]).flat();
    await dataSource!.query(`
      INSERT INTO resource_allocation_notifications
        (recipient_id, source_request_id, event_code, title, message, created_at)
      VALUES ${values.join(', ')}
    `, parameters);
  }

  it('lists only the recipient’s notices with stable cursor pages and a read filter', async () => {
    const fixture = await setup();
    await insertNotices(fixture.admin.id, fixture.requestId, 105);
    await insertNotices(fixture.requester.id, fixture.requestId, 1, 'Private');

    const path = '/api/resource-allocation/v1/notifications';
    const firstPage = await request(app!.getHttpServer())
      .get(`${path}?read=false&limit=100`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);

    expect(firstPage.body.items).toHaveLength(100);
    expect(firstPage.body.items[0].title).toBe('Notice 0');
    expect(firstPage.body.items.every((item: { readAt: string | null }) => item.readAt === null)).toBe(true);
    expect(firstPage.body.page).toMatchObject({ limit: 100, nextCursor: expect.any(String) });
    expect(firstPage.body.items.map((item: { title: string }) => item.title)).not.toContain('Private 0');

    const secondPage = await request(app!.getHttpServer())
      .get(path)
      .query({ read: false, limit: 100, cursor: firstPage.body.page.nextCursor })
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(secondPage.body.items).toHaveLength(5);
    expect(secondPage.body.items[0].id).not.toBe(firstPage.body.items.at(-1).id);
    expect(secondPage.body.page.nextCursor).toBeNull();

    await request(app!.getHttpServer())
      .get(path)
      .query({ read: true, limit: 100, cursor: firstPage.body.page.nextCursor })
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(400);

    const requesterInbox = await request(app!.getHttpServer())
      .get(`${path}?read=false`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(requesterInbox.body.items.map((item: { title: string }) => item.title)).toEqual(['Private 0']);
  });

  it('marks only the recipient’s notification as read without changing its request or deadline', async () => {
    const fixture = await setup();
    await insertNotices(fixture.admin.id, fixture.requestId, 1);
    const [{ id: notificationId }] = await dataSource!.query(
      'SELECT id FROM resource_allocation_notifications WHERE recipient_id = $1', [fixture.admin.id],
    );
    const requestBefore = await dataSource!.query(
      'SELECT decision_state, expiration_due_at, version FROM resource_requests WHERE id = $1', [fixture.requestId],
    );
    const path = `/api/resource-allocation/v1/notifications/${notificationId}/readings`;
    const listed = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications?read=false')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    const etag = listed.body.items[0].etag as string;
    const idempotencyKey = randomUUID();
    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .expect(400);
    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', etag)
      .expect(400);
    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"000000000000000000000000"')
      .set('Idempotency-Key', randomUUID())
      .expect(412);
    const firstRead = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', etag)
      .set('Idempotency-Key', idempotencyKey)
      .expect(200);

    expect(firstRead.body).toMatchObject({
      id: notificationId,
      title: 'Notice 0',
      target: { available: true, destination: 'PRESENTATION_QUEUE' },
    });
    expect(firstRead.body.readAt).toEqual(expect.any(String));
    expect(firstRead.headers.etag).toMatch(/^"[a-f0-9]{24}"$/);
    expect(firstRead.body.etag).toBe(firstRead.headers.etag);

    const repeatedRead = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', etag)
      .set('Idempotency-Key', idempotencyKey)
      .expect(200);
    expect(repeatedRead.body.readAt).toBe(firstRead.body.readAt);
    expect(repeatedRead.headers.etag).toBe(firstRead.headers.etag);

    const readNotices = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications?read=true')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(readNotices.body.items.map((item: { id: string }) => item.id)).toEqual([notificationId]);
    const unreadNotices = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications?read=false')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(unreadNotices.body.items).toHaveLength(0);

    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.outsider.localUserId)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .expect(404);
    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .expect(412);
    const requestAfter = await dataSource!.query(
      'SELECT decision_state, expiration_due_at, version FROM resource_requests WHERE id = $1', [fixture.requestId],
    );
    expect(requestAfter).toEqual(requestBefore);
  });

  it('keeps removed or out-of-scope targets unavailable without exposing request content', async () => {
    const fixture = await setup();
    await insertNotices(fixture.outsider.id, fixture.requestId, 1, 'Out of scope');
    const outsideScope = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications')
      .set('X-PMO-Local-User-ID', fixture.outsider.localUserId)
      .expect(200);
    expect(outsideScope.body.items[0]).toMatchObject({
      title: 'Out of scope 0',
      target: { requestId: fixture.requestId, available: false, destination: null },
    });
    expect(JSON.stringify(outsideScope.body)).not.toContain('requesterSnapshot');
    expect(JSON.stringify(outsideScope.body)).not.toContain('requestedConditions');

    await insertNotices(fixture.admin.id, fixture.requestId, 1);
    await dataSource!.query('UPDATE resource_requests SET removed_at = clock_timestamp() WHERE id = $1', [fixture.requestId]);
    const removedTarget = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(removedTarget.body.items[0]).toMatchObject({
      title: 'Notice 0',
      target: { requestId: fixture.requestId, available: false, destination: null },
    });
  });

  it('keeps an owner’s own notification target available after they move outside its team scope', async () => {
    const fixture = await setup();
    const otherGroup = await dataSource!.getRepository(ResourceGroup).save({
      name: 'Different group', active: true, supervisorId: fixture.admin.id, managerId: fixture.admin.id,
    });
    await dataSource!.query(
      'UPDATE resource_people SET role = $1, group_id = $2 WHERE id = $3',
      [ResourceAllocationRole.Moderator, otherGroup.id, fixture.requester.id],
    );
    await insertNotices(fixture.requester.id, fixture.requestId, 1, 'Own request');

    const inbox = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(inbox.body.items[0]).toMatchObject({
      title: 'Own request 0',
      target: { requestId: fixture.requestId, available: true, destination: 'REQUEST_DETAIL' },
    });
  });

  it('marks the whole inbox beyond the first page and leaves a notice inserted during the update unread', async () => {
    const fixture = await setup();
    await insertNotices(fixture.admin.id, fixture.requestId, 125);
    await dataSource!.query(`
      CREATE FUNCTION pause_first_notification_read() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('pmo.notification_read_test_pause', true) IS NULL THEN
          PERFORM set_config('pmo.notification_read_test_pause', 'yes', true);
          PERFORM pg_sleep(1);
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await dataSource!.query(`
      CREATE TRIGGER pause_first_notification_read
      BEFORE UPDATE OF read_at ON resource_allocation_notifications
      FOR EACH ROW WHEN (OLD.read_at IS DISTINCT FROM NEW.read_at)
      EXECUTE FUNCTION pause_first_notification_read()
    `);
    const pendingWriter = dataSource!.createQueryRunner();
    await pendingWriter.connect();
    await pendingWriter.startTransaction();
    const [{ created_at: pendingCreatedAt }] = await pendingWriter.query(`
      INSERT INTO resource_allocation_notifications
        (recipient_id, source_request_id, event_code, title, message, created_at)
      VALUES ($1, $2, 'UNCOMMITTED_BEFORE_CUTOFF', 'Uncommitted notice', 'Pending notice', clock_timestamp() - interval '1 second')
      RETURNING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    `, [fixture.admin.id, fixture.requestId]) as Array<{ created_at: string }>;

    try {
      const idempotencyKey = randomUUID();
      const markAllPromise = request(app!.getHttpServer())
        .post('/api/resource-allocation/v1/notification-readings')
        .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
        .set('Idempotency-Key', idempotencyKey)
        .then((response) => response);
      let updateIsPaused = false;
      for (let attempt = 0; attempt < 100 && !updateIsPaused; attempt += 1) {
        const sessions = await dataSource!.query(`
          SELECT wait_event FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND query LIKE '%WITH cutoff AS MATERIALIZED%'
        `) as Array<{ wait_event: string | null }>;
        updateIsPaused = sessions.some(({ wait_event }) => wait_event === 'PgSleep');
        if (!updateIsPaused) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(updateIsPaused).toBe(true);
      await pendingWriter.commitTransaction();
      await insertNotices(fixture.admin.id, fixture.requestId, 1, 'Concurrent', 'CONCURRENT_EVENT');

      const marked = await markAllPromise;
      expect(marked.status).toBe(200);
      expect(marked.body).toMatchObject({ markedCount: 125 });
      expect(marked.body.cutoffAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(Date.parse(pendingCreatedAt)).toBeLessThan(Date.parse(marked.body.cutoffAt));
      await insertNotices(fixture.admin.id, fixture.requestId, 1, 'Later', 'LATER_EVENT');
      const replay = await request(app!.getHttpServer())
        .post('/api/resource-allocation/v1/notification-readings')
        .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
        .set('Idempotency-Key', idempotencyKey)
        .expect(200);
      expect(replay.body).toEqual(marked.body);
      const states = await dataSource!.query(`
        SELECT COUNT(*) FILTER (WHERE read_at IS NOT NULL)::int AS read_count,
               COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread_count
        FROM resource_allocation_notifications WHERE recipient_id = $1
      `, [fixture.admin.id]);
      expect(states).toEqual([{ read_count: 125, unread_count: 3 }]);
      const unreadTitles = await dataSource!.query(`
        SELECT title FROM resource_allocation_notifications
        WHERE recipient_id = $1 AND read_at IS NULL ORDER BY title
      `, [fixture.admin.id]) as Array<{ title: string }>;
      expect(unreadTitles.map(({ title }) => title)).toEqual([
        'Concurrent 0',
        'Later 0',
        'Uncommitted notice',
      ]);
    } finally {
      if (pendingWriter.isTransactionActive) await pendingWriter.rollbackTransaction();
      await pendingWriter.release();
      await dataSource!.query('DROP TRIGGER IF EXISTS pause_first_notification_read ON resource_allocation_notifications');
      await dataSource!.query('DROP FUNCTION IF EXISTS pause_first_notification_read()');
    }
  });
});
