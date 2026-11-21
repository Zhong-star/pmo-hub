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
import { ResourceAllocation } from '../src/allocations/resource-allocation.entity';
import { ResourceSubmission } from '../src/submissions/resource-submission.entity';
import { ResourceSubmissionLine } from '../src/submissions/resource-submission-line.entity';
import { ResourceAllocationDecisionService } from '../src/decisions/resource-allocation-decision.service';
import { createResourceAllocationWorkerJobs } from '../src/workers/resource-allocation-worker-cycle';

describe('Tech Resource Allocation denials and exception resolution (#65/#66)', () => {
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

    const detail = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${resourceRequest.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(detail.body.availableActions).toEqual(['CONTEST', 'CANCEL']);

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

  it('lets the requester contest a changed proposal only before its 72-hour deadline, without creating an allocation', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture);
    const dueAt = new Date(Date.now() + 60_000);
    await dataSource!.getRepository(ResourceRequest).update(resourceRequest.id, {
      decisionState: 'APPROVED_WITH_CHANGES',
      version: 2,
      decisionResponseDueAt: dueAt,
      approvedConditions: {
        personId: fixture.moderator.id,
        groupId: fixture.group.id,
        initiativeId: fixture.initiative.id,
        resourceProfileId: fixture.profile.id,
        startDate: '2027-01-12',
        endDate: '2027-01-30',
        weeklyHours: 18,
      },
    });

    const response = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/contests`)
      .set(commandHeaders(fixture.requester.localUserId, 2))
      .send({ explanation: 'The proposed period conflicts with the initiative plan.' })
      .expect(200);

    expect(response.body).toMatchObject({ decisionState: 'PRE_N3', version: 3 });
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);
    expect(await dataSource!.query('SELECT recipient_id, event_code FROM resource_allocation_notifications WHERE source_request_id = $1', [resourceRequest.id]))
      .toEqual([{ recipient_id: fixture.admin.id, event_code: 'REQUEST_CONTESTED_3' }]);
    const expiredRequest = await createRequest(fixture);
    await dataSource!.getRepository(ResourceRequest).update(expiredRequest.id, {
      decisionState: 'APPROVED_WITH_CHANGES',
      version: 2,
      decisionResponseDueAt: new Date(Date.now() - 1_000),
      approvedConditions: {
        personId: fixture.moderator.id,
        groupId: fixture.group.id,
        initiativeId: fixture.initiative.id,
        resourceProfileId: fixture.profile.id,
        startDate: '2027-01-12',
        endDate: '2027-01-30',
        weeklyHours: 18,
      },
    });
    const expired = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${expiredRequest.id}/contests`)
      .set(commandHeaders(fixture.requester.localUserId, 2))
      .send({ explanation: 'A late contest must not alter the accepted proposal.' })
      .expect(422);
    expect(expired.body.code).toBe('PROPOSAL_RESPONSE_EXPIRED');
    expect(await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: expiredRequest.id }))
      .toMatchObject({ decisionState: 'APPROVED_WITH_CHANGES', version: 2 });
  });

  it('shows Pre N3 and Escalation in a global Admin queue with only current exception actions', async () => {
    const fixture = await setup();
    const preN3 = await createRequest(fixture, { state: 'PRE_N3' });
    const escalation = await createRequest(fixture, { state: 'ESCALATION' });
    const queuePath = '/api/resource-allocation/v1/request-queues/exceptions';

    const response = await request(app!.getHttpServer())
      .get(queuePath)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);

    expect(response.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: preN3.id, decisionState: 'PRE_N3', availableActions: ['ESCALATE', 'CANCEL', 'RECORD_STRATEGY', 'RESOLVE'] }),
      expect.objectContaining({ id: escalation.id, decisionState: 'ESCALATION', availableActions: ['CANCEL', 'RECORD_STRATEGY', 'RESOLVE'] }),
    ]));
    await request(app!.getHttpServer())
      .get(queuePath)
      .set('X-PMO-Local-User-ID', fixture.moderator.localUserId)
      .expect(403);
  });

  it('keeps an exception in its stage and reports distinct current eligibility impediments', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture, { state: 'PRE_N3' });
    await dataSource!.getRepository(ResourceRequest).update(resourceRequest.id, {
      approvedConditions: {
        personId: fixture.moderator.id,
        groupId: fixture.group.id,
        initiativeId: fixture.initiative.id,
        resourceProfileId: fixture.profile.id,
        startDate: '2027-01-12',
        endDate: '2027-01-30',
        weeklyHours: 18,
      },
    });
    await dataSource!.getRepository(ResourcePerson).update(fixture.moderator.id, { active: false });
    await dataSource!.getRepository(ResourceProfile).update(fixture.profile.id, { active: false });
    await dataSource!.getRepository(ResourceInitiative).update(fixture.initiative.id, { active: false });
    await dataSource!.getRepository(ResourceGroup).update(fixture.group.id, { active: false });

    const queue = await request(app!.getHttpServer()).get('/api/resource-allocation/v1/request-queues/exceptions')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(queue.body.items).toContainEqual(expect.objectContaining({
      id: resourceRequest.id,
      decisionState: 'PRE_N3',
      impediments: ['GROUP_INACTIVE', 'INITIATIVE_INACTIVE', 'PROFILE_INACTIVE', 'PERSON_INACTIVE'],
      availableActions: ['REFERENCE_CORRECTION', 'ESCALATE', 'CANCEL', 'RECORD_STRATEGY'],
    }));
  });

  it('requires a reasoned profile correction before resolving an exception with an inactive reference', async () => {
    const fixture = await setup();
    const item = await createRequest(fixture, { state: 'ESCALATION' });
    const profiles = dataSource!.getRepository(ResourceProfile);
    const replacement = await profiles.save({ name: 'Replacement', active: true, groupId: fixture.group.id });
    await request(app!.getHttpServer()).patch(`/api/resource-allocation/v1/admin/resource-profiles/${fixture.profile.id}`)
      .set(commandHeaders(fixture.admin.localUserId, fixture.profile.version))
      .set('Content-Type', 'application/merge-patch+json')
      .send({ active: false })
      .expect(200);

    const basePath = `/api/resource-allocation/v1/requests/${item.id}`;
    const final = {
      strategy: 'OUTSOURCE', reason: 'The provider confirmed capacity.',
      personId: fixture.moderator.id, resourceProfileId: replacement.id,
      startDate: '2027-01-12', endDate: '2027-01-30', weeklyHours: 16,
    };
    await request(app!.getHttpServer()).post(`${basePath}/resolutions`)
      .set(commandHeaders(fixture.admin.localUserId, item.version))
      .send(final)
      .expect(422);

    const corrected = await request(app!.getHttpServer()).post(`${basePath}/reference-corrections`)
      .set(commandHeaders(fixture.admin.localUserId, item.version))
      .send({ resourceProfileId: replacement.id, reason: 'Replace the inactive profile in the same group.' })
      .expect(200);
    expect(corrected.body.decisionState).toBe('ESCALATION');
    const history = await dataSource!.getRepository(ResourceRequestHistory).findBy({ requestId: item.id, action: 'REFERENCE_CORRECTED' });
    expect(history).toHaveLength(1);
    expect(history[0].afterSnapshot.reason).toBe('Replace the inactive profile in the same group.');
    const resolved = await request(app!.getHttpServer()).post(`${basePath}/resolutions`)
      .set(commandHeaders(fixture.admin.localUserId, corrected.body.version))
      .send(final)
      .expect(200);
    expect(resolved.body).toMatchObject({ decisionState: 'APPROVED', allocation: { weeklyHours: 16 } });
  });

  it('records the previous and replacement person while keeping the exception in Pre N3', async () => {
    const fixture = await setup();
    const item = await createRequest(fixture, { state: 'PRE_N3' });
    const people = dataSource!.getRepository(ResourcePerson);
    const replacement = await people.save({
      localUserId: 'replacement', displayName: 'Replacement', email: 'replacement@example.test',
      role: ResourceAllocationRole.User, active: true, coveredGroupIds: [], groupId: fixture.group.id,
    });
    const requests = dataSource!.getRepository(ResourceRequest);
    await requests.save({
      ...item,
      approvedConditions: { ...item.requestedConditions, personId: fixture.moderator.id },
    });
    await people.update(fixture.moderator.id, { active: false });
    const current = await requests.findOneByOrFail({ id: item.id });
    const reason = 'Replace the person who no longer has access.';
    const corrected = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${item.id}/reference-corrections`)
      .set(commandHeaders(fixture.admin.localUserId, current.version))
      .send({ personId: replacement.id, reason })
      .expect(200);
    expect(corrected.body.decisionState).toBe('PRE_N3');
    const history = await dataSource!.getRepository(ResourceRequestHistory).findBy({ requestId: item.id, action: 'REFERENCE_CORRECTED' });
    expect(history).toHaveLength(1);
    expect(history[0].afterSnapshot).toMatchObject({
      reason,
      before: { approvedConditions: { personId: fixture.moderator.id } },
      after: { approvedConditions: { personId: replacement.id } },
    });
  });

  it('records an Admin strategy without assigning a person or creating an allocation and replays it once', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture, { state: 'PRE_N3' });
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/strategies`;
    const key = randomUUID();
    const headers = commandHeaders(fixture.admin.localUserId, resourceRequest.version, key);
    const payload = { strategy: 'OUTSOURCE', reason: 'Use an external supplier while capacity is unavailable.' };

    const recorded = await request(app!.getHttpServer()).post(path).set(headers).send(payload).expect(200);
    expect(recorded.body).toMatchObject({ decisionState: 'PRE_N3', version: 2, resolutionStrategy: 'OUTSOURCE' });
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);
    const replay = await request(app!.getHttpServer()).post(path).set(headers).send(payload).expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const history = await dataSource!.getRepository(ResourceRequestHistory).findOneByOrFail({ requestId: resourceRequest.id, action: 'STRATEGY_RECORDED' });
    expect(history.afterSnapshot).toMatchObject({ resolutionStrategy: 'OUTSOURCE', reason: payload.reason });
    const queue = await request(app!.getHttpServer()).get('/api/resource-allocation/v1/request-queues/exceptions')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(queue.body.items).toContainEqual(expect.objectContaining({ id: resourceRequest.id, resolutionStrategy: 'OUTSOURCE' }));
    await dataSource!.getRepository(ResourcePerson).update(fixture.admin.id, { role: ResourceAllocationRole.User });
    await request(app!.getHttpServer()).post(path).set(headers).send(payload).expect(403);
    expect(await dataSource!.getRepository(ResourceRequestHistory).find({ where: { requestId: resourceRequest.id, action: 'STRATEGY_RECORDED' } }))
      .toHaveLength(1);
  });

  it('lets only a non-requester Admin load request-specific candidates for a global exception', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture, { state: 'PRE_N3' });
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/approval-candidates`;

    const candidates = await request(app!.getHttpServer())
      .get(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(candidates.body.items).toContainEqual({ id: fixture.moderator.id, displayName: fixture.moderator.displayName, groupId: fixture.group.id });
    await request(app!.getHttpServer())
      .get(path)
      .set('X-PMO-Local-User-ID', fixture.moderator.localUserId)
      .expect(403);

    const ownException = await createRequest(fixture, { state: 'PRE_N3', requester: fixture.admin });
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${ownException.id}/approval-candidates`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(403);
  });

  it('resolves a Deprioritize exception once with a final allocation and leaves unrelated allocations unchanged', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture, { state: 'PRE_N3' });
    const otherRequest = await createRequest(fixture);
    const allocations = dataSource!.getRepository(ResourceAllocation);
    const unrelated = await allocations.save(allocations.create({
      sourceRequestId: otherRequest.id,
      personId: fixture.moderator.id,
      personSnapshot: { personId: fixture.moderator.id, displayName: fixture.moderator.displayName, role: fixture.moderator.role },
      groupId: fixture.group.id,
      groupSnapshot: { id: fixture.group.id, name: fixture.group.name },
      initiativeId: fixture.initiative.id,
      initiativeSnapshot: { id: fixture.initiative.id, code: fixture.initiative.code, name: fixture.initiative.name },
      resourceProfileId: fixture.profile.id,
      resourceProfileSnapshot: { id: fixture.profile.id, name: fixture.profile.name },
      approvedStartDate: '2027-01-01',
      approvedEndDate: '2027-01-31',
      effectiveStartDate: '2027-01-01',
      effectiveEndDate: '2027-01-31',
      weeklyHours: '12.0',
      state: 'SUSPENDED',
      stateEnteredAt: new Date(),
      approvedAt: new Date(),
    }));
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/resolutions`;
    const key = randomUUID();
    const headers = commandHeaders(fixture.admin.localUserId, resourceRequest.version, key);
    const payload = {
      strategy: 'DEPRIORITIZE_OTHER_DEMANDS',
      reason: 'Make room by deprioritizing these ITDMs while protecting the committed allocation.',
      affectedInitiativeIds: [fixture.initiative.id],
      personId: fixture.moderator.id,
      resourceProfileId: fixture.profile.id,
      startDate: '2027-01-12',
      endDate: '2027-01-30',
      weeklyHours: 16.25,
    };

    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/strategies`)
      .set(commandHeaders(fixture.admin.localUserId, resourceRequest.version))
      .send({ strategy: 'DEPRIORITIZE_OTHER_DEMANDS', reason: 'This strategy needs an explicit ITDM list.' })
      .expect(400);
    const inactivePerson = await dataSource!.getRepository(ResourcePerson).save({
      localUserId: 'inactive-resolution-candidate', displayName: 'Inactive Candidate', email: 'inactive@example.test',
      role: ResourceAllocationRole.User, active: false, coveredGroupIds: [], groupId: fixture.group.id,
    });
    await request(app!.getHttpServer())
      .post(path)
      .set(commandHeaders(fixture.admin.localUserId, resourceRequest.version))
      .send({ ...payload, personId: inactivePerson.id })
      .expect(422);
    await request(app!.getHttpServer())
      .post(path)
      .set({ ...commandHeaders(fixture.admin.localUserId, 99), 'If-Match': '"99"' })
      .send(payload)
      .expect(412);
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);

    const resolved = await request(app!.getHttpServer()).post(path).set(headers).send(payload).expect(200);
    expect(resolved.body).toMatchObject({
      decisionState: 'APPROVED',
      resolutionStrategy: 'DEPRIORITIZE_OTHER_DEMANDS',
      affectedInitiativeIds: [fixture.initiative.id],
      approvedConditions: { weeklyHours: 16.3, resolutionStrategy: 'DEPRIORITIZE_OTHER_DEMANDS' },
      allocation: { person: { personId: fixture.moderator.id }, weeklyHours: 16.3 },
    });
    const replay = await request(app!.getHttpServer()).post(path).set(headers).send(payload).expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.headers.etag).toBeUndefined();
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(1);
    expect(await allocations.findOneByOrFail({ id: unrelated.id })).toMatchObject({ state: 'SUSPENDED', effectiveEndDate: '2027-01-31', weeklyHours: '12.0' });
    const history = await dataSource!.getRepository(ResourceRequestHistory).find({ where: { requestId: resourceRequest.id, action: 'EXCEPTION_RESOLVED' } });
    expect(history).toHaveLength(1);
    expect(history[0].afterSnapshot).toMatchObject({ reason: payload.reason, resolutionStrategy: payload.strategy, affectedInitiativeIds: payload.affectedInitiativeIds });
    expect(await dataSource!.query('SELECT recipient_id, event_code FROM resource_allocation_notifications WHERE source_request_id = $1 ORDER BY recipient_id', [resourceRequest.id]))
      .toEqual([
        { recipient_id: fixture.moderator.id, event_code: `REQUEST_EXCEPTION_RESOLVED_${resourceRequest.version + 1}` },
        { recipient_id: fixture.requester.id, event_code: `REQUEST_EXCEPTION_RESOLVED_${resourceRequest.version + 1}` },
      ].sort((a, b) => a.recipient_id.localeCompare(b.recipient_id)));

    const ownRequest = await createRequest(fixture, { state: 'PRE_N3', requester: fixture.admin });
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${ownRequest.id}/resolutions`)
      .set(commandHeaders(fixture.admin.localUserId, ownRequest.version))
      .send({
        strategy: 'OUTSOURCE',
        reason: 'A person cannot resolve their own request.',
        personId: fixture.moderator.id,
        resourceProfileId: fixture.profile.id,
        startDate: '2027-01-12',
        endDate: '2027-01-30',
        weeklyHours: 12,
      })
      .expect(403);
  });

  it('requires an Admin reason to escalate or cancel, replays after state changes, and blocks self-resolution', async () => {
    const fixture = await setup();
    const otherAdmin = await dataSource!.getRepository(ResourcePerson).save({
      localUserId: 'decision-observer-admin', displayName: 'Observer Admin', email: 'observer@example.test',
      role: ResourceAllocationRole.Admin, active: true, coveredGroupIds: [], groupId: null,
    });
    const resourceRequest = await createRequest(fixture, { state: 'PRE_N3' });
    const escalationPath = `/api/resource-allocation/v1/requests/${resourceRequest.id}/escalations`;
    const escalationKey = randomUUID();
    const escalationHeaders = commandHeaders(fixture.admin.localUserId, resourceRequest.version, escalationKey);
    const escalationBody = { reason: 'The contested request needs an executive decision.' };
    const escalated = await request(app!.getHttpServer()).post(escalationPath).set(escalationHeaders).send(escalationBody).expect(200);
    expect(escalated.body).toMatchObject({ decisionState: 'ESCALATION', version: 2 });
    const escalationReplay = await request(app!.getHttpServer()).post(escalationPath).set(escalationHeaders).send(escalationBody).expect(200);
    expect(escalationReplay.headers['idempotency-replayed']).toBe('true');
    expect(await dataSource!.query('SELECT recipient_id, event_code FROM resource_allocation_notifications WHERE source_request_id = $1', [resourceRequest.id]))
      .toEqual([{ recipient_id: otherAdmin.id, event_code: 'REQUEST_EXCEPTION_ESCALATED_2' }]);

    const cancellationPath = `/api/resource-allocation/v1/requests/${resourceRequest.id}/cancellations`;
    const cancellationKey = randomUUID();
    const cancellationHeaders = commandHeaders(fixture.admin.localUserId, 2, cancellationKey);
    const cancellationBody = { reason: 'The sponsor withdrew the request.' };
    const cancelled = await request(app!.getHttpServer()).post(cancellationPath).set(cancellationHeaders).send(cancellationBody).expect(200);
    expect(cancelled.body).toMatchObject({ decisionState: 'CANCELLED', version: 3 });
    const cancellationReplay = await request(app!.getHttpServer()).post(cancellationPath).set(cancellationHeaders).send(cancellationBody).expect(200);
    expect(cancellationReplay.headers['idempotency-replayed']).toBe('true');

    const ownRequest = await createRequest(fixture, { state: 'PRE_N3', requester: fixture.admin });
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${ownRequest.id}/escalations`)
      .set(commandHeaders(fixture.admin.localUserId, ownRequest.version))
      .send({ reason: 'A person cannot resolve their own request.' })
      .expect(403);
  });

  it('rolls back resolution, allocation, history, notice, and receipt if a required notice cannot be persisted', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture, { state: 'PRE_N3' });
    const key = randomUUID();
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/resolutions`;
    await dataSource!.query(`
      CREATE FUNCTION fail_resource_request_exception_notice() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced exception-resolution notice failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await dataSource!.query(`
      CREATE TRIGGER fail_resource_request_exception_notice_trigger
      BEFORE INSERT ON resource_allocation_notifications
      FOR EACH ROW WHEN (NEW.event_code LIKE 'REQUEST_EXCEPTION_RESOLVED_%')
      EXECUTE FUNCTION fail_resource_request_exception_notice()
    `);
    try {
      await request(app!.getHttpServer())
        .post(path)
        .set(commandHeaders(fixture.admin.localUserId, resourceRequest.version, key))
        .send({
          strategy: 'WAIT_FOR_EMB_RESOURCE',
          reason: 'Keep the demand in the approved capacity window.',
          personId: fixture.moderator.id,
          resourceProfileId: fixture.profile.id,
          startDate: '2027-01-12',
          endDate: '2027-01-30',
          weeklyHours: 12,
        })
        .expect(500);
    } finally {
      await dataSource!.query('DROP TRIGGER fail_resource_request_exception_notice_trigger ON resource_allocation_notifications');
      await dataSource!.query('DROP FUNCTION fail_resource_request_exception_notice()');
    }

    expect(await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id }))
      .toMatchObject({ decisionState: 'PRE_N3', version: resourceRequest.version, approvedConditions: null });
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);
    expect(await dataSource!.query('SELECT id FROM resource_request_history WHERE request_id = $1 AND action = $2', [resourceRequest.id, 'EXCEPTION_RESOLVED'])).toHaveLength(0);
    expect(await dataSource!.query(
      "SELECT id FROM resource_allocation_operation_receipts WHERE actor_id = $1 AND operation = 'request.exception.resolve' AND idempotency_key = $2",
      [fixture.admin.id, key],
    )).toHaveLength(0);
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
      processProposalDeadlines: async () => 0,
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

  it('serializes decision body and history query DTO validation failures into RFC 9457 errors[]', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture);

    const invalidQuery = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${resourceRequest.id}/history?limit=101`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(invalidQuery.body.errors).toEqual([{ path: 'limit', code: 'MAX', message: expect.any(String) }]);

    const invalidBody = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/denials`)
      .set(commandHeaders(fixture.moderator.localUserId, 1))
      .send({ explanation: 123 })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(invalidBody.body.errors).toEqual(expect.arrayContaining([
      { path: 'explanation', code: 'IS_STRING', message: expect.any(String) },
    ]));
  });
});
