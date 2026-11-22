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

  it('recovers administrative and submission envelope operation receipts by attemptKey with actor isolation, current authorization, and no ETag', async () => {
    const fixture = await setup();
    const people = dataSource!.getRepository(ResourcePerson);
    const secondAdmin = await people.save(people.create({
      localUserId: 'second-op-admin', displayName: 'Second Admin', email: 'second-op-admin@example.test',
      role: ResourceAllocationRole.Admin, active: true, coveredGroupIds: [], groupId: null,
    }));

    const initiativeKey = randomUUID();
    const createdInitiative = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/initiatives')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('Idempotency-Key', initiativeKey)
      .send({ code: 'ITDM-OP-1', name: 'Operation Receipt Initiative' })
      .expect(201);

    // Update initiative so its live version advances to 2; operation-results must NOT emit stale ETag "1".
    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/initiatives/${createdInitiative.body.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Renamed Receipt Initiative' })
      .expect(200);

    const recoveredInitiative = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${initiativeKey}?operation=admin.createInitiative`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(recoveredInitiative.headers.etag).toBeUndefined();
    expect(recoveredInitiative.body).toEqual(createdInitiative.body);

    const personKey = randomUUID();
    const createdPerson = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/people')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('Idempotency-Key', personKey)
      .send({
        localUserId: 'op-created-person',
        displayName: 'Op Created Person',
        email: 'op-created@example.test',
        role: ResourceAllocationRole.User,
        groupId: fixture.group.id,
      })
      .expect(201);
    const recoveredPerson = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${personKey}?operation=admin.createPerson`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(recoveredPerson.headers.etag).toBeUndefined();
    expect(recoveredPerson.body).toEqual(createdPerson.body);

    const groupKey = randomUUID();
    const createdGroup = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/groups')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('Idempotency-Key', groupKey)
      .send({ name: 'Receipt Group', active: false })
      .expect(201);
    const recoveredGroup = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${groupKey}?operation=admin.createGroup`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(recoveredGroup.headers.etag).toBeUndefined();
    expect(recoveredGroup.body).toEqual(createdGroup.body);

    const profileKey = randomUUID();
    const createdProfile = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/resource-profiles')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('Idempotency-Key', profileKey)
      .send({ name: 'Receipt Profile', groupId: fixture.group.id })
      .expect(201);
    const recoveredProfile = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${profileKey}?operation=admin.createResourceProfile`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(recoveredProfile.headers.etag).toBeUndefined();
    expect(recoveredProfile.body).toEqual(createdProfile.body);

    // Submission envelope idempotency key is also recoverable under submission.create.
    const submissionEnvelopeKey = randomUUID();
    const submissionPayload = bodyFor(fixture, 12);
    const acceptedSubmission = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', submissionEnvelopeKey)
      .send(submissionPayload)
      .expect(202);
    const recoveredEnvelope = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${submissionEnvelopeKey}?operation=submission.create`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(recoveredEnvelope.headers.etag).toBeUndefined();
    expect(recoveredEnvelope.body).toEqual(acceptedSubmission.body);

    // Actor isolation: another user or another Admin gets 404 (cannot inspect another actor's attemptKey).
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${initiativeKey}?operation=admin.createInitiative`)
      .set('X-PMO-Local-User-ID', secondAdmin.localUserId)
      .expect(404);
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${initiativeKey}?operation=admin.createInitiative`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(404);

    // Unauthenticated & invalid operation checks.
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${initiativeKey}?operation=admin.createInitiative`)
      .expect('WWW-Authenticate', /LocalProfile/)
      .expect(401);
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${initiativeKey}?operation=unsupported.op`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(400);
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${initiativeKey}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(400);

    // Current authorization constraint: demoted Admin loses access to admin.* receipt (403).
    await people.update(fixture.admin.id, { role: ResourceAllocationRole.User });
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${initiativeKey}?operation=admin.createInitiative`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(403);

    // Deactivated actor loses access (403).
    await people.update(fixture.requester.id, { active: false });
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${submissionEnvelopeKey}?operation=submission.create`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(403);
  });

  it('recovers request, decision, allocation, and notification operation receipts with current scope checks and zero re-execution', async () => {
    const fixture = await setup();
    const people = dataSource!.getRepository(ResourcePerson);
    const groups = dataSource!.getRepository(ResourceGroup);
    const secondGroup = await groups.save(groups.create({
      name: 'Secondary Group', active: true, supervisorId: fixture.admin.id, managerId: fixture.admin.id,
    }));
    const moderator = await people.save(people.create({
      localUserId: 'op-moderator', displayName: 'Op Moderator', email: 'op-mod@example.test',
      role: ResourceAllocationRole.Moderator, active: true, coveredGroupIds: [], groupId: fixture.group.id,
    }));
    const supervisor = await people.save(people.create({
      localUserId: 'op-supervisor', displayName: 'Op Supervisor', email: 'op-sup@example.test',
      role: ResourceAllocationRole.Supervisor, active: true, coveredGroupIds: [fixture.group.id], groupId: null,
    }));
    await groups.update(fixture.group.id, { supervisorId: supervisor.id });

    const submitAndProcess = async (requester: ResourcePerson, startOffset = 0, endOffset = 14) => {
      const sub = await request(app!.getHttpServer())
        .post('/api/resource-allocation/v1/submissions')
        .set('X-PMO-Local-User-ID', requester.localUserId)
        .set('Idempotency-Key', randomUUID())
        .send({
          initiativeId: fixture.initiative.id,
          category: 'EXECUTION_PROJECT',
          lines: [{
            attemptKey: randomUUID(),
            groupId: fixture.group.id,
            resourceProfileId: fixture.profile.id,
            startDate: futureDate(startOffset),
            endDate: futureDate(endOffset),
            weeklyHours: 20,
          }],
        })
        .expect(202);
      expect(await app!.get(ResourceAllocationSubmissionWorker).processBatch(1)).toBe(1);
      const lines = await request(app!.getHttpServer())
        .get(`/api/resource-allocation/v1/submissions/${sub.body.id}/lines`)
        .set('X-PMO-Local-User-ID', requester.localUserId)
        .expect(200);
      return lines.body.items[0].requestId as string;
    };

    const assertReceipt = async (actor: ResourcePerson, key: string, operation: string, expectedBody: unknown) => {
      const res = await request(app!.getHttpServer())
        .get(`/api/resource-allocation/v1/operation-results/${key}?operation=${encodeURIComponent(operation)}`)
        .set('X-PMO-Local-User-ID', actor.localUserId)
        .expect(200);
      expect(res.headers.etag).toBeUndefined();
      expect(res.body).toEqual(expectedBody);
    };

    // 1. withdraw
    const withdrawReqId = await submitAndProcess(fixture.requester);
    const withdrawKey = randomUUID();
    const withdrawn = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${withdrawReqId}/withdrawals`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', withdrawKey)
      .send({ reason: 'No longer needed.' })
      .expect(200);
    await assertReceipt(fixture.requester, withdrawKey, 'request.withdraw', withdrawn.body);

    // 2. administrativeRemoval
    const adminRemoveReqId = await submitAndProcess(fixture.requester);
    const adminRemoveKey = randomUUID();
    const adminRemoved = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${adminRemoveReqId}/administrative-removals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', adminRemoveKey)
      .send({ reason: 'Duplicate request.' })
      .expect(200);
    await assertReceipt(fixture.admin, adminRemoveKey, 'request.administrativeRemoval', adminRemoved.body);

    // 3. correctReferences -> refer -> approve (with changes) -> acceptChanges -> allocation.*
    const flowReqId = await submitAndProcess(fixture.requester, 0, 14);
    const correctKey = randomUUID();
    const corrected = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${flowReqId}/reference-corrections`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', correctKey)
      .send({ groupId: fixture.group.id, resourceProfileId: fixture.profile.id, reason: 'Confirm references.' })
      .expect(200);
    await assertReceipt(fixture.admin, correctKey, 'request.correctReferences', corrected.body);

    const referKey = randomUUID();
    const referred = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${flowReqId}/referrals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', `"${corrected.body.version}"`)
      .set('Idempotency-Key', referKey)
      .send({})
      .expect(200);
    await assertReceipt(fixture.admin, referKey, 'request.refer', referred.body);

    const approveKey = randomUUID();
    const approvedProposal = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${flowReqId}/approvals`)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .set('If-Match', `"${referred.body.version}"`)
      .set('Idempotency-Key', approveKey)
      .send({
        personId: moderator.id,
        startDate: futureDate(5),
        endDate: futureDate(20),
        weeklyHours: 16,
        explanation: 'Shifted start date by 5 days.',
      })
      .expect(200);
    await assertReceipt(moderator, approveKey, 'request.approve', approvedProposal.body);

    // Scope loss blocks request.approve receipt; restoring scope restores access without mutating request.
    await people.update(moderator.id, { groupId: secondGroup.id });
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${approveKey}?operation=request.approve`)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .expect(403);
    await people.update(moderator.id, { groupId: fixture.group.id });

    const acceptKey = randomUUID();
    const accepted = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${flowReqId}/acceptances`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', `"${approvedProposal.body.version}"`)
      .set('Idempotency-Key', acceptKey)
      .send({})
      .expect(200);
    await assertReceipt(fixture.requester, acceptKey, 'request.acceptChanges', accepted.body);

    // 4. deny -> contestDenial -> exception.recordStrategy -> exception.escalate -> exception.cancel
    const deniedReqId = await submitAndProcess(fixture.requester);
    const referDenied = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${deniedReqId}/referrals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    const denyKey = randomUUID();
    const denied = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${deniedReqId}/denials`)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .set('If-Match', `"${referDenied.body.version}"`)
      .set('Idempotency-Key', denyKey)
      .send({ explanation: 'No capacity in requested window.' })
      .expect(200);
    await assertReceipt(moderator, denyKey, 'request.deny', denied.body);

    // Scope loss blocks request.deny receipt.
    await people.update(moderator.id, { groupId: null });
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${denyKey}?operation=request.deny`)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .expect(403);
    await people.update(moderator.id, { groupId: fixture.group.id });

    const contestKey = randomUUID();
    const contested = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${deniedReqId}/contests`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', `"${denied.body.version}"`)
      .set('Idempotency-Key', contestKey)
      .send({ explanation: 'Critical delivery milestone.' })
      .expect(200);
    await assertReceipt(fixture.requester, contestKey, 'request.contestDenial', contested.body);

    const strategyKey = randomUUID();
    const strategyRecorded = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${deniedReqId}/strategies`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', `"${contested.body.version}"`)
      .set('Idempotency-Key', strategyKey)
      .send({ strategy: 'OUTSOURCE', reason: 'Evaluating supplier.' })
      .expect(200);
    await assertReceipt(fixture.admin, strategyKey, 'request.exception.recordStrategy', strategyRecorded.body);

    const escalateKey = randomUUID();
    const escalated = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${deniedReqId}/escalations`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', `"${strategyRecorded.body.version}"`)
      .set('Idempotency-Key', escalateKey)
      .send({ reason: 'Requires escalation review.' })
      .expect(200);
    await assertReceipt(fixture.admin, escalateKey, 'request.exception.escalate', escalated.body);

    const exceptionCancelKey = randomUUID();
    const exceptionCancelled = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${deniedReqId}/cancellations`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', `"${escalated.body.version}"`)
      .set('Idempotency-Key', exceptionCancelKey)
      .send({ reason: 'Sponsor reprioritized.' })
      .expect(200);
    await assertReceipt(fixture.admin, exceptionCancelKey, 'request.exception.cancel', exceptionCancelled.body);

    // 5. deny -> cancelDenied & another contested -> exception.resolve
    const cancelDeniedReqId = await submitAndProcess(fixture.requester);
    const deniedForCancel = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${cancelDeniedReqId}/denials`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ explanation: 'Denied during presentation.' })
      .expect(200);
    const cancelDeniedKey = randomUUID();
    const cancelledByRequester = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${cancelDeniedReqId}/cancellations`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', `"${deniedForCancel.body.version}"`)
      .set('Idempotency-Key', cancelDeniedKey)
      .send({ reason: 'Acknowledged denial.' })
      .expect(200);
    await assertReceipt(fixture.requester, cancelDeniedKey, 'request.cancelDenied', cancelledByRequester.body);

    const resolveReqId = await submitAndProcess(fixture.requester);
    const deniedForResolve = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resolveReqId}/denials`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ explanation: 'Denied initially.' })
      .expect(200);
    const contestedForResolve = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resolveReqId}/contests`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', `"${deniedForResolve.body.version}"`)
      .set('Idempotency-Key', randomUUID())
      .send({ explanation: 'Need exception approval.' })
      .expect(200);
    const resolveKey = randomUUID();
    const resolved = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resolveReqId}/resolutions`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', `"${contestedForResolve.body.version}"`)
      .set('Idempotency-Key', resolveKey)
      .send({
        strategy: 'OUTSOURCE',
        reason: 'Approved via external contractor.',
        personId: moderator.id,
        resourceProfileId: fixture.profile.id,
        startDate: futureDate(0),
        endDate: futureDate(14),
        weeklyHours: 20,
      })
      .expect(200);
    await assertReceipt(fixture.admin, resolveKey, 'request.exception.resolve', resolved.body);

    // 6. All 6 allocation commands + scope re-verification without mutating history
    const allocId = resolved.body.allocation.id as string;
    const allocPath = `/api/resource-allocation/v1/allocations/${allocId}`;
    const runAllocCmd = async (actor: ResourcePerson, command: string, version: number) => {
      const key = randomUUID();
      const res = await request(app!.getHttpServer())
        .post(`${allocPath}/${command}`)
        .set('X-PMO-Local-User-ID', actor.localUserId)
        .set('If-Match', `"${version}"`)
        .set('Idempotency-Key', key)
        .send({ reason: `Executing ${command}.` })
        .expect(200);
      return { key, body: res.body };
    };
    const suspend = await runAllocCmd(supervisor, 'suspensions', 1);
    const reserve = await runAllocCmd(supervisor, 'reservations', suspend.body.version);
    const activate = await runAllocCmd(supervisor, 'activations', reserve.body.version);
    const suspend2 = await runAllocCmd(supervisor, 'suspensions', activate.body.version);
    const resume = await runAllocCmd(supervisor, 'resumptions', suspend2.body.version);
    const complete = await runAllocCmd(moderator, 'completions', resume.body.version);

    await assertReceipt(supervisor, suspend.key, 'allocation.suspend', suspend.body);
    await assertReceipt(supervisor, reserve.key, 'allocation.reserve', reserve.body);
    await assertReceipt(supervisor, activate.key, 'allocation.activate', activate.body);
    await assertReceipt(supervisor, resume.key, 'allocation.resume', resume.body);
    await assertReceipt(moderator, complete.key, 'allocation.complete', complete.body);

    // Second allocation for allocation.cancel
    const cancelAllocId = accepted.body.allocation.id as string;
    const cancelKey = randomUUID();
    const canceledAlloc = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/allocations/${cancelAllocId}/cancellations`)
      .set('X-PMO-Local-User-ID', supervisor.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', cancelKey)
      .send({ reason: 'Cancelled before start.' })
      .expect(200);
    await assertReceipt(supervisor, cancelKey, 'allocation.cancel', canceledAlloc.body);

    // Supervisor loses group scope (and group reference) -> 403 on allocation receipt; allocated person keeps access.
    await groups.update(fixture.group.id, { supervisorId: fixture.admin.id });
    await people.update(supervisor.id, { coveredGroupIds: [] });
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${suspend.key}?operation=allocation.suspend`)
      .set('X-PMO-Local-User-ID', supervisor.localUserId)
      .expect(403);
    // Allocated person (moderator) still sees their own allocation receipt even if moved to another group.
    await people.update(moderator.id, { groupId: secondGroup.id, role: ResourceAllocationRole.User });
    await assertReceipt(moderator, complete.key, 'allocation.complete', complete.body);
    expect(await dataSource!.query('SELECT id FROM resource_allocation_history WHERE allocation_id = $1', [allocId])).toHaveLength(6);

    // 7. Notifications mark-one-read & mark-all-read
    const inbox = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(inbox.body.items.length).toBeGreaterThanOrEqual(2);
    const markOneKey = randomUUID();
    const markedOne = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/notifications/${inbox.body.items[0].id}/readings`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', inbox.body.items[0].etag)
      .set('Idempotency-Key', markOneKey)
      .expect(200);
    await assertReceipt(fixture.requester, markOneKey, 'notifications.mark-one-read', markedOne.body);

    const markAllKey = randomUUID();
    const markedAll = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/notification-readings')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', markAllKey)
      .expect(200);
    await assertReceipt(fixture.requester, markAllKey, 'notifications.mark-all-read', markedAll.body);
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${markAllKey}?operation=notifications.mark-all-read`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(404);
  });

  it('uses the decision stage recorded in history when authorizing approval and denial receipts', async () => {
    const fixture = await setup();
    const people = dataSource!.getRepository(ResourcePerson);
    const assignee = await people.save(people.create({
      localUserId: 'receipt-stage-assignee', displayName: 'Receipt Stage Assignee', email: 'receipt-assignee@example.test',
      role: ResourceAllocationRole.User, active: true, coveredGroupIds: [], groupId: fixture.group.id,
    }));
    const groupAdmin = await people.save(people.create({
      localUserId: 'receipt-stage-admin', displayName: 'Receipt Stage Admin', email: 'receipt-admin@example.test',
      role: ResourceAllocationRole.Admin, active: true, coveredGroupIds: [], groupId: fixture.group.id,
    }));

    const submitRequest = async () => {
      const payload = bodyFor(fixture, 20);
      const submission = await request(app!.getHttpServer())
        .post('/api/resource-allocation/v1/submissions')
        .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
        .set('Idempotency-Key', randomUUID())
        .send(payload)
        .expect(202);
      expect(await app!.get(ResourceAllocationSubmissionWorker).processBatch(1)).toBe(1);
      const lines = await request(app!.getHttpServer())
        .get(`/api/resource-allocation/v1/submissions/${submission.body.id}/lines`)
        .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
        .expect(200);
      return lines.body.items[0].requestId as string;
    };

    const recover = (actor: ResourcePerson, key: string, operation: string) => request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${key}?operation=${operation}`)
      .set('X-PMO-Local-User-ID', actor.localUserId);

    // A module-wide Admin can act during Apresentação and recover that decision afterwards.
    const presentationApprovalRequestId = await submitRequest();
    const presentationApprovalKey = randomUUID();
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${presentationApprovalRequestId}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', presentationApprovalKey)
      .send({ personId: assignee.id })
      .expect(200);
    await recover(fixture.admin, presentationApprovalKey, 'request.approve').expect(200);

    // The same global Admin can deny during Apresentação and recover the denial.
    const presentationDenialRequestId = await submitRequest();
    const presentationDenialKey = randomUUID();
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${presentationDenialRequestId}/denials`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', presentationDenialKey)
      .send({ explanation: 'The request cannot be supported.' })
      .expect(200);
    await recover(fixture.admin, presentationDenialKey, 'request.deny').expect(200);

    // Group Admins may decide a team-stage request, but lose access to its receipt when their group scope changes.
    const teamApprovalRequestId = await submitRequest();
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${teamApprovalRequestId}/referrals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    const teamApprovalKey = randomUUID();
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${teamApprovalRequestId}/approvals`)
      .set('X-PMO-Local-User-ID', groupAdmin.localUserId)
      .set('If-Match', '"2"')
      .set('Idempotency-Key', teamApprovalKey)
      .send({ personId: assignee.id })
      .expect(200);
    await recover(groupAdmin, teamApprovalKey, 'request.approve').expect(200);
    await people.update(groupAdmin.id, { groupId: null });
    await recover(groupAdmin, teamApprovalKey, 'request.approve').expect(403);
    await people.update(groupAdmin.id, { groupId: fixture.group.id });

    const teamDenialRequestId = await submitRequest();
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${teamDenialRequestId}/referrals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    const teamDenialKey = randomUUID();
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${teamDenialRequestId}/denials`)
      .set('X-PMO-Local-User-ID', groupAdmin.localUserId)
      .set('If-Match', '"2"')
      .set('Idempotency-Key', teamDenialKey)
      .send({ explanation: 'The team has no capacity.' })
      .expect(200);
    await recover(groupAdmin, teamDenialKey, 'request.deny').expect(200);
    await people.update(groupAdmin.id, { groupId: null });
    await recover(groupAdmin, teamDenialKey, 'request.deny').expect(403);
  });

  it('persists and exposes aligned problem details (code, title, detail, message) for definitively failed submission lines', async () => {
    const fixture = await setup();
    const payload = bodyFor(fixture, 20);
    payload.lines[0].startDate = futureDate(-1);
    const accepted = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(202);

    expect(await app!.get(ResourceAllocationSubmissionWorker).processBatch(1)).toBe(1);

    const lines = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${accepted.body.id}/lines`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    const expectedProblem = {
      code: 'INVALID_BUSINESS_DATE',
      title: 'Invalid business date',
      detail: 'The request dates must be valid, start today or later, and end on or after the start date. Review the dates and submit a corrected attempt.',
      message: 'The request dates must be valid, start today or later, and end on or after the start date. Review the dates and submit a corrected attempt.',
    };
    expect(lines.body.items[0]).toMatchObject({
      status: 'FAILED',
      problem: expectedProblem,
    });

    const operationResult = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/operation-results/${payload.lines[0].attemptKey}?operation=submission.create`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(operationResult.body).toMatchObject({
      status: 'FAILED',
      problem: expectedProblem,
    });
  });
});
