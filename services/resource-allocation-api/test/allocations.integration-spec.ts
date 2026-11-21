import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { RESOURCE_ALLOCATION_DATA_SOURCE } from '../src/database/database.module';
import { ResourcePerson } from '../src/people/resource-person.entity';
import { ResourceAllocationRole } from '../src/people/resource-allocation-role';
import { ResourceGroup } from '../src/groups/resource-group.entity';
import { ResourceProfile } from '../src/resource-profiles/resource-profile.entity';
import { ResourceInitiative } from '../src/initiatives/resource-initiative.entity';
import { ResourceAllocation } from '../src/allocations/resource-allocation.entity';
import { ResourceAllocationHistory } from '../src/allocations/resource-allocation-history.entity';
import { ResourceAllocationLifecycleWorker } from '../src/allocations/resource-allocation-lifecycle.worker';
import { ResourceRequest } from '../src/requests/resource-request.entity';
import { ResourceRequestHistory } from '../src/requests/resource-request-history.entity';
import { ResourceSubmission } from '../src/submissions/resource-submission.entity';
import { ResourceSubmissionLine } from '../src/submissions/resource-submission-line.entity';

describe('Tech Resource Allocation allocations (#69)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_allocations_test')
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
    await dataSource?.query('TRUNCATE TABLE resource_people RESTART IDENTITY CASCADE');
  });

  async function addPerson(localUserId: string, role: ResourceAllocationRole, groupId: string | null = null) {
    const repository = dataSource!.getRepository(ResourcePerson);
    return repository.save(repository.create({
      localUserId,
      displayName: localUserId.replaceAll('-', ' '),
      email: `${localUserId}@example.test`,
      role,
      active: true,
      groupId,
      coveredGroupIds: [],
    }));
  }

  async function setup() {
    const admin = await addPerson('allocation-admin', ResourceAllocationRole.Admin);
    const requester = await addPerson('allocation-requester', ResourceAllocationRole.User);
    const assignee = await addPerson('allocation-assignee', ResourceAllocationRole.User);
    const otherAssignee = await addPerson('allocation-other-assignee', ResourceAllocationRole.User);
    const outsider = await addPerson('allocation-outsider', ResourceAllocationRole.User);
    const moderator = await addPerson('allocation-moderator', ResourceAllocationRole.Moderator);
    const supervisor = await addPerson('allocation-supervisor', ResourceAllocationRole.Supervisor);
    const manager = await addPerson('allocation-manager', ResourceAllocationRole.Manager);
    const group = await dataSource!.getRepository(ResourceGroup).save({
      name: 'Platform', active: true, supervisorId: supervisor.id, managerId: manager.id,
    });
    moderator.groupId = group.id;
    await dataSource!.getRepository(ResourcePerson).save([moderator, supervisor, manager]);
    const profile = await dataSource!.getRepository(ResourceProfile).save({ name: 'API', groupId: group.id, active: true });
    const initiative = await dataSource!.getRepository(ResourceInitiative).save({
      code: `ITDM-${randomUUID().slice(0, 8)}`, name: 'Resource allocation', active: true, codeUsed: true,
    });
    return { admin, requester, assignee, otherAssignee, outsider, moderator, supervisor, manager, group, profile, initiative };
  }

  async function businessDate(): Promise<string> {
    const rows = await dataSource!.query("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today") as Array<{ today: string }>;
    return rows[0].today;
  }

  function addDays(date: string, days: number): string {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  async function createAllocation(
    fixture: Awaited<ReturnType<typeof setup>>,
    options: { person?: ResourcePerson; startDate?: string; endDate?: string; weeklyHours?: number; state?: string } = {},
  ) {
    const today = await businessDate();
    const startDate = options.startDate ?? today;
    const endDate = options.endDate ?? addDays(startDate, 7);
    const person = options.person ?? fixture.assignee;
    const correlationId = randomUUID();
    const submission = await dataSource!.getRepository(ResourceSubmission).save({
      requesterId: fixture.requester.id,
      category: 'EXECUTION_PROJECT',
      lineCount: 1,
      correlationId,
    });
    const submittedConditions = {
      initiativeId: fixture.initiative.id,
      initiativeCode: fixture.initiative.code,
      initiativeName: fixture.initiative.name,
      category: 'EXECUTION_PROJECT',
      groupId: fixture.group.id,
      groupName: fixture.group.name,
      resourceProfileId: fixture.profile.id,
      resourceProfileName: fixture.profile.name,
      startDate,
      endDate,
      weeklyHours: options.weeklyHours ?? 20,
    };
    const line = await dataSource!.getRepository(ResourceSubmissionLine).save({
      submissionId: submission.id,
      requesterId: fixture.requester.id,
      attemptKey: randomUUID(),
      attemptPayloadHash: 'a'.repeat(64),
      lineNumber: 0,
      submittedConditions,
      status: 'RECEIVED' as never,
      requestId: null,
      problem: null,
      requestOutcome: null,
      claimToken: null,
      claimedAt: null,
      completedAt: null,
    });
    const requestItem = await dataSource!.getRepository(ResourceRequest).save({
      submissionLineId: line.id,
      requesterId: fixture.requester.id,
      requesterSnapshot: { personId: fixture.requester.id, displayName: fixture.requester.displayName, role: fixture.requester.role },
      requestedConditions: submittedConditions,
      approvedConditions: {
        personId: person.id,
        personName: person.displayName,
        resourceProfileId: fixture.profile.id,
        resourceProfileName: fixture.profile.name,
        startDate,
        endDate,
        weeklyHours: options.weeklyHours ?? 20,
      },
      decisionState: 'APPROVED',
      receivedAt: new Date(),
      stageEnteredAt: new Date(),
      expirationDueAt: new Date(Date.now() + 21 * 86_400_000),
      removedAt: null,
    });
    await dataSource!.getRepository(ResourceSubmissionLine).update(line.id, {
      status: 'SUCCEEDED' as never,
      requestId: requestItem.id,
      requestOutcome: { decisionState: 'APPROVED', requestedConditions: submittedConditions },
      completedAt: new Date(),
    });
    await dataSource!.getRepository(ResourceRequestHistory).insert({
      requestId: requestItem.id,
      actorSnapshot: { personId: fixture.requester.id, displayName: fixture.requester.displayName, role: fixture.requester.role },
      action: 'APPROVED',
      afterSnapshot: { requestId: requestItem.id, decisionState: 'APPROVED', requestedConditions: submittedConditions },
      correlationId,
    });
    const now = new Date();
    const allocation = await dataSource!.getRepository(ResourceAllocation).save({
      sourceRequestId: requestItem.id,
      personId: person.id,
      personSnapshot: { personId: person.id, displayName: person.displayName, role: person.role },
      groupId: fixture.group.id,
      groupSnapshot: { id: fixture.group.id, name: fixture.group.name },
      initiativeId: fixture.initiative.id,
      initiativeSnapshot: { id: fixture.initiative.id, code: fixture.initiative.code, name: fixture.initiative.name },
      resourceProfileId: fixture.profile.id,
      resourceProfileSnapshot: { id: fixture.profile.id, name: fixture.profile.name },
      approvedStartDate: startDate,
      approvedEndDate: endDate,
      effectiveStartDate: startDate,
      effectiveEndDate: endDate,
      weeklyHours: (options.weeklyHours ?? 20).toFixed(1),
      state: options.state ?? (startDate <= today ? 'IN_PROGRESS' : 'NOT_STARTED'),
      stateEnteredAt: now,
      approvedAt: now,
    });
    return { allocation, requestItem };
  }

  it('lists the current user’s allocations and returns an empty cursor page when none exist', async () => {
    const fixture = await setup();
    const response = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/allocations')
      .set('X-PMO-Local-User-ID', fixture.assignee.localUserId)
      .expect(200);

    expect(response.body).toEqual({
      items: [],
      page: { nextCursor: null, limit: 50 },
    });
  });

  it('filters allocations by inclusive effective-period overlap and applies person and leadership scope', async () => {
    const fixture = await setup();
    const today = await businessDate();
    const first = await createAllocation(fixture, { person: fixture.assignee, startDate: addDays(today, -2), endDate: today });
    const second = await createAllocation(fixture, { person: fixture.otherAssignee, startDate: addDays(today, -1), endDate: addDays(today, 1) });
    const path = '/api/resource-allocation/v1/allocations';

    const own = await request(app!.getHttpServer())
      .get(path)
      .query({ periodStart: today, periodEnd: today })
      .set('X-PMO-Local-User-ID', fixture.assignee.localUserId)
      .expect(200);
    expect(own.body.items.map((item: { id: string }) => item.id)).toEqual([first.allocation.id]);
    expect(own.body.items[0]).toMatchObject({
      requestId: first.requestItem.id,
      approvedPeriod: { startDate: addDays(today, -2), endDate: today },
      startDate: addDays(today, -2),
      endDate: today,
      availableActions: ['SUSPEND', 'RESERVE', 'COMPLETE', 'CANCEL'],
    });

    const team = await request(app!.getHttpServer())
      .get(path)
      .query({ periodStart: today, periodEnd: today, initiativeId: fixture.initiative.id, operationalState: 'IN_PROGRESS' })
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .expect(200);
    expect(team.body.items.map((item: { id: string }) => item.id).sort()).toEqual([first.allocation.id, second.allocation.id].sort());
    expect(team.body.page.nextCursor).toBeNull();

    const disjoint = await request(app!.getHttpServer())
      .get(path)
      .query({ periodStart: addDays(today, 2), periodEnd: addDays(today, 3) })
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .expect(200);
    expect(disjoint.body.items).toEqual([]);

    const outsider = await request(app!.getHttpServer())
      .get(`${path}/${first.allocation.id}`)
      .set('X-PMO-Local-User-ID', fixture.outsider.localUserId)
      .expect(403);
    expect(outsider.body.code).toBe('ACCESS_DENIED');

    await request(app!.getHttpServer())
      .get(`${path}/${first.allocation.id}`)
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .expect('ETag', '"1"')
      .expect(200);

    await dataSource!.getRepository(ResourcePerson).update(fixture.assignee.id, {
      role: ResourceAllocationRole.Manager,
      coveredGroupIds: [],
    });
    const reassigned = await request(app!.getHttpServer())
      .get(path)
      .set('X-PMO-Local-User-ID', fixture.assignee.localUserId)
      .expect(200);
    expect(reassigned.body.items.map((item: { id: string }) => item.id)).toEqual([first.allocation.id]);
    await request(app!.getHttpServer())
      .get(`${path}/${first.allocation.id}`)
      .set('X-PMO-Local-User-ID', fixture.assignee.localUserId)
      .expect(200);
  });

  it('sums weekly hours by current state on an inclusive date without prorating or counting closed states', async () => {
    const fixture = await setup();
    const today = await businessDate();
    await createAllocation(fixture, { person: fixture.assignee, startDate: today, endDate: addDays(today, 7), weeklyHours: 30, state: 'IN_PROGRESS' });
    await createAllocation(fixture, { person: fixture.assignee, startDate: today, endDate: addDays(today, 5), weeklyHours: 20, state: 'SUSPENDED' });
    await createAllocation(fixture, { person: fixture.assignee, startDate: addDays(today, 1), endDate: addDays(today, 10), weeklyHours: 8, state: 'NOT_STARTED' });
    await createAllocation(fixture, { person: fixture.assignee, startDate: today, endDate: addDays(today, 4), weeklyHours: 12, state: 'CANCELED' });

    const response = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/allocation-load')
      .query({ date: today, personId: fixture.assignee.id })
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);

    expect(response.body).toMatchObject({
      date: today,
      items: [{
        person: { personId: fixture.assignee.id, displayName: fixture.assignee.displayName },
        weeklyHoursByState: {
          NOT_STARTED: 0,
          IN_PROGRESS: 30,
          SUSPENDED: 20,
          ALLOCATED_WITHOUT_ACTION: 0,
          DONE: 0,
          CANCELED: 0,
        },
        totalWeeklyHours: 50,
      }],
      page: { nextCursor: null, limit: 50 },
    });
  });

  it('changes operational state with version checks, idempotency, reason, history, and scoped notices', async () => {
    const fixture = await setup();
    const today = await businessDate();
    const created = await createAllocation(fixture, { startDate: today, endDate: addDays(today, 7), state: 'IN_PROGRESS' });
    const path = `/api/resource-allocation/v1/allocations/${created.allocation.id}`;
    const detail = await request(app!.getHttpServer())
      .get(path)
      .set('X-PMO-Local-User-ID', fixture.assignee.localUserId)
      .expect(200);
    expect(detail.body.availableActions).toEqual(['SUSPEND', 'RESERVE', 'COMPLETE', 'CANCEL']);
    expect(detail.headers.etag).toBe('"1"');

    const key = randomUUID();
    const headers = {
      'X-PMO-Local-User-ID': fixture.assignee.localUserId,
      'If-Match': '"1"',
      'Idempotency-Key': key,
      'X-Correlation-ID': randomUUID(),
    };
    vi.stubEnv('RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED', 'false');
    try {
      await request(app!.getHttpServer())
        .post(`${path}/suspensions`)
        .set(headers)
        .send({ reason: 'A local header grants no access when local simulation is disabled.' })
        .expect(403);
    } finally {
      vi.unstubAllEnvs();
    }

    const suspended = await request(app!.getHttpServer())
      .post(`${path}/suspensions`)
      .set(headers)
      .send({ reason: 'Waiting for an external dependency.' })
      .expect(200);
    expect(suspended.headers.etag).toBe('"2"');
    expect(suspended.body).toMatchObject({ state: 'SUSPENDED', version: 2, availableActions: ['RESUME', 'RESERVE', 'COMPLETE', 'CANCEL'] });

    const replay = await request(app!.getHttpServer())
      .post(`${path}/suspensions`)
      .set(headers)
      .send({ reason: 'Waiting for an external dependency.' })
      .expect('Idempotency-Replayed', 'true')
      .expect(200);
    expect(replay.headers.etag).toBeUndefined();
    expect(replay.body).toEqual(suspended.body);
    expect(await dataSource!.getRepository(ResourceAllocationHistory).countBy({ allocationId: created.allocation.id })).toBe(1);

    await request(app!.getHttpServer())
      .post(`${path}/suspensions`)
      .set({ ...headers, 'Idempotency-Key': randomUUID() })
      .send({ reason: 'A stale read must not overwrite the suspension.' })
      .expect(412);
    await request(app!.getHttpServer())
      .post(`${path}/suspensions`)
      .set(headers)
      .send({ reason: 'Different command content.' })
      .expect(409);

    const history = await request(app!.getHttpServer())
      .get(`${path}/history`)
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({
      action: 'ALLOCATION_SUSPENDED_SUSPENDED',
      reason: 'Waiting for an external dependency.',
      before: { state: 'IN_PROGRESS' },
      after: { state: 'SUSPENDED' },
      correlationId: headers['X-Correlation-ID'],
    });

    const managerInbox = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications')
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .expect(200);
    expect(managerInbox.body.items[0]).toMatchObject({
      eventCode: 'ALLOCATION_SUSPENDED_2',
      target: { available: true, destination: 'ALLOCATION_DETAIL', allocationId: created.allocation.id },
    });
    const actingPersonInbox = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications')
      .set('X-PMO-Local-User-ID', fixture.assignee.localUserId)
      .expect(200);
    expect(actingPersonInbox.body.items).toEqual([]);

    const resumed = await request(app!.getHttpServer())
      .post(`${path}/resumptions`)
      .set({ ...headers, 'If-Match': '"2"', 'Idempotency-Key': randomUUID() })
      .send({ reason: 'The dependency is available.' })
      .expect(200);
    expect(resumed.body).toMatchObject({ state: 'IN_PROGRESS', version: 3 });

    const completed = await request(app!.getHttpServer())
      .post(`${path}/completions`)
      .set({ ...headers, 'If-Match': '"3"', 'Idempotency-Key': randomUUID() })
      .send({ reason: 'The planned work is finished.' })
      .expect(200);
    expect(completed.body).toMatchObject({
      state: 'DONE',
      version: 4,
      startDate: today,
      endDate: today,
      approvedPeriod: { startDate: today, endDate: addDays(today, 7) },
      availableActions: [],
    });
    await request(app!.getHttpServer())
      .post(`${path}/cancellations`)
      .set({ ...headers, 'If-Match': '"4"', 'Idempotency-Key': randomUUID() })
      .send({ reason: 'Try to reopen a completed allocation.' })
      .expect(422);
  });

  it('rejects completion before the start and preserves future approved periods on cancellation', async () => {
    const fixture = await setup();
    const today = await businessDate();
    const startDate = addDays(today, 2);
    const endDate = addDays(today, 9);
    const created = await createAllocation(fixture, { startDate, endDate, state: 'NOT_STARTED' });
    const path = `/api/resource-allocation/v1/allocations/${created.allocation.id}`;
    const headers = {
      'X-PMO-Local-User-ID': fixture.manager.localUserId,
      'If-Match': '"1"',
      'Idempotency-Key': randomUUID(),
      'X-Correlation-ID': randomUUID(),
    };
    await request(app!.getHttpServer())
      .post(`${path}/completions`)
      .set(headers)
      .send({ reason: 'This work has not started.' })
      .expect(422);
    const canceled = await request(app!.getHttpServer())
      .post(`${path}/cancellations`)
      .set({ ...headers, 'Idempotency-Key': randomUUID() })
      .send({ reason: 'The initiative was canceled before work began.' })
      .expect(200);
    expect(canceled.body).toMatchObject({
      state: 'CANCELED',
      startDate,
      endDate,
      approvedPeriod: { startDate, endDate },
    });
  });

  it('rolls back a state change and history when notification persistence fails', async () => {
    const fixture = await setup();
    const today = await businessDate();
    const created = await createAllocation(fixture, { startDate: today, endDate: addDays(today, 7), state: 'IN_PROGRESS' });
    await dataSource!.query(`
      CREATE FUNCTION fail_allocation_notice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test notification failure'; END
      $$
    `);
    await dataSource!.query(`CREATE TRIGGER fail_allocation_notice_before_insert BEFORE INSERT ON resource_allocation_notifications FOR EACH ROW EXECUTE FUNCTION fail_allocation_notice()`);
    const headers = {
      'X-PMO-Local-User-ID': fixture.assignee.localUserId,
      'If-Match': '"1"',
      'Idempotency-Key': randomUUID(),
      'X-Correlation-ID': randomUUID(),
    };
    try {
      await request(app!.getHttpServer())
        .post(`/api/resource-allocation/v1/allocations/${created.allocation.id}/suspensions`)
        .set(headers)
        .send({ reason: 'Testing atomic effects.' })
        .expect(500);
      const allocation = await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: created.allocation.id });
      expect(allocation).toMatchObject({ state: 'IN_PROGRESS', version: 1 });
      expect(await dataSource!.getRepository(ResourceAllocationHistory).countBy({ allocationId: created.allocation.id })).toBe(0);
      expect(await dataSource!.query("SELECT id FROM resource_allocation_operation_receipts WHERE operation = 'allocation.suspend'")).toHaveLength(0);
    } finally {
      await dataSource!.query('DROP TRIGGER fail_allocation_notice_before_insert ON resource_allocation_notifications');
      await dataSource!.query('DROP FUNCTION fail_allocation_notice()');
    }
  });

  it('applies São Paulo start and end dates idempotently through the lifecycle worker', async () => {
    const fixture = await setup();
    const today = await businessDate();
    const starting = await createAllocation(fixture, { startDate: today, endDate: addDays(today, 2), state: 'NOT_STARTED' });
    const ending = await createAllocation(fixture, { startDate: addDays(today, -5), endDate: addDays(today, -1), state: 'SUSPENDED' });
    const finalDay = await createAllocation(fixture, { startDate: addDays(today, -5), endDate: today, state: 'SUSPENDED' });
    const canceled = await createAllocation(fixture, { startDate: addDays(today, -5), endDate: addDays(today, -1), state: 'CANCELED' });
    const worker = app!.get(ResourceAllocationLifecycleWorker);

    expect(await worker.processBatch()).toBe(2);
    expect(await worker.processBatch()).toBe(0);
    const savedStarting = await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: starting.allocation.id });
    const savedEnding = await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: ending.allocation.id });
    const savedFinalDay = await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: finalDay.allocation.id });
    const savedCanceled = await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: canceled.allocation.id });
    expect(savedStarting).toMatchObject({ state: 'IN_PROGRESS', version: 2 });
    expect(savedEnding).toMatchObject({ state: 'DONE', version: 2, effectiveEndDate: addDays(today, -1), approvedEndDate: addDays(today, -1) });
    expect(savedFinalDay).toMatchObject({ state: 'SUSPENDED', version: 1, effectiveEndDate: today });
    expect(savedCanceled).toMatchObject({ state: 'CANCELED', version: 1 });
    expect(await dataSource!.getRepository(ResourceAllocationHistory).countBy({ allocationId: starting.allocation.id })).toBe(1);
    expect(await dataSource!.getRepository(ResourceAllocationHistory).countBy({ allocationId: ending.allocation.id })).toBe(1);
  });

  it('serializes DTO query and body validation field errors into RFC 9457 errors[]', async () => {
    const fixture = await setup();
    const today = await businessDate();
    const created = await createAllocation(fixture, { startDate: today, endDate: addDays(today, 7), state: 'IN_PROGRESS' });

    const invalidQuery = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/allocations?limit=101')
      .set('X-PMO-Local-User-ID', fixture.assignee.localUserId)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(invalidQuery.body.errors).toEqual([{ path: 'limit', code: 'MAX', message: expect.any(String) }]);

    const invalidBody = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/allocations/${created.allocation.id}/suspensions`)
      .set({
        'X-PMO-Local-User-ID': fixture.assignee.localUserId,
        'If-Match': '"1"',
        'Idempotency-Key': randomUUID(),
      })
      .send({ reason: '   ' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(invalidBody.body.errors).toEqual(expect.arrayContaining([
      { path: 'reason', code: 'MATCHES', message: expect.any(String) },
    ]));
  });
});
