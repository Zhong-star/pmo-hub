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
import { ResourceRequest } from '../src/requests/resource-request.entity';

describe('Tech Resource Allocation requests (#61)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_requests_test')
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
      localUserId: 'request-admin', displayName: 'Request Admin', email: 'admin@example.test',
      role: ResourceAllocationRole.Admin, active: true, coveredGroupIds: [], groupId: null,
    }));
    const requester = await people.save(people.create({
      localUserId: 'request-owner', displayName: 'Request Owner', email: 'owner@example.test',
      role: ResourceAllocationRole.User, active: true, coveredGroupIds: [], groupId: null,
    }));
    const other = await people.save(people.create({
      localUserId: 'request-other', displayName: 'Other Owner', email: 'other@example.test',
      role: ResourceAllocationRole.User, active: true, coveredGroupIds: [], groupId: null,
    }));
    const groups = dataSource!.getRepository(ResourceGroup);
    const firstGroup = await groups.save(groups.create({ name: 'Engineering', active: true, supervisorId: admin.id, managerId: admin.id }));
    const secondGroup = await groups.save(groups.create({ name: 'Operations', active: true, supervisorId: admin.id, managerId: admin.id }));
    const profiles = dataSource!.getRepository(ResourceProfile);
    const firstProfile = await profiles.save(profiles.create({ name: 'Developer', active: true, groupId: firstGroup.id }));
    const secondProfile = await profiles.save(profiles.create({ name: 'Analyst', active: true, groupId: secondGroup.id }));
    const initiatives = dataSource!.getRepository(ResourceInitiative);
    const firstInitiative = await initiatives.save(initiatives.create({ code: 'ITDM-061-A', name: 'First initiative', active: true }));
    const secondInitiative = await initiatives.save(initiatives.create({ code: 'ITDM-061-B', name: 'Second initiative', active: true }));
    return { admin, requester, other, firstGroup, secondGroup, firstProfile, secondProfile, firstInitiative, secondInitiative };
  }

  function futureDate(daysFromToday: number): string {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const [year, month, day] = today.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + daysFromToday)).toISOString().slice(0, 10);
  }

  async function createRequest(
    fixture: Awaited<ReturnType<typeof setup>>,
    localUserId: string,
    conditions: { groupId?: string; resourceProfileId?: string; initiativeId?: string; weeklyHours?: number } = {},
  ) {
    const accepted = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({
        initiativeId: conditions.initiativeId ?? fixture.firstInitiative.id,
        category: 'EXECUTION_PROJECT',
        lines: [{
          attemptKey: randomUUID(),
          groupId: conditions.groupId ?? fixture.firstGroup.id,
          resourceProfileId: conditions.resourceProfileId ?? fixture.firstProfile.id,
          startDate: futureDate(3),
          endDate: futureDate(30),
          weeklyHours: conditions.weeklyHours ?? 12,
          comment: 'Initial scope.',
        }],
      })
      .expect(202);
    await app!.get(ResourceAllocationSubmissionWorker).processBatch(1);
    const lines = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${accepted.body.id}/lines`)
      .set('X-PMO-Local-User-ID', localUserId)
      .expect(200);
    return { id: lines.body.items[0].requestId as string, receivedAt: lines.body.items[0].receivedAt as string };
  }

  it('lists only the current requester’s operational requests with deterministic cursor and confirmed filters', async () => {
    const fixture = await setup();
    const first = await createRequest(fixture, fixture.requester.localUserId);
    const second = await createRequest(fixture, fixture.requester.localUserId, {
      groupId: fixture.secondGroup.id,
      resourceProfileId: fixture.secondProfile.id,
      initiativeId: fixture.secondInitiative.id,
    });
    await createRequest(fixture, fixture.other.localUserId);

    const path = '/api/resource-allocation/v1/requests';
    const firstPage = await request(app!.getHttpServer())
      .get(`${path}?limit=1&initiativeId=${fixture.firstInitiative.id}&decisionState=WAITING_FOR_PRESENTATION&groupId=${fixture.firstGroup.id}&resourceProfileId=${fixture.firstProfile.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect((response) => expect(response.status, JSON.stringify(response.body)).toBe(200));
    expect(firstPage.body.items.map((item: { id: string }) => item.id)).toEqual([first.id]);
    expect(firstPage.body.page).toMatchObject({ limit: 1, nextCursor: null });

    const unfiltered = await request(app!.getHttpServer())
      .get(path)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(unfiltered.body.items.map((item: { id: string }) => item.id)).toEqual([second.id, first.id]);
    expect(unfiltered.body.items[0]).toMatchObject({
      requesterSnapshot: { personId: fixture.requester.id, displayName: 'Request Owner' },
      requestedConditions: { groupId: fixture.secondGroup.id, resourceProfileId: fixture.secondProfile.id, initiativeId: fixture.secondInitiative.id },
      decisionState: 'WAITING_FOR_PRESENTATION',
      version: 1,
    });

    const cursorPageOne = await request(app!.getHttpServer())
      .get(`${path}?limit=1`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(cursorPageOne.body.page.nextCursor).toEqual(expect.any(String));
    const cursorPageTwo = await request(app!.getHttpServer())
      .get(`${path}?limit=1&cursor=${encodeURIComponent(cursorPageOne.body.page.nextCursor)}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect([...cursorPageOne.body.items, ...cursorPageTwo.body.items].map((item: { id: string }) => item.id).sort())
      .toEqual([first.id, second.id].sort());

    const detail = await request(app!.getHttpServer())
      .get(`${path}/${first.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(detail.headers.etag).toBe('"1"');
    await request(app!.getHttpServer())
      .get(`${path}/${first.id}`)
      .set('X-PMO-Local-User-ID', fixture.other.localUserId)
      .expect(404);
  });

  it('lets current leadership and Admin consult operational requests and history in their current scope without owner actions', async () => {
    const fixture = await setup();
    const people = dataSource!.getRepository(ResourcePerson);
    const supervisor = await people.save(people.create({
      localUserId: 'request-supervisor', displayName: 'Request Supervisor', email: 'supervisor@example.test',
      role: ResourceAllocationRole.Supervisor, active: true, coveredGroupIds: [fixture.firstGroup.id], groupId: null,
    }));
    const moderator = await people.save(people.create({
      localUserId: 'request-moderator', displayName: 'Request Moderator', email: 'moderator@example.test',
      role: ResourceAllocationRole.Moderator, active: true, coveredGroupIds: [], groupId: fixture.firstGroup.id,
    }));
    const requestRepo = dataSource!.getRepository(ResourceRequest);
    const inScope: Array<{ id: string; state: string }> = [];
    for (const state of ['DENIED', 'APPROVED_WITH_CHANGES', 'APPROVED', 'CANCELLED']) {
      const created = await createRequest(fixture, fixture.other.localUserId);
      await requestRepo.update({ id: created.id }, {
        decisionState: state as ResourceRequest['decisionState'],
        version: 2,
        ...(state === 'APPROVED_WITH_CHANGES' ? { decisionResponseDueAt: new Date(Date.now() + 60_000) } : {}),
      });
      inScope.push({ id: created.id, state });
    }
    const outOfScope = await createRequest(fixture, fixture.other.localUserId, {
      groupId: fixture.secondGroup.id,
      resourceProfileId: fixture.secondProfile.id,
    });
    const path = '/api/resource-allocation/v1/requests';

    const ownDefault = await request(app!.getHttpServer())
      .get(path)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(ownDefault.body.items).toHaveLength(0);
    await request(app!.getHttpServer())
      .get(`${path}?scope=visible`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(403);

    const visible = await request(app!.getHttpServer())
      .get(`${path}?scope=visible`)
      .set('X-PMO-Local-User-ID', supervisor.localUserId)
      .expect(200);
    expect(visible.body.items.map((item: { id: string }) => item.id).sort())
      .toEqual(inScope.map((item) => item.id).sort());
    for (const item of inScope) {
      const detail = await request(app!.getHttpServer())
        .get(`${path}/${item.id}`)
        .set('X-PMO-Local-User-ID', supervisor.localUserId)
        .expect(200);
      expect(detail.body).toMatchObject({ decisionState: item.state, availableActions: [] });
      const history = await request(app!.getHttpServer())
        .get(`${path}/${item.id}/history`)
        .set('X-PMO-Local-User-ID', supervisor.localUserId)
        .expect(200);
      expect(history.body.items).toContainEqual(expect.objectContaining({ action: 'SUBMITTED' }));
    }
    await request(app!.getHttpServer())
      .get(`${path}?scope=visible&groupId=${fixture.secondGroup.id}`)
      .set('X-PMO-Local-User-ID', supervisor.localUserId)
      .expect(403);
    await request(app!.getHttpServer())
      .get(`${path}/${outOfScope.id}`)
      .set('X-PMO-Local-User-ID', supervisor.localUserId)
      .expect(404);
    await request(app!.getHttpServer())
      .get(`${path}/${outOfScope.id}/history`)
      .set('X-PMO-Local-User-ID', supervisor.localUserId)
      .expect(404);
    await request(app!.getHttpServer())
      .get(`${path}/${inScope[0].id}`)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .expect(200);
    const global = await request(app!.getHttpServer())
      .get(`${path}?scope=visible`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(global.body.items).toHaveLength(5);

    await people.update({ id: supervisor.id }, { coveredGroupIds: [] });
    await request(app!.getHttpServer())
      .get(`${path}/${inScope[0].id}`)
      .set('X-PMO-Local-User-ID', supervisor.localUserId)
      .expect(404);
  });

  it('edits waiting requests conditionally, keeping the original deadline and an immutable history event', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture, fixture.requester.localUserId);
    const edit = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/requests/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .send({ comment: 'Updated scope.', weeklyHours: 18.5 })
      .expect(200);

    expect(edit.headers.etag).toBe('"2"');
    expect(edit.body).toMatchObject({
      decisionState: 'WAITING_FOR_PRESENTATION',
      requestedConditions: { comment: 'Updated scope.', weeklyHours: 18.5 },
      receivedAt: created.receivedAt,
      version: 2,
    });
    const history = await dataSource!.query(
      'SELECT action, after_snapshot FROM resource_request_history WHERE request_id = $1 ORDER BY occurred_at, id',
      [created.id],
    );
    expect(history.map((event: { action: string }) => event.action)).toEqual(['SUBMITTED', 'EDITED']);
    expect(history[1].after_snapshot.requestedConditions).toMatchObject({ comment: 'Updated scope.', weeklyHours: 18.5 });

    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/requests/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .send({ comment: 'Missing precondition.' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/requests/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .send({ comment: 'Stale text stays in the client.' })
      .expect(412);
    const afterConflict = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(afterConflict.body.requestedConditions.comment).toBe('Updated scope.');
    expect(await dataSource!.query('SELECT id FROM resource_request_history WHERE request_id = $1', [created.id])).toHaveLength(2);
  });

  it('withdraws only a waiting request and preserves a scoped immutable audit and the submission outcome', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture, fixture.requester.localUserId);
    const path = `/api/resource-allocation/v1/requests/${created.id}`;
    await request(app!.getHttpServer())
      .post(`${path}/withdrawals`)
      .set('X-PMO-Local-User-ID', fixture.other.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Not needed now.' })
      .expect(404);

    const withdrawn = await request(app!.getHttpServer())
      .post(`${path}/withdrawals`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', 'fdbef2f5-41e2-4f23-b3be-87f7162b8c29')
      .send({ reason: 'The initiative changed direction.' })
      .expect(200);
    expect(withdrawn.body).toMatchObject({ requestId: created.id, action: 'WITHDRAWN', reason: 'The initiative changed direction.' });
    expect(withdrawn.body.requestSnapshot.requestedConditions.comment).toBe('Initial scope.');
    expect(await dataSource!.query('SELECT removed_at FROM resource_requests WHERE id = $1', [created.id])).toEqual([
      expect.objectContaining({ removed_at: expect.any(Date) }),
    ]);
    expect(await dataSource!.query('SELECT action, reason, correlation_id FROM resource_request_audits WHERE request_id = $1', [created.id]))
      .toMatchObject([{ action: 'WITHDRAWN', reason: 'The initiative changed direction.', correlation_id: 'fdbef2f5-41e2-4f23-b3be-87f7162b8c29' }]);

    await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/requests')
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200)
      .expect((response) => expect(response.body.items).toHaveLength(0));
    await request(app!.getHttpServer())
      .get(`${path}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(404);

    const ownAudit = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/request-audits/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(ownAudit.body).toMatchObject({ requestId: created.id, events: [{ action: 'WITHDRAWN', reason: 'The initiative changed direction.' }] });
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/request-audits/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.other.localUserId)
      .expect(404);
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/request-audits/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);

    const line = await dataSource!.query('SELECT request_outcome FROM resource_submission_lines WHERE request_id = $1', [created.id]);
    expect(line[0].request_outcome).toMatchObject({ status: 'REMOVED', action: 'WITHDRAWN', reason: 'The initiative changed direction.' });
  });

  it('rejects removal and editing after a request leaves the presentation-waiting state', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture, fixture.requester.localUserId);
    await dataSource!.query("UPDATE resource_requests SET decision_state = 'PENDING_TEAM_DECISION' WHERE id = $1", [created.id]);
    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/requests/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .send({ comment: 'Too late.' })
      .expect(422);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${created.id}/withdrawals`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Too late.' })
      .expect(422);
    expect(await dataSource!.query('SELECT removed_at FROM resource_requests WHERE id = $1', [created.id]))
      .toEqual([{ removed_at: null }]);
    expect(await dataSource!.query('SELECT id FROM resource_request_audits WHERE request_id = $1', [created.id])).toHaveLength(0);
  });

  it('rejects waiting-request edits and withdrawal after the live database deadline has passed', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture, fixture.requester.localUserId);
    await dataSource!.query("UPDATE resource_requests SET expiration_due_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [created.id]);
    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/requests/${created.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .send({ comment: 'Past the deadline.' })
      .expect(422);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${created.id}/withdrawals`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Past the deadline.' })
      .expect(422);
    expect(await dataSource!.query('SELECT removed_at, version FROM resource_requests WHERE id = $1', [created.id]))
      .toEqual([{ removed_at: null, version: 1 }]);
    expect(await dataSource!.query('SELECT action FROM resource_request_history WHERE request_id = $1 ORDER BY occurred_at, id', [created.id]))
      .toEqual([{ action: 'SUBMITTED' }]);
    expect(await dataSource!.query('SELECT id FROM resource_request_audits WHERE request_id = $1', [created.id])).toHaveLength(0);
  });

  it('rolls back request removal, history, audit, and submission outcome together when audit persistence fails', async () => {
    const fixture = await setup();
    const created = await createRequest(fixture, fixture.requester.localUserId);
    const path = `/api/resource-allocation/v1/requests/${created.id}/withdrawals`;
    const idempotencyKey = randomUUID();
    await dataSource!.query(`
      CREATE FUNCTION fail_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test audit failure' USING ERRCODE = 'P0001'; END;
      $$
    `);
    await dataSource!.query(`
      CREATE TRIGGER fail_request_audit_before_insert
      BEFORE INSERT ON resource_request_audits
      FOR EACH ROW EXECUTE FUNCTION fail_request_audit()
    `);

    try {
      await request(app!.getHttpServer())
        .post(path)
        .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
        .set('If-Match', '"1"')
        .set('Idempotency-Key', idempotencyKey)
        .send({ reason: 'Cancel the request.' })
        .expect(500);
      expect(await dataSource!.query('SELECT removed_at FROM resource_requests WHERE id = $1', [created.id]))
        .toEqual([{ removed_at: null }]);
      expect(await dataSource!.query('SELECT id FROM resource_request_audits WHERE request_id = $1', [created.id])).toHaveLength(0);
      expect(await dataSource!.query("SELECT action FROM resource_request_history WHERE request_id = $1 ORDER BY occurred_at, id", [created.id]))
        .toEqual([{ action: 'SUBMITTED' }]);
      expect((await dataSource!.query('SELECT request_outcome FROM resource_submission_lines WHERE request_id = $1', [created.id]))[0].request_outcome)
        .toMatchObject({ decisionState: 'WAITING_FOR_PRESENTATION' });
    } finally {
      await dataSource!.query('DROP TRIGGER fail_request_audit_before_insert ON resource_request_audits');
      await dataSource!.query('DROP FUNCTION fail_request_audit()');
    }

    const withdrawn = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', idempotencyKey)
      .send({ reason: 'Cancel the request.' })
      .expect(200);
    expect(withdrawn.body.action).toBe('WITHDRAWN');
    const replay = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', idempotencyKey)
      .send({ reason: 'Cancel the request.' })
      .expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.id).toBe(withdrawn.body.id);
    expect(await dataSource!.query('SELECT id FROM resource_request_audits WHERE request_id = $1', [created.id])).toHaveLength(1);
  });
});
