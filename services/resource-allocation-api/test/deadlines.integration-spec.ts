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
import { ResourceAllocationDeadlineWorker } from '../src/deadlines/resource-allocation-deadline.worker';

describe('Tech Resource Allocation request deadlines (#67)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_deadlines_test')
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
      localUserId: 'deadline-admin', displayName: 'Deadline Admin', email: 'admin@example.test',
      role: ResourceAllocationRole.Admin, active: true, coveredGroupIds: [], groupId: null,
    }));
    const requester = await people.save(people.create({
      localUserId: 'deadline-owner', displayName: 'Deadline Owner', email: 'owner@example.test',
      role: ResourceAllocationRole.User, active: true, coveredGroupIds: [], groupId: null,
    }));
    const other = await people.save(people.create({
      localUserId: 'deadline-other', displayName: 'Other Requester', email: 'other@example.test',
      role: ResourceAllocationRole.User, active: true, coveredGroupIds: [], groupId: null,
    }));
    const group = await dataSource!.getRepository(ResourceGroup).save({
      name: 'Engineering', active: true, supervisorId: admin.id, managerId: admin.id,
    });
    const profile = await dataSource!.getRepository(ResourceProfile).save({
      name: 'Developer', active: true, groupId: group.id,
    });
    const initiative = await dataSource!.getRepository(ResourceInitiative).save({
      code: 'ITDM-067', name: 'Waiting requests', active: true,
    });
    return { admin, requester, other, group, profile, initiative };
  }

  function futureDate(daysFromToday: number): string {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const [year, month, day] = today.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + daysFromToday)).toISOString().slice(0, 10);
  }

  async function createRequest(fixture: Awaited<ReturnType<typeof setup>>) {
    const accepted = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({
        initiativeId: fixture.initiative.id,
        category: 'EXECUTION_PROJECT',
        lines: [{
          attemptKey: randomUUID(), groupId: fixture.group.id, resourceProfileId: fixture.profile.id,
          startDate: futureDate(3), endDate: futureDate(30), weeklyHours: 12,
        }],
      })
      .expect(202);
    await app!.get(ResourceAllocationSubmissionWorker).processBatch(1);
    const lines = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${accepted.body.id}/lines`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    return { id: lines.body.items[0].requestId as string, submissionId: accepted.body.id as string };
  }

  it('sends one 7-day reminder to the requester and current presentation Admins after 168 hours', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture);
    await dataSource!.query(`
      UPDATE resource_requests
      SET received_at = clock_timestamp() - INTERVAL '7 days',
          stage_entered_at = clock_timestamp() - INTERVAL '7 days',
          expiration_due_at = clock_timestamp() + INTERVAL '14 days'
      WHERE id = $1
    `, [created.id]);

    const processed = await app!.get(ResourceAllocationDeadlineWorker).processBatch();
    await app!.get(ResourceAllocationDeadlineWorker).processBatch();
    const reminders = await dataSource!.query(`
      SELECT recipient_id, event_code
      FROM resource_allocation_notifications
      WHERE source_request_id = $1 AND event_code = 'REQUEST_WAITING_REMINDER_7D'
      ORDER BY recipient_id
    `, [created.id]);

    expect(processed).toBe(1);
    expect(reminders).toEqual([
      { recipient_id: fixture.requester.id, event_code: 'REQUEST_WAITING_REMINDER_7D' },
      { recipient_id: fixture.admin.id, event_code: 'REQUEST_WAITING_REMINDER_7D' },
    ].sort((left, right) => left.recipient_id.localeCompare(right.recipient_id)));
  });

  it('sends the 14-day reminder after an edit without resetting the original receipt clock', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture);
    await dataSource!.query(`
      UPDATE resource_requests
      SET received_at = clock_timestamp() - INTERVAL '14 days',
          stage_entered_at = clock_timestamp() - INTERVAL '14 days',
          expiration_due_at = clock_timestamp() + INTERVAL '7 days'
      WHERE id = $1
    `, [created.id]);
    const original = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);

    const edited = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/requests/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .send({ comment: 'Edited after two weeks.' })
      .expect(200);
    expect(edited.body.receivedAt).toBe(original.body.receivedAt);
    expect(await app!.get(ResourceAllocationDeadlineWorker).processBatch()).toBe(1);

    const reminders = await dataSource!.query(`
      SELECT event_code, recipient_id
      FROM resource_allocation_notifications
      WHERE source_request_id = $1 AND event_code IN ('REQUEST_WAITING_REMINDER_7D', 'REQUEST_WAITING_REMINDER_14D')
      ORDER BY event_code, recipient_id
    `, [created.id]);
    expect(reminders).toHaveLength(4);
    expect(reminders.map((notice: { event_code: string }) => notice.event_code)).toEqual([
      'REQUEST_WAITING_REMINDER_14D', 'REQUEST_WAITING_REMINDER_14D',
      'REQUEST_WAITING_REMINDER_7D', 'REQUEST_WAITING_REMINDER_7D',
    ]);
  });

  it('expires only past-deadline Waiting requests and suppresses obsolete reminders during recovery', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture);
    await dataSource!.query(`
      UPDATE resource_requests
      SET received_at = clock_timestamp() - INTERVAL '22 days',
          stage_entered_at = clock_timestamp() - INTERVAL '22 days',
          expiration_due_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = $1
    `, [created.id]);

    const worker = app!.get(ResourceAllocationDeadlineWorker);
    expect(await worker.processBatch()).toBe(1);
    expect(await worker.processBatch()).toBe(0);

    const operationalList = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/requests')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(operationalList.body.items).toHaveLength(0);
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(404);

    const ownAudit = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/request-audits/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(ownAudit.body.events).toMatchObject([{
      action: 'EXPIRED',
      reason: 'Automatically expired after more than 21 days waiting for presentation.',
      requestSnapshot: { requestedConditions: { initiativeCode: 'ITDM-067' } },
    }]);
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/request-audits/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.other.localUserId)
      .expect(404);
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/request-audits/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);

    const lineResult = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${created.submissionId}/lines`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(lineResult.body.items[0]).toMatchObject({
      status: 'SUCCEEDED',
      requestId: created.id,
      requestOutcome: { status: 'REMOVED', action: 'EXPIRED' },
    });

    const notifications = await dataSource!.query(`
      SELECT event_code, recipient_id
      FROM resource_allocation_notifications
      WHERE source_request_id = $1
      ORDER BY event_code, recipient_id
    `, [created.id]);
    expect(notifications.filter((notice: { event_code: string }) => notice.event_code.startsWith('REQUEST_WAITING_REMINDER_'))).toHaveLength(0);
    expect(notifications.filter((notice: { event_code: string }) => notice.event_code === 'REQUEST_EXPIRED')).toHaveLength(2);
    expect(await dataSource!.query('SELECT action FROM resource_request_history WHERE request_id = $1 ORDER BY occurred_at, id', [created.id]))
      .toEqual([{ action: 'SUBMITTED' }, { action: 'EXPIRED' }]);
  });

  it('keeps a Waiting request operational until its expiration deadline has passed', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture);
    await dataSource!.query(`
      UPDATE resource_requests
      SET received_at = clock_timestamp() - INTERVAL '21 days' + INTERVAL '1 second',
          stage_entered_at = clock_timestamp() - INTERVAL '21 days' + INTERVAL '1 second',
          expiration_due_at = clock_timestamp() + INTERVAL '1 second'
      WHERE id = $1
    `, [created.id]);

    expect(await app!.get(ResourceAllocationDeadlineWorker).processBatch()).toBe(1);
    const stillWaiting = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(stillWaiting.body.decisionState).toBe('WAITING_FOR_PRESENTATION');
    expect(await dataSource!.query('SELECT action FROM resource_request_audits WHERE request_id = $1', [created.id])).toHaveLength(0);
    expect(await dataSource!.query("SELECT event_code FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code = 'REQUEST_EXPIRED'", [created.id])).toHaveLength(0);
  });

  it('does not expire a request that has left Waiting, even after the old deadline passes', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture);
    await dataSource!.query(`
      UPDATE resource_requests
      SET decision_state = 'PENDING_TEAM_DECISION',
          received_at = clock_timestamp() - INTERVAL '22 days',
          expiration_due_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = $1
    `, [created.id]);

    expect(await app!.get(ResourceAllocationDeadlineWorker).processBatch()).toBe(0);
    expect(await dataSource!.query('SELECT decision_state, removed_at FROM resource_requests WHERE id = $1', [created.id]))
      .toEqual([{ decision_state: 'PENDING_TEAM_DECISION', removed_at: null }]);
    expect(await dataSource!.query('SELECT action FROM resource_request_audits WHERE request_id = $1', [created.id])).toHaveLength(0);
  });

  it('serializes expiry with a simultaneous presentation action and records one final outcome', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture);
    await dataSource!.query(`
      UPDATE resource_requests
      SET received_at = clock_timestamp() - INTERVAL '22 days',
          stage_entered_at = clock_timestamp() - INTERVAL '22 days',
          expiration_due_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = $1
    `, [created.id]);
    const action = request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${created.id}/referrals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect((response) => expect([404, 422]).toContain(response.status));

    const [processed] = await Promise.all([
      app!.get(ResourceAllocationDeadlineWorker).processBatch(),
      action,
    ]);
    const recovered = await app!.get(ResourceAllocationDeadlineWorker).processBatch();
    expect(processed + recovered).toBe(1);
    expect(await dataSource!.query('SELECT decision_state, removed_at FROM resource_requests WHERE id = $1', [created.id]))
      .toEqual([{ decision_state: 'WAITING_FOR_PRESENTATION', removed_at: expect.any(Date) }]);
    expect(await dataSource!.query('SELECT action FROM resource_request_history WHERE request_id = $1 ORDER BY occurred_at, id', [created.id]))
      .toEqual([{ action: 'SUBMITTED' }, { action: 'EXPIRED' }]);
    expect(await dataSource!.query('SELECT action FROM resource_request_audits WHERE request_id = $1', [created.id]))
      .toEqual([{ action: 'EXPIRED' }]);
    expect(await dataSource!.query("SELECT event_code FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code = 'REQUEST_EXPIRED'", [created.id]))
      .toHaveLength(2);
  });

  it('rolls back expiration audit, history, notice, and outcome together when a notice fails', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture);
    await dataSource!.query(`
      UPDATE resource_requests
      SET received_at = clock_timestamp() - INTERVAL '22 days',
          stage_entered_at = clock_timestamp() - INTERVAL '22 days',
          expiration_due_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = $1
    `, [created.id]);
    await dataSource!.query(`
      CREATE FUNCTION fail_expiration_notice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_code = 'REQUEST_EXPIRED' THEN RAISE EXCEPTION 'test expiration notice failure' USING ERRCODE = 'P0001'; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await dataSource!.query(`
      CREATE TRIGGER fail_expiration_notice_before_insert
      BEFORE INSERT ON resource_allocation_notifications
      FOR EACH ROW EXECUTE FUNCTION fail_expiration_notice()
    `);

    try {
      await expect(app!.get(ResourceAllocationDeadlineWorker).processBatch()).rejects.toThrow();
      expect(await dataSource!.query('SELECT removed_at FROM resource_requests WHERE id = $1', [created.id]))
        .toEqual([{ removed_at: null }]);
      expect(await dataSource!.query('SELECT action FROM resource_request_audits WHERE request_id = $1', [created.id])).toHaveLength(0);
      expect(await dataSource!.query('SELECT action FROM resource_request_history WHERE request_id = $1 ORDER BY occurred_at, id', [created.id]))
        .toEqual([{ action: 'SUBMITTED' }]);
      expect((await dataSource!.query('SELECT request_outcome FROM resource_submission_lines WHERE request_id = $1', [created.id]))[0].request_outcome)
        .toMatchObject({ decisionState: 'WAITING_FOR_PRESENTATION' });
    } finally {
      await dataSource!.query('DROP TRIGGER fail_expiration_notice_before_insert ON resource_allocation_notifications');
      await dataSource!.query('DROP FUNCTION fail_expiration_notice()');
    }

    expect(await app!.get(ResourceAllocationDeadlineWorker).processBatch()).toBe(1);
    expect(await dataSource!.query('SELECT action FROM resource_request_audits WHERE request_id = $1', [created.id]))
      .toEqual([{ action: 'EXPIRED' }]);
    expect((await dataSource!.query('SELECT request_outcome FROM resource_submission_lines WHERE request_id = $1', [created.id]))[0].request_outcome)
      .toMatchObject({ status: 'REMOVED', action: 'EXPIRED' });
  });
});
