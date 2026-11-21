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
import { ResourcePerson } from '../src/people/resource-person.entity';
import { ResourceAllocationRole } from '../src/people/resource-allocation-role';
import { ResourceGroup } from '../src/groups/resource-group.entity';
import { ResourceProfile } from '../src/resource-profiles/resource-profile.entity';
import { ResourceInitiative } from '../src/initiatives/resource-initiative.entity';
import { ResourceRequest } from '../src/requests/resource-request.entity';
import { ResourceRequestHistory } from '../src/requests/resource-request-history.entity';
import { ResourceSubmission } from '../src/submissions/resource-submission.entity';
import { ResourceSubmissionLine } from '../src/submissions/resource-submission-line.entity';

describe('Tech Resource Allocation request queues and referrals (#62)', () => {
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

  async function addPerson(
    localUserId: string,
    role: ResourceAllocationRole,
    groupId: string | null = null,
    coveredGroupIds: string[] = [],
  ) {
    const repository = dataSource!.getRepository(ResourcePerson);
    return repository.save(repository.create({
      localUserId,
      displayName: localUserId,
      email: `${localUserId}@example.test`,
      role,
      active: true,
      groupId,
      coveredGroupIds,
    }));
  }

  async function setup() {
    const admin = await addPerson('admin-a', ResourceAllocationRole.Admin);
    const unscopedAdmin = await addPerson('admin-unscoped', ResourceAllocationRole.Admin);
    const requesterA = await addPerson('requester-a', ResourceAllocationRole.User);
    const requesterB = await addPerson('requester-b', ResourceAllocationRole.User);
    const moderatorA = await addPerson('moderator-a', ResourceAllocationRole.Moderator);
    const moderatorB = await addPerson('moderator-b', ResourceAllocationRole.Moderator);
    const supervisorA = await addPerson('supervisor-a', ResourceAllocationRole.Supervisor);
    const supervisorB = await addPerson('supervisor-b', ResourceAllocationRole.Supervisor);
    const managerA = await addPerson('manager-a', ResourceAllocationRole.Manager);
    const managerB = await addPerson('manager-b', ResourceAllocationRole.Manager);
    const groups = dataSource!.getRepository(ResourceGroup);
    const groupA = await groups.save(groups.create({ name: 'Platform', active: true, supervisorId: supervisorA.id, managerId: managerA.id }));
    const groupB = await groups.save(groups.create({ name: 'Data', active: true, supervisorId: supervisorB.id, managerId: managerB.id }));
    const people = dataSource!.getRepository(ResourcePerson);
    admin.groupId = groupA.id;
    moderatorA.groupId = groupA.id;
    moderatorB.groupId = groupB.id;
    supervisorA.coveredGroupIds = [groupA.id];
    supervisorB.coveredGroupIds = [groupB.id];
    managerA.coveredGroupIds = [groupA.id];
    managerB.coveredGroupIds = [groupB.id];
    await people.save([admin, moderatorA, moderatorB, supervisorA, supervisorB, managerA, managerB]);

    const profileRepository = dataSource!.getRepository(ResourceProfile);
    const profileA = await profileRepository.save(profileRepository.create({ name: 'API', groupId: groupA.id, active: true }));
    const profileB = await profileRepository.save(profileRepository.create({ name: 'Analytics', groupId: groupB.id, active: true }));
    const initiatives = dataSource!.getRepository(ResourceInitiative);
    const initiative = await initiatives.save(initiatives.create({ code: 'ITDM-62', name: 'Resource allocation', active: true }));
    return { admin, unscopedAdmin, requesterA, requesterB, groupA, groupB, profileA, profileB, initiative, moderatorA, moderatorB, supervisorA, supervisorB, managerB };
  }

  async function createRequest(
    requester: ResourcePerson,
    group: ResourceGroup,
    profile: ResourceProfile,
    initiative: ResourceInitiative,
    options: { state?: string; receivedDaysAgo?: number; stageDaysAgo?: number } = {},
  ) {
    const correlationId = randomUUID();
    const submissions = dataSource!.getRepository(ResourceSubmission);
    const submission = await submissions.save(submissions.create({
      requesterId: requester.id,
      category: 'EXECUTION_PROJECT',
      lineCount: 1,
      correlationId,
    }));
    const lines = dataSource!.getRepository(ResourceSubmissionLine);
    const line = await lines.save(lines.create({
      submissionId: submission.id,
      requesterId: requester.id,
      attemptKey: randomUUID(),
      attemptPayloadHash: 'a'.repeat(64),
      lineNumber: 0,
      submittedConditions: {},
      status: 'RECEIVED' as never,
      requestId: null,
      problem: null,
      requestOutcome: null,
      claimToken: null,
      claimedAt: null,
      completedAt: null,
    }));
    const now = Date.now();
    const receivedAt = new Date(now - (options.receivedDaysAgo ?? 0) * 86_400_000);
    const stageEnteredAt = new Date(now - (options.stageDaysAgo ?? 0) * 86_400_000);
    const requestedConditions = {
      initiativeId: initiative.id,
      initiativeCode: initiative.code,
      initiativeName: initiative.name,
      category: 'EXECUTION_PROJECT',
      groupId: group.id,
      groupName: group.name,
      resourceProfileId: profile.id,
      resourceProfileName: profile.name,
      startDate: '2027-01-11',
      endDate: '2027-01-29',
      weeklyHours: 20,
      comment: 'Support delivery.',
    };
    const requests = dataSource!.getRepository(ResourceRequest);
    const resourceRequest = await requests.save(requests.create({
      submissionLineId: line.id,
      requesterId: requester.id,
      requesterSnapshot: { personId: requester.id, displayName: requester.displayName, role: requester.role },
      requestedConditions,
      decisionState: options.state ?? 'WAITING_FOR_PRESENTATION',
      receivedAt,
      stageEnteredAt,
      expirationDueAt: new Date(receivedAt.getTime() + 21 * 86_400_000),
      removedAt: null,
    }));
    await lines.update(line.id, {
      requestId: resourceRequest.id,
      status: 'SUCCEEDED' as never,
      completedAt: new Date(),
      requestOutcome: { decisionState: resourceRequest.decisionState, requestedConditions },
    });
    await dataSource!.getRepository(ResourceRequestHistory).insert({
      requestId: resourceRequest.id,
      actorSnapshot: { personId: requester.id, displayName: requester.displayName, role: requester.role },
      action: 'SUBMITTED',
      afterSnapshot: { requestId: resourceRequest.id, decisionState: resourceRequest.decisionState, requestedConditions },
      correlationId,
      occurredAt: receivedAt,
    });
    return resourceRequest;
  }

  it('lists due presentation work globally and excludes requests already removed from the operation', async () => {
    const fixture = await setup();
    const later = await createRequest(fixture.requesterA, fixture.groupA, fixture.profileA, fixture.initiative, { receivedDaysAgo: 3 });
    const earlier = await createRequest(fixture.requesterB, fixture.groupB, fixture.profileB, fixture.initiative, { receivedDaysAgo: 8 });
    const removed = await createRequest(fixture.requesterB, fixture.groupB, fixture.profileB, fixture.initiative);
    await dataSource!.getRepository(ResourceRequest).update(removed.id, { removedAt: new Date() });

    const response = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/presentation')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);

    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([earlier.id, later.id]);
    expect(response.body.items[0]).toMatchObject({
      decisionState: 'WAITING_FOR_PRESENTATION',
      dueAt: expect.any(String),
      nextResponsible: { role: 'ALLOCATION_ADMIN' },
      availableActions: ['REFER', 'REFERENCE_CORRECTION', 'ADMINISTRATIVE_REMOVE', 'APPROVE'],
    });

    const firstPage = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/presentation?limit=1')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(firstPage.body.items.map((item: { id: string }) => item.id)).toEqual([earlier.id]);
    expect(firstPage.body.page.nextCursor).toEqual(expect.any(String));
    const nextPage = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/request-queues/presentation?limit=1&cursor=${encodeURIComponent(firstPage.body.page.nextCursor)}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(nextPage.body.items.map((item: { id: string }) => item.id)).toEqual([later.id]);
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/request-queues/presentation?groupId=${fixture.groupA.id}&cursor=${encodeURIComponent(firstPage.body.page.nextCursor)}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(400);
  });

  it('limits leadership queues to the actor’s active scope, including an Admin’s assigned group', async () => {
    const fixture = await setup();
    const requestA = await createRequest(fixture.requesterA, fixture.groupA, fixture.profileA, fixture.initiative, { state: 'PENDING_TEAM_DECISION' });
    const requestB = await createRequest(fixture.requesterB, fixture.groupB, fixture.profileB, fixture.initiative, { state: 'PENDING_TEAM_DECISION' });

    const moderatorQueue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/team-decision')
      .set('X-PMO-Local-User-ID', fixture.moderatorA.localUserId)
      .expect(200);
    expect(moderatorQueue.body.items.map((item: { id: string }) => item.id)).toEqual([requestA.id]);

    const supervisorQueue = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/request-queues/team-decision?groupId=${fixture.groupA.id}`)
      .set('X-PMO-Local-User-ID', fixture.supervisorA.localUserId)
      .expect(200);
    expect(supervisorQueue.body.items.map((item: { id: string }) => item.id)).toEqual([requestA.id]);

    const managerQueue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/team-decision')
      .set('X-PMO-Local-User-ID', fixture.managerB.localUserId)
      .expect(200);
    expect(managerQueue.body.items.map((item: { id: string }) => item.id)).toEqual([requestB.id]);

    const adminQueue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/team-decision')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(adminQueue.body.items.map((item: { id: string }) => item.id)).toEqual([requestA.id]);
    expect(adminQueue.body.items[0].nextResponsible.map((person: { personId: string }) => person.personId)).toContain(fixture.admin.id);

    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/request-queues/team-decision?groupId=${fixture.groupB.id}`)
      .set('X-PMO-Local-User-ID', fixture.moderatorA.localUserId)
      .expect(403);
    await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/team-decision')
      .set('X-PMO-Local-User-ID', fixture.unscopedAdmin.localUserId)
      .expect(200)
      .expect((response) => expect(response.body.items).toEqual([]));
  });

  it('requires a current ETag and atomically refers a request with deduplicated leadership notices', async () => {
    const fixture = await setup();
    const groupAdmin = await addPerson('group-admin-b', ResourceAllocationRole.Admin, fixture.groupB.id);
    const resourceRequest = await createRequest(fixture.requesterB, fixture.groupB, fixture.profileB, fixture.initiative);
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/referrals`;
    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.moderatorB.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(403);
    expect(await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id }))
      .toMatchObject({ decisionState: 'WAITING_FOR_PRESENTATION', version: 1 });

    const missingVersion = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(missingVersion.body.code).toBe('VALIDATION_ERROR');

    const key = randomUUID();
    const first = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', key)
      .set('X-Correlation-ID', randomUUID())
      .send({})
      .expect(200);
    expect(first.headers.etag).toBe('"2"');
    expect(first.body).toMatchObject({ id: resourceRequest.id, decisionState: 'PENDING_TEAM_DECISION', version: 2 });

    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/requests/${resourceRequest.id}`)
      .set('X-PMO-Local-User-ID', fixture.requesterB.localUserId)
      .set('If-Match', '"2"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ comment: 'Changes are no longer permitted.' })
      .expect(422)
      .expect((response) => expect(response.body.code).toBe('INVALID_REQUEST_TRANSITION'));

    const replay = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', key)
      .send({})
      .expect('Idempotency-Replayed', 'true')
      .expect(200);
    expect(replay.body).toEqual(first.body);

    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(412);

    const queue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/team-decision')
      .set('X-PMO-Local-User-ID', fixture.managerB.localUserId)
      .expect(200);
    expect(queue.body.items.map((item: { id: string }) => item.id)).toContain(resourceRequest.id);
    const history = await dataSource!.getRepository(ResourceRequestHistory).find({ where: { requestId: resourceRequest.id }, order: { occurredAt: 'ASC' } });
    expect(history.map((event) => event.action)).toEqual(['SUBMITTED', 'REFERRED']);
    const notifications = await dataSource!.query(
      'SELECT recipient_id, event_code FROM resource_allocation_notifications WHERE source_request_id = $1 ORDER BY recipient_id',
      [resourceRequest.id],
    ) as Array<{ recipient_id: string; event_code: string }>;
    expect(notifications.map((notice) => notice.recipient_id).sort()).toEqual([fixture.managerB.id, fixture.moderatorB.id, fixture.supervisorB.id, groupAdmin.id].sort());
    expect(notifications.every((notice) => notice.event_code.startsWith('REQUEST_REFERRED'))).toBe(true);
  });

  it('rolls back a referral when a notice fails and retries it once with the same key', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requesterB, fixture.groupB, fixture.profileB, fixture.initiative);
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/referrals`;
    const key = randomUUID();
    await dataSource!.query(`
      CREATE FUNCTION fail_request_referral_notice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_code LIKE 'REQUEST_REFERRED_%' THEN
          RAISE EXCEPTION 'test referral notice failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await dataSource!.query(`
      CREATE TRIGGER fail_request_referral_notice_before_insert
      BEFORE INSERT ON resource_allocation_notifications
      FOR EACH ROW EXECUTE FUNCTION fail_request_referral_notice()
    `);

    try {
      await request(app!.getHttpServer())
        .post(path)
        .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
        .set('If-Match', '"1"')
        .set('Idempotency-Key', key)
        .send({})
        .expect(500);
      expect((await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id })))
        .toMatchObject({ decisionState: 'WAITING_FOR_PRESENTATION', version: 1 });
      expect(await dataSource!.query("SELECT action FROM resource_request_history WHERE request_id = $1 ORDER BY occurred_at, id", [resourceRequest.id]))
        .toEqual([{ action: 'SUBMITTED' }]);
      expect(await dataSource!.query("SELECT id FROM resource_allocation_operation_receipts WHERE operation = 'request.refer' AND idempotency_key = $1", [key]))
        .toHaveLength(0);
    } finally {
      await dataSource!.query('DROP TRIGGER fail_request_referral_notice_before_insert ON resource_allocation_notifications');
      await dataSource!.query('DROP FUNCTION fail_request_referral_notice()');
    }

    const retry = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', key)
      .send({})
      .expect(200);
    expect(retry.body).toMatchObject({ decisionState: 'PENDING_TEAM_DECISION', version: 2 });
    expect(await dataSource!.query("SELECT action FROM resource_request_history WHERE request_id = $1 ORDER BY occurred_at, id", [resourceRequest.id]))
      .toEqual([{ action: 'SUBMITTED' }, { action: 'REFERRED' }]);
    expect(await dataSource!.query("SELECT id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code LIKE 'REQUEST_REFERRED_%'", [resourceRequest.id]))
      .toHaveLength(3);
  });

  it('blocks waiting actions after the strict 21-day deadline even before automatic cleanup runs', async () => {
    const fixture = await setup();
    const referralRequest = await createRequest(fixture.requesterA, fixture.groupA, fixture.profileA, fixture.initiative, { receivedDaysAgo: 22 });
    const correctionRequest = await createRequest(fixture.requesterB, fixture.groupA, fixture.profileA, fixture.initiative, { receivedDaysAgo: 22 });
    const removalRequest = await createRequest(fixture.requesterB, fixture.groupB, fixture.profileB, fixture.initiative, { receivedDaysAgo: 22 });

    const queue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/presentation')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    const overdue = queue.body.items.find((item: { id: string }) => item.id === referralRequest.id);
    expect(overdue).toMatchObject({
      impediments: ['PRESENTATION_DEADLINE_PASSED'],
      availableActions: [],
    });

    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${referralRequest.id}/referrals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(422);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${correctionRequest.id}/reference-corrections`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ initiativeId: fixture.initiative.id, reason: 'The replacement has been confirmed.' })
      .expect(422);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${removalRequest.id}/administrative-removals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'The original request is no longer current.' })
      .expect(422);

    expect(await dataSource!.getRepository(ResourceRequest).find({ order: { id: 'ASC' } }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: referralRequest.id, decisionState: 'WAITING_FOR_PRESENTATION', version: 1, removedAt: null }),
        expect.objectContaining({ id: correctionRequest.id, decisionState: 'WAITING_FOR_PRESENTATION', version: 1, removedAt: null }),
        expect.objectContaining({ id: removalRequest.id, decisionState: 'WAITING_FOR_PRESENTATION', version: 1, removedAt: null }),
      ]));
    expect(await dataSource!.query("SELECT action FROM resource_request_history WHERE request_id IN ($1, $2, $3) ORDER BY request_id, occurred_at", [referralRequest.id, correctionRequest.id, removalRequest.id]))
      .toHaveLength(3);
    expect(await dataSource!.query("SELECT id FROM resource_request_audits WHERE request_id IN ($1, $2, $3)", [referralRequest.id, correctionRequest.id, removalRequest.id]))
      .toHaveLength(0);
    expect(await dataSource!.query("SELECT id FROM resource_allocation_notifications WHERE source_request_id IN ($1, $2, $3)", [referralRequest.id, correctionRequest.id, removalRequest.id]))
      .toHaveLength(0);
  });

  it('corrects eligible references in the presentation queue without resetting the waiting deadline', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requesterA, fixture.groupA, fixture.profileA, fixture.initiative, { receivedDaysAgo: 6 });
    const originalDeadline = resourceRequest.expirationDueAt.toISOString();
    const replacement = await dataSource!.getRepository(ResourceInitiative).save({ code: 'ITDM-62B', name: 'Replacement initiative', active: true, codeUsed: false });
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/reference-corrections`;

    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ groupId: fixture.groupB.id, reason: 'The old profile does not belong to this group.' })
      .expect(422);
    expect(await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id }))
      .toMatchObject({ requestedConditions: resourceRequest.requestedConditions, version: 1 });

    const response = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ initiativeId: replacement.id, groupId: fixture.groupB.id, resourceProfileId: fixture.profileB.id, reason: 'The original references are inactive.' })
      .expect(200);

    expect(response.headers.etag).toBe('"2"');
    expect(response.body).toMatchObject({
      decisionState: 'WAITING_FOR_PRESENTATION',
      receivedAt: resourceRequest.receivedAt.toISOString(),
      dueAt: originalDeadline,
      requestedConditions: {
        initiativeId: replacement.id,
        initiativeCode: replacement.code,
        groupId: fixture.groupB.id,
        resourceProfileId: fixture.profileB.id,
      },
    });
    const history = await dataSource!.getRepository(ResourceRequestHistory).find({ where: { requestId: resourceRequest.id }, order: { occurredAt: 'ASC' } });
    expect(history.map((event) => event.action)).toEqual(['SUBMITTED', 'REFERENCE_CORRECTED']);
    expect((await dataSource!.query('SELECT code_used FROM resource_initiatives WHERE id = $1', [replacement.id]))[0].code_used).toBe(true);
    expect((history[1].afterSnapshot as { before: { requestedConditions: Record<string, unknown> }; after: { requestedConditions: Record<string, unknown> } }).before.requestedConditions)
      .toEqual(resourceRequest.requestedConditions);
    expect((history[1].afterSnapshot as { after: { requestedConditions: Record<string, unknown> } }).after.requestedConditions.initiativeId).toBe(replacement.id);
  });

  it('soft-removes only another person’s waiting request and preserves its audit and submission outcome', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requesterA, fixture.groupA, fixture.profileA, fixture.initiative);
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/administrative-removals`;
    const response = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'The request was submitted by mistake.' })
      .expect(200);

    expect(response.body).toMatchObject({ requestId: resourceRequest.id, action: 'ADMIN_REMOVED', removedAt: expect.any(String) });
    expect(await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id })).toMatchObject({ removedAt: expect.any(Date), version: 2 });
    expect(await dataSource!.query('SELECT action, reason FROM resource_request_audits WHERE request_id = $1', [resourceRequest.id]))
      .toEqual([{ action: 'ADMIN_REMOVED', reason: 'The request was submitted by mistake.' }]);
    expect(await dataSource!.query('SELECT action FROM resource_request_history WHERE request_id = $1 ORDER BY occurred_at, id', [resourceRequest.id]))
      .toEqual([{ action: 'SUBMITTED' }, { action: 'ADMIN_REMOVED' }]);
    expect((await dataSource!.query('SELECT request_outcome FROM resource_submission_lines WHERE request_id = $1', [resourceRequest.id]))[0].request_outcome.status).toBe('REMOVED');
    expect((await dataSource!.query('SELECT recipient_id, event_code FROM resource_allocation_notifications WHERE source_request_id = $1', [resourceRequest.id]))[0])
      .toMatchObject({ recipient_id: fixture.requesterA.id, event_code: 'REQUEST_ADMIN_REMOVED' });
    await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/presentation')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200)
      .expect((queue) => expect(queue.body.items).toEqual([]));

    const ownRequest = await createRequest(fixture.admin, fixture.groupA, fixture.profileA, fixture.initiative);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${ownRequest.id}/administrative-removals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'I cannot remove my own request.' })
      .expect(403);
  });
});
