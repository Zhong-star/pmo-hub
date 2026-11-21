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
import { ResourceRequest } from '../src/requests/resource-request.entity';
import { ResourceRequestHistory } from '../src/requests/resource-request-history.entity';
import { ResourceSubmission } from '../src/submissions/resource-submission.entity';
import { ResourceSubmissionLine } from '../src/submissions/resource-submission-line.entity';
import { ResourceAllocationDecisionService } from '../src/decisions/resource-allocation-decision.service';
import { createResourceAllocationWorkerJobs } from '../src/workers/resource-allocation-worker-cycle';

describe('Tech Resource Allocation denials and responses (#65)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_decisions_test')
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
    const requester = await people.save(people.create({
      localUserId: 'decision-requester', displayName: 'Request Owner', email: 'owner@example.test',
      role: ResourceAllocationRole.User, active: true, coveredGroupIds: [], groupId: null,
    }));
    const moderator = await people.save(people.create({
      localUserId: 'decision-moderator', displayName: 'Group Moderator', email: 'moderator@example.test',
      role: ResourceAllocationRole.Moderator, active: true, coveredGroupIds: [], groupId: null,
    }));
    const admin = await people.save(people.create({
      localUserId: 'decision-admin', displayName: 'Module Admin', email: 'admin@example.test',
      role: ResourceAllocationRole.Admin, active: true, coveredGroupIds: [], groupId: null,
    }));
    const supervisor = await people.save(people.create({
      localUserId: 'decision-supervisor', displayName: 'Group Supervisor', email: 'supervisor@example.test',
      role: ResourceAllocationRole.Supervisor, active: true, coveredGroupIds: [], groupId: null,
    }));
    const manager = await people.save(people.create({
      localUserId: 'decision-manager', displayName: 'Group Manager', email: 'manager@example.test',
      role: ResourceAllocationRole.Manager, active: true, coveredGroupIds: [], groupId: null,
    }));
    const groupRepository = dataSource!.getRepository(ResourceGroup);
    const group = await groupRepository.save(groupRepository.create({ name: 'Engineering', active: true, supervisorId: supervisor.id, managerId: manager.id }));
    moderator.groupId = group.id;
    admin.groupId = group.id;
    supervisor.coveredGroupIds = [group.id];
    manager.coveredGroupIds = [group.id];
    await people.save([moderator, admin, supervisor, manager]);
    const profile = await dataSource!.getRepository(ResourceProfile).save({ name: 'Developer', active: true, groupId: group.id });
    const initiative = await dataSource!.getRepository(ResourceInitiative).save({ code: `ITDM-${randomUUID().slice(0, 8)}`, name: 'Resource request initiative', active: true });
    return { requester, moderator, admin, supervisor, manager, group, profile, initiative };
  }

  async function createRequest(
    fixture: Awaited<ReturnType<typeof setup>>,
    options: { state?: string; deniedDaysAgo?: number; requester?: ResourcePerson } = {},
  ) {
    const owner = options.requester ?? fixture.requester;
    const correlationId = randomUUID();
    const submission = await dataSource!.getRepository(ResourceSubmission).save({
      requesterId: owner.id,
      category: 'EXECUTION_PROJECT',
      lineCount: 1,
      correlationId,
    });
    const line = await dataSource!.getRepository(ResourceSubmissionLine).save({
      submissionId: submission.id,
      requesterId: owner.id,
      attemptKey: randomUUID(),
      attemptPayloadHash: 'b'.repeat(64),
      lineNumber: 0,
      submittedConditions: {},
      status: 'RECEIVED' as never,
      requestId: null,
      problem: null,
      requestOutcome: null,
      claimToken: null,
      claimedAt: null,
      completedAt: null,
    });
    const now = new Date();
    const deniedAt = new Date(now.getTime() - (options.deniedDaysAgo ?? 0) * 86_400_000);
    const receivedAt = options.deniedDaysAgo === undefined ? now : new Date(deniedAt.getTime() - 86_400_000);
    const requestedConditions = {
      initiativeId: fixture.initiative.id,
      initiativeCode: fixture.initiative.code,
      initiativeName: fixture.initiative.name,
      category: 'EXECUTION_PROJECT',
      groupId: fixture.group.id,
      groupName: fixture.group.name,
      resourceProfileId: fixture.profile.id,
      resourceProfileName: fixture.profile.name,
      startDate: '2027-01-11',
      endDate: '2027-01-29',
      weeklyHours: 20,
    };
    const resourceRequest = await dataSource!.getRepository(ResourceRequest).save({
      submissionLineId: line.id,
      requesterId: owner.id,
      requesterSnapshot: { personId: owner.id, displayName: owner.displayName, role: owner.role },
      requestedConditions,
      decisionState: options.state ?? 'PENDING_TEAM_DECISION',
      receivedAt,
      stageEnteredAt: options.deniedDaysAgo === undefined ? now : deniedAt,
      expirationDueAt: new Date((options.deniedDaysAgo === undefined ? now : deniedAt).getTime() + (options.state === 'DENIED' ? 14 : 21) * 86_400_000),
      removedAt: null,
      ...(options.state === 'DENIED' ? { version: 2 } : {}),
    });
    await dataSource!.getRepository(ResourceRequestHistory).insert({
      requestId: resourceRequest.id,
      actorSnapshot: { personId: owner.id, displayName: owner.displayName, role: owner.role },
      action: 'SUBMITTED',
      afterSnapshot: { requestId: resourceRequest.id, decisionState: resourceRequest.decisionState, requestedConditions },
      correlationId,
      occurredAt: receivedAt,
    });
    if (options.deniedDaysAgo !== undefined) {
      const before = { decisionState: 'PENDING_TEAM_DECISION' };
      await dataSource!.getRepository(ResourceRequestHistory).insert({
        requestId: resourceRequest.id,
        actorSnapshot: { personId: fixture.moderator.id, displayName: fixture.moderator.displayName, role: fixture.moderator.role },
        action: 'DENIED',
        afterSnapshot: { before, after: { decisionState: 'DENIED' }, reason: 'The requested capacity is unavailable.' },
        correlationId,
        occurredAt: deniedAt,
      });
    }
    return resourceRequest;
  }

  function commandHeaders(localUserId: string, version: number, key = randomUUID()) {
    return {
      'X-PMO-Local-User-ID': localUserId,
      'X-Correlation-ID': randomUUID(),
      'If-Match': `"${version}"`,
      'Idempotency-Key': key,
    };
  }

  it('lets an in-scope non-requester deny a request, shows the reason to its owner, and notifies only that owner', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture);
    const denialPath = `/api/resource-allocation/v1/requests/${resourceRequest.id}/denials`;
    const denied = await request(app!.getHttpServer())
      .post(denialPath)
      .set(commandHeaders(fixture.moderator.localUserId, 1))
      .send({ explanation: 'The project cannot be staffed in the requested period.' })
      .expect(200);

    expect(denied.headers.etag).toBe('"2"');
    expect(denied.body).toMatchObject({ id: resourceRequest.id, decisionState: 'DENIED', version: 2 });

    const history = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${resourceRequest.id}/history`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(history.body.items).toContainEqual(expect.objectContaining({
      action: 'DENIED',
      reason: 'The project cannot be staffed in the requested period.',
    }));

    expect(await dataSource!.query('SELECT recipient_id, event_code FROM resource_allocation_notifications WHERE source_request_id = $1', [resourceRequest.id]))
      .toEqual([{ recipient_id: fixture.requester.id, event_code: 'REQUEST_DENIED_2' }]);
  });

  it('replays a denial once, rejects stale versions, and prevents self or out-of-scope decisions', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture);
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/denials`;
    const key = randomUUID();

    await request(app!.getHttpServer())
      .post(path)
      .set({ ...commandHeaders(fixture.moderator.localUserId, 1, key), 'If-Match': '"8"' })
      .send({ explanation: 'Capacity is unavailable.' })
      .expect(412);
    await request(app!.getHttpServer())
      .post(path)
      .set(commandHeaders(fixture.moderator.localUserId, 1, key))
      .send({ explanation: 'Capacity is unavailable.' })
      .expect(200);
    const replay = await request(app!.getHttpServer())
      .post(path)
      .set(commandHeaders(fixture.moderator.localUserId, 1, key))
      .send({ explanation: 'Capacity is unavailable.' })
      .expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    await request(app!.getHttpServer())
      .post(path)
      .set(commandHeaders(fixture.moderator.localUserId, 1, key))
      .send({ explanation: 'Different explanation.' })
      .expect(409);

    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/denials`)
      .set(commandHeaders(fixture.requester.localUserId, 2))
      .send({ explanation: 'I am the requester.' })
      .expect(403);
    expect(await dataSource!.query("SELECT action FROM resource_request_history WHERE request_id = $1 AND action = 'DENIED'", [resourceRequest.id]))
      .toHaveLength(1);
    expect(await dataSource!.query('SELECT recipient_id FROM resource_allocation_notifications WHERE source_request_id = $1', [resourceRequest.id]))
      .toEqual([{ recipient_id: fixture.requester.id }]);
  });

  it('rechecks the actor’s active decision scope before replaying a denial receipt', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture);
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/denials`;
    const key = randomUUID();
    const payload = { explanation: 'The current group cannot support the requested period.' };
    await request(app!.getHttpServer())
      .post(path)
      .set(commandHeaders(fixture.moderator.localUserId, 1, key))
      .send(payload)
      .expect(200);

    await dataSource!.getRepository(ResourcePerson).update(fixture.moderator.id, { groupId: null });
    await request(app!.getHttpServer())
      .post(path)
      .set(commandHeaders(fixture.moderator.localUserId, 1, key))
      .send(payload)
      .expect(403);
    expect(await dataSource!.query("SELECT action FROM resource_request_history WHERE request_id = $1 AND action = 'DENIED'", [resourceRequest.id]))
      .toHaveLength(1);
  });

  it('prevents a decision maker, including an Admin, from denying their own request', async () => {
    const fixture = await setup();
    const moderatorRequest = await createRequest(fixture, { requester: fixture.moderator });
    const adminRequest = await createRequest(fixture, { requester: fixture.admin, state: 'WAITING_FOR_PRESENTATION' });

    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${moderatorRequest.id}/denials`)
      .set(commandHeaders(fixture.moderator.localUserId, moderatorRequest.version))
      .send({ explanation: 'A person cannot decide their own request.' })
      .expect(403);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${adminRequest.id}/denials`)
      .set(commandHeaders(fixture.admin.localUserId, adminRequest.version))
      .send({ explanation: 'An Admin cannot decide their own request.' })
      .expect(403);
  });

  it('lets the requester contest a denial before the strict 14-day deadline and notifies active Admins', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture, { state: 'DENIED', deniedDaysAgo: 13 });
    await dataSource!.query('UPDATE resource_requests SET expiration_due_at = clock_timestamp() + INTERVAL \'1 second\' WHERE id = $1', [resourceRequest.id]);

    const response = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/contests`)
      .set(commandHeaders(fixture.requester.localUserId, resourceRequest.version))
      .send({ explanation: 'The new scope can be reduced to fit the available capacity.' })
      .expect(200);

    expect(response.body).toMatchObject({ decisionState: 'PRE_N3', version: resourceRequest.version + 1 });
    const history = await dataSource!.getRepository(ResourceRequestHistory).find({ where: { requestId: resourceRequest.id }, order: { occurredAt: 'ASC', id: 'ASC' } });
    expect(history.map((event) => event.action)).toEqual(['SUBMITTED', 'DENIED', 'CONTESTED']);
    expect((history[2].afterSnapshot as { reason: string }).reason).toBe('The new scope can be reduced to fit the available capacity.');
    expect(await dataSource!.query('SELECT recipient_id, event_code FROM resource_allocation_notifications WHERE source_request_id = $1 ORDER BY recipient_id', [resourceRequest.id]))
      .toEqual([{ recipient_id: fixture.admin.id, event_code: `REQUEST_CONTESTED_${resourceRequest.version + 1}` }]);
  });

  it('rejects a contest after more than 14 days with a stable deadline code', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture, { state: 'DENIED', deniedDaysAgo: 15 });

    const response = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/contests`)
      .set(commandHeaders(fixture.requester.localUserId, resourceRequest.version))
      .send({ explanation: 'I would like another review.' })
      .expect(422);

    expect(response.body.code).toBe('DENIAL_RESPONSE_EXPIRED');
    expect(await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id }))
      .toMatchObject({ decisionState: 'DENIED', version: resourceRequest.version });
  });

  it('cancels a denial explicitly with a reason and retains the original denial explanation', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture, { state: 'DENIED', deniedDaysAgo: 4 });
    const response = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/cancellations`)
      .set(commandHeaders(fixture.requester.localUserId, resourceRequest.version))
      .send({ reason: 'The initiative was paused by its sponsor.' })
      .expect(200);

    expect(response.body).toMatchObject({ decisionState: 'CANCELLED', version: resourceRequest.version + 1 });
    const history = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${resourceRequest.id}/history`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(history.body.items).toContainEqual(expect.objectContaining({ action: 'DENIED', reason: 'The requested capacity is unavailable.' }));
    expect(history.body.items).toContainEqual(expect.objectContaining({ action: 'DENIAL_CANCELLED', reason: 'The initiative was paused by its sponsor.' }));
  });

  it('automatically cancels only a denial strictly past its 14-day deadline and never duplicates the effect', async () => {
    const fixture = await setup();
    const requestNearDeadline = await createRequest(fixture, { state: 'DENIED', deniedDaysAgo: 13 });
    await dataSource!.query('UPDATE resource_requests SET expiration_due_at = clock_timestamp() + INTERVAL \'1 second\' WHERE id = $1', [requestNearDeadline.id]);
    const decisions = app!.get(ResourceAllocationDecisionService);
    const jobs = createResourceAllocationWorkerJobs({
      processSubmissions: async () => 0,
      processWaitingDeadlines: async () => 0,
      expireDeniedRequests: () => decisions.expireDeniedRequests(),
    });
    const deniedDeadlineJob = jobs.find((job) => job.name === 'denied response deadline');
    expect(deniedDeadlineJob).toBeDefined();
    expect(await deniedDeadlineJob!.runBatch()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await deniedDeadlineJob!.runBatch()).toBe(1);
    expect(await deniedDeadlineJob!.runBatch()).toBe(0);

    const saved = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: requestNearDeadline.id });
    expect(saved.decisionState).toBe('CANCELLED');
    const events = await dataSource!.getRepository(ResourceRequestHistory).find({ where: { requestId: saved.id }, order: { occurredAt: 'ASC', id: 'ASC' } });
    expect(events.filter((event) => event.action === 'DENIAL_AUTO_CANCELLED')).toHaveLength(1);
    expect((events.at(-1)?.afterSnapshot as { reason: string; automatic: boolean })).toMatchObject({
      reason: 'Automatic cancellation: no response within 14 days of the denial.',
      automatic: true,
    });
    const notices = await dataSource!.query('SELECT recipient_id, event_code FROM resource_allocation_notifications WHERE source_request_id = $1', [saved.id]);
    expect(notices).toHaveLength(5);
    expect(notices).toContainEqual({ recipient_id: fixture.requester.id, event_code: `REQUEST_DENIAL_EXPIRED_${saved.version}` });
  });

  it('does not expire requests in Pending or Pre N3 even after their old deadlines', async () => {
    const fixture = await setup();
    const pending = await createRequest(fixture, { state: 'PENDING_TEAM_DECISION' });
    const contested = await createRequest(fixture, { state: 'PRE_N3' });
    await dataSource!.query("UPDATE resource_requests SET expiration_due_at = clock_timestamp() - INTERVAL '30 days' WHERE id = ANY($1::uuid[])", [[pending.id, contested.id]]);

    const decisions = app!.get(ResourceAllocationDecisionService);
    expect(await decisions.expireDeniedRequests()).toBe(0);
    expect(await dataSource!.getRepository(ResourceRequest).findBy({ id: pending.id })).toMatchObject([{ decisionState: 'PENDING_TEAM_DECISION' }]);
    expect(await dataSource!.getRepository(ResourceRequest).findBy({ id: contested.id })).toMatchObject([{ decisionState: 'PRE_N3' }]);
    expect(await dataSource!.query('SELECT id FROM resource_allocation_notifications WHERE source_request_id = ANY($1::uuid[])', [[pending.id, contested.id]]))
      .toHaveLength(0);
  });

  it('rolls back the denial, history, notice, and receipt when notification persistence fails', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture);
    const key = randomUUID();
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/denials`;
    await dataSource!.query(`
      CREATE FUNCTION fail_resource_request_denial_notice() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced notification write failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await dataSource!.query(`
      CREATE TRIGGER fail_resource_request_denial_notice_trigger
      BEFORE INSERT ON resource_allocation_notifications
      FOR EACH ROW WHEN (NEW.event_code LIKE 'REQUEST_DENIED_%')
      EXECUTE FUNCTION fail_resource_request_denial_notice()
    `);
    try {
      await request(app!.getHttpServer())
        .post(path)
        .set(commandHeaders(fixture.moderator.localUserId, 1, key))
        .send({ explanation: 'Capacity is fully committed.' })
        .expect(500);
    } finally {
      await dataSource!.query('DROP TRIGGER IF EXISTS fail_resource_request_denial_notice_trigger ON resource_allocation_notifications');
      await dataSource!.query('DROP FUNCTION IF EXISTS fail_resource_request_denial_notice()');
    }

    expect(await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id }))
      .toMatchObject({ decisionState: 'PENDING_TEAM_DECISION', version: 1 });
    expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'DENIED'", [resourceRequest.id]))
      .toHaveLength(0);
    expect(await dataSource!.query('SELECT id FROM resource_allocation_notifications WHERE source_request_id = $1', [resourceRequest.id]))
      .toHaveLength(0);
    expect(await dataSource!.query("SELECT id FROM resource_allocation_operation_receipts WHERE actor_id = $1 AND operation = 'request.deny' AND idempotency_key = $2", [fixture.moderator.id, key]))
      .toHaveLength(0);

    await request(app!.getHttpServer())
      .post(path)
      .set(commandHeaders(fixture.moderator.localUserId, 1, key))
      .send({ explanation: 'Capacity is fully committed.' })
      .expect(200);
    expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'DENIED'", [resourceRequest.id]))
      .toHaveLength(1);
    expect(await dataSource!.query('SELECT id FROM resource_allocation_notifications WHERE source_request_id = $1', [resourceRequest.id]))
      .toHaveLength(1);
  });
});
