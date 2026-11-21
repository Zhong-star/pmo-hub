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

describe('Tech Resource Allocation submissions (#60)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_submissions_test')
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
      localUserId: 'allocation-admin', displayName: 'Admin One', email: 'admin@example.test',
      role: ResourceAllocationRole.Admin, active: true, coveredGroupIds: [], groupId: null,
    }));
    const requester = await people.save(people.create({
      localUserId: 'allocation-requester', displayName: 'Requester One', email: 'requester@example.test',
      role: ResourceAllocationRole.User, active: true, coveredGroupIds: [], groupId: null,
    }));
    const groupRepo = dataSource!.getRepository(ResourceGroup);
    const group = await groupRepo.save(groupRepo.create({
      name: 'Engineering', active: true, supervisorId: admin.id, managerId: admin.id,
    }));
    const profileRepo = dataSource!.getRepository(ResourceProfile);
    const profile = await profileRepo.save(profileRepo.create({ name: 'Developer', active: true, groupId: group.id }));
    const initiativeRepo = dataSource!.getRepository(ResourceInitiative);
    const initiative = await initiativeRepo.save(initiativeRepo.create({ code: 'ITDM-060', name: 'Batch allocation', active: true }));
    return { admin, requester, group, profile, initiative };
  }

  function futureDate(daysFromToday: number): string {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const [year, month, day] = today.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + daysFromToday));
    return date.toISOString().slice(0, 10);
  }

  function bodyFor(fixture: Awaited<ReturnType<typeof setup>>, weeklyHours: number) {
    return {
      initiativeId: fixture.initiative.id,
      category: 'EXECUTION_PROJECT',
      lines: [{
        attemptKey: randomUUID(),
        groupId: fixture.group.id,
        resourceProfileId: fixture.profile.id,
        startDate: futureDate(2),
        endDate: futureDate(14),
        weeklyHours,
        comment: 'Deliver the approved scope.',
      }],
    };
  }

  it('durably receives a batch, recovers its row, and creates the request with history and notices atomically', async () => {
    const fixture = await setup();
    const payload = bodyFor(fixture, 1.25);
    const submissionPath = '/api/resource-allocation/v1/submissions';
    const received = await request(app!.getHttpServer())
      .post(submissionPath)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(202);

    expect(received.headers.location).toBe(`/api/resource-allocation/v1/submissions/${received.body.id}`);
    expect(received.body).toMatchObject({ lineCount: 1, counts: { received: 1, processing: 0, succeeded: 0, failed: 0 } });

    const detailBeforeProcessing = await request(app!.getHttpServer())
      .get(`${submissionPath}/${received.body.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(detailBeforeProcessing.body).toEqual(received.body);
    expect(detailBeforeProcessing.body).not.toHaveProperty('attemptKey');
    const listBeforeProcessing = await request(app!.getHttpServer())
      .get(submissionPath)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(listBeforeProcessing.body.items).toEqual([received.body]);
    await request(app!.getHttpServer())
      .get(`${submissionPath}/${received.body.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(404);

    const worker = app!.get(ResourceAllocationSubmissionWorker);
    const processed = await worker.processBatch();
    const workerRows = await dataSource!.query('SELECT status, claim_token, claimed_at FROM resource_submission_lines WHERE submission_id = $1', [received.body.id]);
    expect({ processed, workerRows }).toMatchObject({ processed: 1, workerRows: [{ status: 'SUCCEEDED', claim_token: null }] });
    expect(await worker.processBatch()).toBe(0);

    const rows = await request(app!.getHttpServer())
      .get(`${submissionPath}/${received.body.id}/lines`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(rows.body.items).toHaveLength(1);
    expect(rows.body.items[0]).toMatchObject({
      attemptKey: payload.lines[0].attemptKey,
      status: 'SUCCEEDED',
      submittedConditions: { weeklyHours: 1.25, initiativeId: fixture.initiative.id, category: payload.category },
      requestOutcome: { requestedConditions: { weeklyHours: 1.3 } },
    });
    expect(rows.body.items[0].requestId).toEqual(expect.any(String));

    const replay = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${payload.lines[0].attemptKey}?operation=submission.create`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(replay.body).toMatchObject({
      id: rows.body.items[0].id,
      attemptKey: payload.lines[0].attemptKey,
      submittedConditions: expect.objectContaining({ weeklyHours: 1.25 }),
      status: 'SUCCEEDED',
      requestId: rows.body.items[0].requestId,
      receivedAt: expect.any(String),
    });

    const requests = await dataSource!.query('SELECT id, requested_conditions, decision_state FROM resource_requests');
    const history = await dataSource!.query('SELECT request_id, action FROM resource_request_history');
    const notifications = await dataSource!.query('SELECT recipient_id, event_code FROM resource_allocation_notifications');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ decision_state: 'WAITING_FOR_PRESENTATION' });
    expect(requests[0].requested_conditions.weeklyHours).toBe(1.3);
    expect(history).toEqual([{ request_id: rows.body.items[0].requestId, action: 'SUBMITTED' }]);
    expect(notifications).toEqual([{ recipient_id: fixture.admin.id, event_code: 'REQUEST_SUBMITTED' }]);

    const usedCode = await dataSource!.query('SELECT code_used FROM resource_initiatives WHERE id = $1', [fixture.initiative.id]);
    expect(usedCode[0].code_used).toBe(true);

    const renamed = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/initiatives/${fixture.initiative.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"2"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Renamed ITDM' })
      .expect(200);
    expect(renamed.body.name).toBe('Renamed ITDM');
    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/initiatives/${fixture.initiative.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"3"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ code: 'ITDM-CHANGED' })
      .expect(422);
    const snapshot = await dataSource!.query('SELECT requested_conditions FROM resource_requests');
    expect(snapshot[0].requested_conditions).toMatchObject({ initiativeCode: 'ITDM-060', initiativeName: 'Batch allocation' });
  });

  it('rounds 1.25 to 1.3, accepts 40, and keeps 0.04 and 40.04 as individual failures', async () => {
    const fixture = await setup();
    const payload = bodyFor(fixture, 0.04);
    payload.lines.push({ ...payload.lines[0], attemptKey: randomUUID(), weeklyHours: 40.04 });
    payload.lines.push({ ...payload.lines[0], attemptKey: randomUUID(), weeklyHours: 1.25 });
    payload.lines.push({ ...payload.lines[0], attemptKey: randomUUID(), weeklyHours: 40 });
    payload.lines.push({ ...payload.lines[0], attemptKey: randomUUID(), weeklyHours: 20, startDate: futureDate(2), endDate: futureDate(2) });
    const accepted = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(202);
    expect(await app!.get(ResourceAllocationSubmissionWorker).processBatch(5)).toBe(5);

    const lines = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${accepted.body.id}/lines`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(lines.body.items.map((line: { status: string }) => line.status).sort()).toEqual(['FAILED', 'FAILED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    expect(lines.body.items.filter((line: { status: string }) => line.status === 'FAILED').map((line: { problem: { code: string } }) => line.problem.code))
      .toEqual(['INVALID_WEEKLY_HOURS', 'INVALID_WEEKLY_HOURS']);
    expect(lines.body.items.filter((line: { status: string }) => line.status === 'SUCCEEDED')
      .map((line: { requestOutcome: { requestedConditions: { weeklyHours: number } } }) => line.requestOutcome.requestedConditions.weeklyHours).sort())
      .toEqual([1.3, 20, 40]);
    expect(await dataSource!.query('SELECT id FROM resource_requests')).toHaveLength(3);
  });

  it('recovers the same accepted submission for identical retries and conflicts on changed content', async () => {
    const fixture = await setup();
    const payload = bodyFor(fixture, 20);
    const key = randomUUID();
    const path = '/api/resource-allocation/v1/submissions';
    const first = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(202);
    expect(await app!.get(ResourceAllocationSubmissionWorker).processBatch(1)).toBe(1);
    const replay = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', key)
      .send(payload)
      .expect('Idempotency-Replayed', 'true')
      .expect(202);
    expect(replay.body).toEqual(first.body);

    const sameAttemptWithNewEnvelopeKey = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(202);
    expect(sameAttemptWithNewEnvelopeKey.body).toMatchObject({ lineCount: 1, counts: { succeeded: 1, received: 0 } });
    const originalResult = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${first.body.id}/lines`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    const recoveredResult = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${sameAttemptWithNewEnvelopeKey.body.id}/lines`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(recoveredResult.body.items[0].id).toBe(originalResult.body.items[0].id);
    expect(recoveredResult.body.items[0].receivedAt).toBe(originalResult.body.items[0].receivedAt);

    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', key)
      .send({ ...payload, lines: [{ ...payload.lines[0], weeklyHours: 21 }] })
      .expect(409);

    const mixed = {
      ...payload,
      lines: [payload.lines[0], { ...payload.lines[0], attemptKey: randomUUID(), weeklyHours: 10 }],
    };
    const mixedEnvelope = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send(mixed)
      .expect(202);
    expect(mixedEnvelope.body).toMatchObject({ lineCount: 2, counts: { succeeded: 1, received: 1 } });
    const mixedLines = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${mixedEnvelope.body.id}/lines`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(mixedLines.body.items[0].id).toBe(originalResult.body.items[0].id);
    expect(await dataSource!.query('SELECT id FROM resource_requests')).toHaveLength(1);
    expect(await dataSource!.query('SELECT id FROM resource_submissions')).toHaveLength(3);
  });

  it('rejects envelopes containing more than one hundred lines before accepting any work', async () => {
    const fixture = await setup();
    const payload = bodyFor(fixture, 20);
    const lines = Array.from({ length: 101 }, () => ({ ...payload.lines[0], attemptKey: randomUUID() }));
    const response = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ ...payload, lines })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.errors).toEqual(expect.arrayContaining([
      { path: 'lines', code: 'ARRAY_MAX_SIZE', message: expect.any(String) },
    ]));
    expect(await dataSource!.query('SELECT id FROM resource_submissions')).toHaveLength(0);

    const invalidLine = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ ...payload, lines: [{ ...payload.lines[0], comment: 'C'.repeat(2001) }] })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(invalidLine.body.code).toBe('VALIDATION_ERROR');
    expect(invalidLine.body.errors).toEqual([
      { path: 'lines.0.comment', code: 'MAX_LENGTH', message: expect.any(String) },
    ]);
    expect(await dataSource!.query('SELECT id FROM resource_submissions')).toHaveLength(0);
  });

  it('revalidates dates at processing and fails a line received more than 21 days earlier', async () => {
    const fixture = await setup();
    const payload = bodyFor(fixture, 20);
    payload.lines[0].startDate = futureDate(-1);
    payload.lines.push({ ...payload.lines[0], attemptKey: randomUUID(), startDate: futureDate(2) });
    const accepted = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(202);
    await dataSource!.query(`
      UPDATE resource_submission_lines
      SET received_at = clock_timestamp() - INTERVAL '22 days'
      WHERE id = (
        SELECT line_id FROM resource_submission_entries
        WHERE submission_id = $1 AND line_number = 1
      )
    `, [accepted.body.id]);

    expect(await app!.get(ResourceAllocationSubmissionWorker).processBatch(2)).toBe(2);
    const results = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${accepted.body.id}/lines`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(results.body.items.map((line: { problem: { code: string } }) => line.problem.code))
      .toEqual(['INVALID_BUSINESS_DATE', 'SUBMISSION_EXPIRED']);
    expect(await dataSource!.query('SELECT id FROM resource_requests')).toHaveLength(0);
    expect(await dataSource!.query('SELECT id FROM resource_request_history')).toHaveLength(0);
    expect(await dataSource!.query('SELECT id FROM resource_allocation_notifications')).toHaveLength(0);
    expect((await dataSource!.query('SELECT code_used FROM resource_initiatives WHERE id = $1', [fixture.initiative.id]))[0].code_used).toBe(false);
  });

  it('lets concurrent workers resolve submissions from two Admin requesters without deadlocking or duplicating effects', async () => {
    const fixture = await setup();
    const people = dataSource!.getRepository(ResourcePerson);
    const secondAdmin = await people.save(people.create({
      localUserId: 'second-admin', displayName: 'Admin Two', email: 'admin-two@example.test',
      role: ResourceAllocationRole.Admin, active: true, coveredGroupIds: [], groupId: null,
    }));
    const firstPayload = bodyFor(fixture, 15);
    const secondPayload = bodyFor(fixture, 20);
    const path = '/api/resource-allocation/v1/submissions';
    const first = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send(firstPayload)
      .expect(202);
    const second = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', secondAdmin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send(secondPayload)
      .expect(202);

    const firstWorker = app!.get(ResourceAllocationSubmissionWorker);
    const secondWorker = new ResourceAllocationSubmissionWorker(dataSource!);
    const result = await Promise.all([firstWorker.processBatch(1), secondWorker.processBatch(1)]);
    expect(result).toEqual([1, 1]);

    const statuses = await dataSource!.query("SELECT status FROM resource_submission_lines ORDER BY attempt_key");
    expect(statuses).toEqual([{ status: 'SUCCEEDED' }, { status: 'SUCCEEDED' }]);
    expect(await dataSource!.query('SELECT id FROM resource_requests')).toHaveLength(2);
    const notices = await dataSource!.query('SELECT recipient_id, source_request_id FROM resource_allocation_notifications');
    expect(notices).toHaveLength(2);
    expect(notices.some((notice: { recipient_id: string }) => notice.recipient_id === fixture.admin.id)).toBe(true);
    expect(notices.some((notice: { recipient_id: string }) => notice.recipient_id === secondAdmin.id)).toBe(true);
    expect(first.body.id).not.toBe(second.body.id);
  });

  it('rolls back request, ITDM use, history, and notices together after a notification write fails, then recovers the claim', async () => {
    const fixture = await setup();
    const payload = bodyFor(fixture, 20);
    const received = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(202);
    await dataSource!.query(`
      CREATE FUNCTION fail_submission_notice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test notification failure' USING ERRCODE = 'P0001'; END;
      $$
    `);
    await dataSource!.query(`
      CREATE TRIGGER fail_submission_notice_before_insert
      BEFORE INSERT ON resource_allocation_notifications
      FOR EACH ROW EXECUTE FUNCTION fail_submission_notice()
    `);

    try {
      await expect(app!.get(ResourceAllocationSubmissionWorker).processBatch(1)).rejects.toThrow();
      expect(await dataSource!.query('SELECT id FROM resource_requests')).toHaveLength(0);
      expect(await dataSource!.query('SELECT id FROM resource_request_history')).toHaveLength(0);
      expect(await dataSource!.query('SELECT id FROM resource_allocation_notifications')).toHaveLength(0);
      expect((await dataSource!.query('SELECT code_used FROM resource_initiatives WHERE id = $1', [fixture.initiative.id]))[0].code_used).toBe(false);
      expect((await dataSource!.query('SELECT status FROM resource_submission_lines'))[0].status).toBe('PROCESSING');
    } finally {
      await dataSource!.query('DROP TRIGGER fail_submission_notice_before_insert ON resource_allocation_notifications');
      await dataSource!.query('DROP FUNCTION fail_submission_notice()');
    }

    await dataSource!.query("UPDATE resource_submission_lines SET claimed_at = clock_timestamp() - INTERVAL '2 minutes'");
    expect(await app!.get(ResourceAllocationSubmissionWorker).processBatch(1)).toBe(1);
    const recovered = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${received.body.id}/lines`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(recovered.body.items[0].status).toBe('SUCCEEDED');
    expect(await dataSource!.query('SELECT id FROM resource_requests')).toHaveLength(1);
    expect(await dataSource!.query('SELECT id FROM resource_request_history')).toHaveLength(1);
    expect(await dataSource!.query('SELECT id FROM resource_allocation_notifications')).toHaveLength(1);
  });
});
