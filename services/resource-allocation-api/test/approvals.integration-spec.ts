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
import { ResourceAllocationProposalWorker } from '../src/deadlines/resource-allocation-proposal.worker';
import { ResourceAllocationApprovalService } from '../src/approvals/resource-allocation-approval.service';

describe('Tech Resource Allocation approvals and proposals (#63–#64)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_approvals_test')
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

  async function addPerson(localUserId: string, role: ResourceAllocationRole, groupId: string | null = null) {
    const repository = dataSource!.getRepository(ResourcePerson);
    return repository.save(repository.create({
      localUserId,
      displayName: localUserId,
      email: `${localUserId}@example.test`,
      role,
      active: true,
      groupId,
      coveredGroupIds: [],
    }));
  }

  async function setup() {
    const admin = await addPerson('admin', ResourceAllocationRole.Admin);
    const requester = await addPerson('requester', ResourceAllocationRole.User);
    const assignee = await addPerson('assignee', ResourceAllocationRole.User);
    const unscopedManager = await addPerson('unscoped-manager', ResourceAllocationRole.Manager);
    const supervisor = await addPerson('supervisor', ResourceAllocationRole.Supervisor);
    const manager = await addPerson('manager', ResourceAllocationRole.Manager);
    const groups = dataSource!.getRepository(ResourceGroup);
    const group = await groups.save(groups.create({
      name: 'Platform', active: true, supervisorId: supervisor.id, managerId: manager.id,
    }));
    const groupAdmin = await addPerson('group-admin', ResourceAllocationRole.Admin, group.id);
    admin.groupId = group.id;
    requester.groupId = group.id;
    assignee.groupId = group.id;
    supervisor.coveredGroupIds = [group.id];
    manager.coveredGroupIds = [group.id];
    await dataSource!.getRepository(ResourcePerson).save([admin, requester, assignee, supervisor, manager]);
    const profile = await dataSource!.getRepository(ResourceProfile).save({ name: 'API', groupId: group.id, active: true });
    const initiative = await dataSource!.getRepository(ResourceInitiative).save({
      code: 'ITDM-63', name: 'Resource allocation', active: true, codeUsed: true,
    });
    return { admin, groupAdmin, requester, assignee, supervisor, manager, unscopedManager, group, profile, initiative };
  }

  async function createRequest(
    requester: ResourcePerson,
    group: ResourceGroup,
    profile: ResourceProfile,
    initiative: ResourceInitiative,
    decisionState: 'WAITING_FOR_PRESENTATION' | 'PENDING_TEAM_DECISION' = 'WAITING_FOR_PRESENTATION',
  ) {
    const correlationId = randomUUID();
    const submission = await dataSource!.getRepository(ResourceSubmission).save({
      requesterId: requester.id, category: 'EXECUTION_PROJECT', lineCount: 1, correlationId,
    });
    const line = await dataSource!.getRepository(ResourceSubmissionLine).save({
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
    });
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
    const resourceRequest = await dataSource!.getRepository(ResourceRequest).save({
      submissionLineId: line.id,
      requesterId: requester.id,
      requesterSnapshot: { personId: requester.id, displayName: requester.displayName, role: requester.role },
      requestedConditions,
      decisionState,
      receivedAt: new Date(),
      stageEnteredAt: new Date(),
      expirationDueAt: new Date(Date.now() + 21 * 86_400_000),
      removedAt: null,
    });
    await dataSource!.getRepository(ResourceSubmissionLine).update(line.id, {
      requestId: resourceRequest.id,
      status: 'SUCCEEDED' as never,
      completedAt: new Date(),
      requestOutcome: { decisionState, requestedConditions },
    });
    await dataSource!.getRepository(ResourceRequestHistory).insert({
      requestId: resourceRequest.id,
      actorSnapshot: { personId: requester.id, displayName: requester.displayName, role: requester.role },
      action: 'SUBMITTED',
      afterSnapshot: { requestId: resourceRequest.id, decisionState, requestedConditions },
      correlationId,
    });
    return resourceRequest;
  }

  it('approves an in-scope request once and exposes its confirmed allocation in the requester detail', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    const queue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/presentation')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(queue.body.items[0].availableActions).toContain('APPROVE');

    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`;
    const key = randomUUID();
    const headers = {
      'X-PMO-Local-User-ID': fixture.admin.localUserId,
      'If-Match': '"1"',
      'Idempotency-Key': key,
      'X-Correlation-ID': randomUUID(),
    };
    const approved = await request(app!.getHttpServer())
      .post(path)
      .set(headers)
      .send({ personId: fixture.assignee.id })
      .expect(200);

    expect(approved.headers.etag).toBe('"2"');
    expect(approved.body).toMatchObject({
      id: resourceRequest.id,
      decisionState: 'APPROVED',
      version: 2,
      approvedConditions: {
        personId: fixture.assignee.id,
        resourceProfileId: fixture.profile.id,
        startDate: '2027-01-11',
        endDate: '2027-01-29',
        weeklyHours: 20,
      },
      allocation: { id: expect.any(String), state: 'NOT_STARTED' },
    });

    const detail = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${resourceRequest.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(detail.body.allocation).toMatchObject({
      person: { personId: fixture.assignee.id, displayName: fixture.assignee.displayName },
      resourceProfile: { id: fixture.profile.id, name: fixture.profile.name },
      startDate: '2027-01-11',
      endDate: '2027-01-29',
      weeklyHours: 20,
    });

    const replay = await request(app!.getHttpServer())
      .post(path)
      .set(headers)
      .send({ personId: fixture.assignee.id })
      .expect('Idempotency-Replayed', 'true')
      .expect(200);
    expect(replay.body).toEqual(approved.body);
    expect(replay.headers.etag).toBeUndefined();
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(1);
    expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'APPROVED'", [resourceRequest.id])).toHaveLength(1);
    expect(await dataSource!.query("SELECT id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code LIKE 'REQUEST_APPROVED_%'", [resourceRequest.id])).toHaveLength(1);
  });

  it('requires an explanation for changed dates or hours and creates no allocation until acceptance', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`;
    const proposal = {
      personId: fixture.assignee.id,
      startDate: '2027-02-01',
      endDate: '2027-02-19',
      weeklyHours: 15,
    };

    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send(proposal)
      .expect(400);
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);

    const decision = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ ...proposal, explanation: 'The initiative schedule and weekly capacity changed.' })
      .expect(200);

    expect(decision.body).toMatchObject({
      decisionState: 'APPROVED_WITH_CHANGES',
      approvedConditions: {
        personId: fixture.assignee.id,
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
        explanation: 'The initiative schedule and weekly capacity changed.',
      },
      allocation: null,
      dueAt: expect.any(String),
      version: 2,
    });
    expect(Date.parse(decision.body.dueAt)).toBeGreaterThan(Date.now());
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);

    const detail = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${resourceRequest.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(detail.body).toMatchObject({
      dueAt: decision.body.dueAt,
      availableActions: ['ACCEPT', 'CONTEST'],
      allocation: null,
      decisionState: 'APPROVED_WITH_CHANGES',
      approvedConditions: decision.body.approvedConditions,
    });

    const acceptancePath = `/api/resource-allocation/v1/requests/${resourceRequest.id}/acceptances`;
    const headers = {
      'X-PMO-Local-User-ID': fixture.requester.localUserId,
      'If-Match': '"2"',
      'Idempotency-Key': randomUUID(),
      'X-Correlation-ID': randomUUID(),
    };
    const accepted = await request(app!.getHttpServer()).post(acceptancePath).set(headers).send({}).expect(200);
    expect(accepted.body).toMatchObject({
      decisionState: 'APPROVED',
      confirmationSource: 'REQUESTER_ACCEPTANCE',
      allocation: {
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
      },
    });
    const replay = await request(app!.getHttpServer())
      .post(acceptancePath)
      .set(headers)
      .send({})
      .expect('Idempotency-Replayed', 'true')
      .expect(200);
    expect(replay.body).toEqual(accepted.body);
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(1);
    expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'CHANGES_ACCEPTED'", [resourceRequest.id])).toHaveLength(1);
  });

  it('persists decidedByPersonId and notifies only allocated person and decider on explicit acceptance (no self-notice)', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative, 'PENDING_TEAM_DECISION');
    const proposal = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.assignee.id,
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
        explanation: 'Schedule adjusted to team capacity.',
      })
      .expect(200);
    expect(proposal.body.approvedConditions.decidedByPersonId).toBe(fixture.manager.id);

    const accepted = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/acceptances`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"2"')
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', randomUUID())
      .send({})
      .expect(200);

    const eventCode = `REQUEST_CHANGES_ACCEPTED_${accepted.body.version}`;
    const notices = await dataSource!.query(
      'SELECT recipient_id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code = $2 ORDER BY recipient_id',
      [resourceRequest.id, eventCode],
    ) as Array<{ recipient_id: string }>;
    expect(notices.map((notice) => notice.recipient_id).sort()).toEqual([fixture.assignee.id, fixture.manager.id].sort());

    const [requesterInbox, assigneeInbox, deciderInbox] = await Promise.all([
      request(app!.getHttpServer()).get('/api/resource-allocation/v1/notifications').set('X-PMO-Local-User-ID', fixture.requester.localUserId).expect(200),
      request(app!.getHttpServer()).get('/api/resource-allocation/v1/notifications').set('X-PMO-Local-User-ID', fixture.assignee.localUserId).expect(200),
      request(app!.getHttpServer()).get('/api/resource-allocation/v1/notifications').set('X-PMO-Local-User-ID', fixture.manager.localUserId).expect(200),
    ]);
    expect(requesterInbox.body.items.filter((item: { eventCode: string }) => item.eventCode === eventCode)).toHaveLength(0);
    expect(assigneeInbox.body.items.filter((item: { eventCode: string }) => item.eventCode === eventCode)).toHaveLength(1);
    expect(deciderInbox.body.items.filter((item: { eventCode: string }) => item.eventCode === eventCode)).toHaveLength(1);

    // When requester is also the allocated person, explicit acceptance still suppresses self-notification.
    const selfAllocatedRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative, 'PENDING_TEAM_DECISION');
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${selfAllocatedRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.requester.id,
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
        explanation: 'Requester assigned with adjusted dates.',
      })
      .expect(200);
    const selfAccepted = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${selfAllocatedRequest.id}/acceptances`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"2"')
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', randomUUID())
      .send({})
      .expect(200);
    const selfNotices = await dataSource!.query(
      'SELECT recipient_id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code = $2',
      [selfAllocatedRequest.id, `REQUEST_CHANGES_ACCEPTED_${selfAccepted.body.version}`],
    ) as Array<{ recipient_id: string }>;
    expect(selfNotices.map((notice) => notice.recipient_id)).toEqual([fixture.manager.id]);

    // When decider === allocated person, explicit acceptance emits a single deduplicated notice.
    const deciderAssigneeRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative, 'PENDING_TEAM_DECISION');
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${deciderAssigneeRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.admin.id,
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
        explanation: 'Decider is also the assigned person.',
      })
      .expect(200);
    const overlapAccepted = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${deciderAssigneeRequest.id}/acceptances`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"2"')
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', randomUUID())
      .send({})
      .expect(200);
    const overlapNotices = await dataSource!.query(
      'SELECT recipient_id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code = $2',
      [deciderAssigneeRequest.id, `REQUEST_CHANGES_ACCEPTED_${overlapAccepted.body.version}`],
    ) as Array<{ recipient_id: string }>;
    expect(overlapNotices.map((notice) => notice.recipient_id)).toEqual([fixture.admin.id]);
  });

  it('automatically confirms an eligible proposal at its deadline and suppresses the overdue reminder', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    const decision = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.assignee.id,
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
        explanation: 'The initiative schedule and weekly capacity changed.',
      })
      .expect(200);
    expect(decision.body.decisionState).toBe('APPROVED_WITH_CHANGES');

    await dataSource!.query(`
      UPDATE resource_requests
      SET decision_response_due_at = clock_timestamp(), stage_entered_at = clock_timestamp() - INTERVAL '72 hours'
      WHERE id = $1
    `, [resourceRequest.id]);
    const worker = new ResourceAllocationProposalWorker(app!.get(ResourceAllocationApprovalService));
    await worker.processBatch();
    await worker.processBatch();

    const saved = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id });
    expect(saved.decisionState).toBe('APPROVED');
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(1);
    expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'AUTO_ACCEPTED_CHANGES'", [resourceRequest.id])).toHaveLength(1);
    expect(await dataSource!.query("SELECT id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code LIKE 'REQUEST_CHANGES_REMINDER_48H_%'", [resourceRequest.id])).toHaveLength(0);
  });

  it('notifies requester, allocated person, and decider deduplicated on automatic acceptance, with history fallback for legacy proposals', async () => {
    const fixture = await setup();
    const worker = new ResourceAllocationProposalWorker(app!.get(ResourceAllocationApprovalService));

    // 1. Distinct requester, allocated person, and decider -> 3 notifications
    const distinctRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative, 'PENDING_TEAM_DECISION');
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${distinctRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.assignee.id,
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
        explanation: 'Distinct roles proposal.',
      })
      .expect(200);
    await dataSource!.query(`
      UPDATE resource_requests
      SET decision_response_due_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = $1
    `, [distinctRequest.id]);
    expect(await worker.processBatch()).toBe(1);
    const savedDistinct = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: distinctRequest.id });
    const distinctNotices = await dataSource!.query(
      'SELECT recipient_id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code = $2 ORDER BY recipient_id',
      [distinctRequest.id, `REQUEST_CHANGES_AUTO_ACCEPTED_${savedDistinct.version}`],
    ) as Array<{ recipient_id: string }>;
    expect(distinctNotices.map((notice) => notice.recipient_id).sort()).toEqual([
      fixture.requester.id,
      fixture.assignee.id,
      fixture.manager.id,
    ].sort());

    // 2. Overlapping decider === allocated person -> 2 deduplicated notifications (requester + groupAdmin)
    const overlapRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative, 'PENDING_TEAM_DECISION');
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${overlapRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.groupAdmin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.groupAdmin.id,
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
        explanation: 'Group admin proposes self as assignee.',
      })
      .expect(200);
    await dataSource!.query(`
      UPDATE resource_requests
      SET decision_response_due_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = $1
    `, [overlapRequest.id]);
    expect(await worker.processBatch()).toBe(1);
    const savedOverlap = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: overlapRequest.id });
    const overlapNotices = await dataSource!.query(
      'SELECT recipient_id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code = $2 ORDER BY recipient_id',
      [overlapRequest.id, `REQUEST_CHANGES_AUTO_ACCEPTED_${savedOverlap.version}`],
    ) as Array<{ recipient_id: string }>;
    expect(overlapNotices.map((notice) => notice.recipient_id).sort()).toEqual([
      fixture.requester.id,
      fixture.groupAdmin.id,
    ].sort());

    // 3. Legacy proposal missing decidedByPersonId resolves decider from the latest APPROVAL_CHANGES_PROPOSED history event
    const legacyRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative, 'PENDING_TEAM_DECISION');
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${legacyRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.assignee.id,
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
        explanation: 'First proposal by admin.',
      })
      .expect(200);
    // Trigger real revalidation + new proposal by supervisor, then strip decidedByPersonId to simulate a legacy record
    const assigneeRecord = await dataSource!.getRepository(ResourcePerson).findOneByOrFail({ id: fixture.assignee.id });
    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/people/${fixture.assignee.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', `"${assigneeRecord.version}"`)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ active: false })
      .expect(200);
    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/people/${fixture.assignee.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', `"${assigneeRecord.version + 1}"`)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ active: true })
      .expect(200);
    const revalidating = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: legacyRequest.id });
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${legacyRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.supervisor.localUserId)
      .set('If-Match', `"${revalidating.version}"`)
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.assignee.id,
        startDate: '2027-02-05',
        endDate: '2027-02-22',
        weeklyHours: 16,
        explanation: 'Latest proposal by supervisor.',
      })
      .expect(200);
    await dataSource!.query(`
      UPDATE resource_requests
      SET approved_conditions = approved_conditions - 'decidedByPersonId',
          decision_response_due_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = $1
    `, [legacyRequest.id]);
    expect(await worker.processBatch()).toBe(1);
    const savedLegacy = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: legacyRequest.id });
    const legacyNotices = await dataSource!.query(
      'SELECT recipient_id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code = $2 ORDER BY recipient_id',
      [legacyRequest.id, `REQUEST_CHANGES_AUTO_ACCEPTED_${savedLegacy.version}`],
    ) as Array<{ recipient_id: string }>;
    expect(legacyNotices.map((notice) => notice.recipient_id).sort()).toEqual([
      fixture.requester.id,
      fixture.assignee.id,
      fixture.supervisor.id,
    ].sort());
  });

  it('rolls back the proposal, history, notice, and idempotency receipt when notice persistence fails', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    const key = randomUUID();
    await dataSource!.query(`
      CREATE FUNCTION fail_changed_proposal_notice() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_code LIKE 'REQUEST_CHANGES_PROPOSED_%' THEN
          RAISE EXCEPTION 'test proposal notification failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await dataSource!.query(`
      CREATE TRIGGER fail_changed_proposal_notice_trigger
      BEFORE INSERT ON resource_allocation_notifications
      FOR EACH ROW EXECUTE FUNCTION fail_changed_proposal_notice()
    `);
    try {
      await request(app!.getHttpServer())
        .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`)
        .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
        .set('If-Match', '"1"')
        .set('Idempotency-Key', key)
        .send({
          personId: fixture.assignee.id,
          startDate: '2027-02-01',
          endDate: '2027-02-19',
          weeklyHours: 15,
          explanation: 'The initiative schedule and weekly capacity changed.',
        })
        .expect(500);
    } finally {
      await dataSource!.query('DROP TRIGGER IF EXISTS fail_changed_proposal_notice_trigger ON resource_allocation_notifications');
      await dataSource!.query('DROP FUNCTION IF EXISTS fail_changed_proposal_notice()');
    }
    const saved = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id });
    expect(saved.decisionState).toBe('WAITING_FOR_PRESENTATION');
    expect(saved.approvedConditions).toBeNull();
    expect(saved.decisionResponseDueAt).toBeNull();
    expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'APPROVAL_CHANGES_PROPOSED'", [resourceRequest.id])).toHaveLength(0);
    expect(await dataSource!.query("SELECT id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code LIKE 'REQUEST_CHANGES_PROPOSED_%'", [resourceRequest.id])).toHaveLength(0);
    expect(await dataSource!.query('SELECT id FROM resource_allocation_operation_receipts WHERE idempotency_key = $1', [key])).toHaveLength(0);
  });

  it('lets a past requested start date be reviewed and requires a future proposal start at the response deadline', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    const expiredConditions = {
      ...resourceRequest.requestedConditions,
      startDate: '2025-01-01',
      endDate: '2025-01-31',
    };
    await dataSource!.getRepository(ResourceRequest).update(resourceRequest.id, { requestedConditions: expiredConditions });
    const editedRequest = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id });

    const candidates = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approval-candidates`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(candidates.body.items).toEqual(expect.arrayContaining([
      { id: fixture.assignee.id, displayName: fixture.assignee.displayName, groupId: fixture.group.id },
    ]));

    const dateRows = await dataSource!.query(`
      SELECT ((clock_timestamp() + INTERVAL '72 hours') AT TIME ZONE 'America/Sao_Paulo')::date::text AS due_date
    `) as Array<{ due_date: string }>;
    const deadlineDate = new Date(`${dateRows[0].due_date}T00:00:00.000Z`);
    const priorDate = new Date(deadlineDate.getTime() - 86_400_000).toISOString().slice(0, 10);
    const proposedDate = new Date(deadlineDate.getTime() + 86_400_000).toISOString().slice(0, 10);
    const proposedEnd = new Date(new Date(`${proposedDate}T00:00:00.000Z`).getTime() + 18 * 86_400_000).toISOString().slice(0, 10);
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`;
    const headers = {
      'X-PMO-Local-User-ID': fixture.admin.localUserId,
      'If-Match': `"${editedRequest.version}"`,
    };
    await request(app!.getHttpServer())
      .post(path)
      .set({ ...headers, 'Idempotency-Key': randomUUID() })
      .send({ personId: fixture.assignee.id, startDate: priorDate, endDate: proposedEnd, weeklyHours: 15, explanation: 'The requested start date has passed.' })
      .expect(422);
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);

    const proposal = await request(app!.getHttpServer())
      .post(path)
      .set({ ...headers, 'Idempotency-Key': randomUUID() })
      .send({ personId: fixture.assignee.id, startDate: proposedDate, endDate: proposedEnd, weeklyHours: 15, explanation: 'The requested start date has passed.' })
      .expect(200);
    expect(proposal.body).toMatchObject({ decisionState: 'APPROVED_WITH_CHANGES', allocation: null });
  });

  it('sends the 48-hour proposal reminder once and lets the automatic deadline win an acceptance race', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.assignee.id,
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
        explanation: 'The initiative schedule and weekly capacity changed.',
      })
      .expect(200);
    const worker = new ResourceAllocationProposalWorker(app!.get(ResourceAllocationApprovalService));

    await dataSource!.query(`
      UPDATE resource_requests
      SET decision_response_due_at = clock_timestamp() + INTERVAL '24 hours'
      WHERE id = $1
    `, [resourceRequest.id]);
    await worker.processBatch();
    await worker.processBatch();
    expect(await dataSource!.query("SELECT id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code LIKE 'REQUEST_CHANGES_REMINDER_48H_%'", [resourceRequest.id])).toHaveLength(1);
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);

    await dataSource!.query(`
      UPDATE resource_requests
      SET decision_response_due_at = clock_timestamp()
      WHERE id = $1
    `, [resourceRequest.id]);
    const expiredDetail = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${resourceRequest.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(expiredDetail.body.availableActions).not.toContain('ACCEPT');
    const response = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/acceptances`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"2"')
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', randomUUID())
      .send({});
    await worker.processBatch();

    expect([200, 422]).toContain(response.status);
    if (response.status === 200) expect(response.body.confirmationSource).toBe('SYSTEM_DEADLINE');
    const saved = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id });
    expect(saved.decisionState).toBe('APPROVED');
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(1);
    expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'AUTO_ACCEPTED_CHANGES'", [resourceRequest.id])).toHaveLength(1);
  });

  it('moves an expired proposal to durable revalidation instead of retroactively allocating when eligibility was lost', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.assignee.id,
        startDate: '2027-02-01',
        endDate: '2027-02-19',
        weeklyHours: 15,
        explanation: 'The initiative schedule and weekly capacity changed.',
      })
      .expect(200);
    await dataSource!.getRepository(ResourcePerson).update(fixture.assignee.id, { active: false });
    await dataSource!.query(`
      UPDATE resource_requests
      SET decision_response_due_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = $1
    `, [resourceRequest.id]);

    const worker = new ResourceAllocationProposalWorker(app!.get(ResourceAllocationApprovalService));
    await worker.processBatch();

    const saved = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id });
    expect(saved.decisionState).toBe('REQUIRES_REVALIDATION');
    expect(saved.approvedConditions).toMatchObject({ personId: fixture.assignee.id });
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);
    expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'PROPOSAL_REQUIRES_REVALIDATION'", [resourceRequest.id])).toHaveLength(1);
    const revalidationNotices = await dataSource!.query(
      "SELECT recipient_id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code LIKE 'REQUEST_REVALIDATION_REQUIRED_%' ORDER BY recipient_id",
      [resourceRequest.id],
    ) as Array<{ recipient_id: string }>;
    expect(revalidationNotices.map((notice) => notice.recipient_id).sort()).toEqual([
      fixture.requester.id,
      fixture.admin.id,
      fixture.groupAdmin.id,
      fixture.supervisor.id,
      fixture.manager.id,
    ].sort());
  });

  it('corrects only the approved profile with an explanation and preserves the requested profile', async () => {
    const fixture = await setup();
    const original = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    const replacement = await dataSource!.getRepository(ResourceProfile).save({
      name: 'Cloud API', groupId: fixture.group.id, active: true,
    });
    const path = `/api/resource-allocation/v1/requests/${original.id}/approvals`;

    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id, resourceProfileId: replacement.id })
      .expect(400);
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [original.id])).toHaveLength(0);

    const result = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({
        personId: fixture.assignee.id,
        resourceProfileId: replacement.id,
        explanation: 'The requested profile does not match the confirmed work.',
      })
      .expect(200);

    expect(result.body).toMatchObject({
      decisionState: 'APPROVED',
      approvedConditions: {
        resourceProfileId: replacement.id,
        resourceProfileName: replacement.name,
        startDate: '2027-01-11',
        endDate: '2027-01-29',
        weeklyHours: 20,
        explanation: 'The requested profile does not match the confirmed work.',
      },
      allocation: { resourceProfile: { id: replacement.id, name: replacement.name } },
    });
    const savedRequest = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: original.id });
    expect(savedRequest.requestedConditions.resourceProfileId).toBe(fixture.profile.id);
    expect(savedRequest.approvedConditions?.resourceProfileId).toBe(replacement.id);
    const history = await dataSource!.getRepository(ResourceRequestHistory).findOneByOrFail({ requestId: original.id, action: 'APPROVED' });
    expect(history.afterSnapshot).toMatchObject({
      requestedConditions: { resourceProfileId: fixture.profile.id },
      approvedConditions: { resourceProfileId: replacement.id },
    });
  });

  it('limits approval to an authorized non-requester and rejects an old version', async () => {
    const fixture = await setup();
    const ownRequest = await createRequest(fixture.admin, fixture.group, fixture.profile, fixture.initiative);
    const queue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/presentation')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(queue.body.items.find((item: { id: string }) => item.id === ownRequest.id).availableActions).not.toContain('APPROVE');
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${ownRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id })
      .expect(400);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${ownRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id })
      .expect(403);

    const pending = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative, 'PENDING_TEAM_DECISION');
    const managerQueue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/team-decision')
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .expect(200);
    expect(managerQueue.body.items.find((item: { id: string }) => item.id === pending.id).availableActions).toContain('APPROVE');
    const candidates = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${pending.id}/approval-candidates`)
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .expect(200);
    expect(candidates.body.items).toEqual(expect.arrayContaining([
      { id: fixture.assignee.id, displayName: fixture.assignee.displayName, groupId: fixture.group.id },
    ]));
    expect(candidates.body.items[0]).not.toHaveProperty('email');
    const otherGroup = await dataSource!.getRepository(ResourceGroup).save({
      name: 'Data', active: true, supervisorId: fixture.supervisor.id, managerId: fixture.manager.id,
    });
    const ineligiblePerson = await addPerson('wrong-group-assignee', ResourceAllocationRole.User, otherGroup.id);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${pending.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ personId: ineligiblePerson.id })
      .expect(422);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${pending.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.unscopedManager.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id })
      .expect(403);
    await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${pending.id}/approval-candidates`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(403);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${pending.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id })
      .expect(403);

    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${pending.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.manager.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id })
      .expect(200);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${pending.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id })
      .expect(412);
  });

  it('serializes competing approvals against the current request version', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative, 'PENDING_TEAM_DECISION');
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`;
    const send = (actor: ResourcePerson) => request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', actor.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id });

    const results = await Promise.all([send(fixture.manager), send(fixture.admin)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(1);
    expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'APPROVED'", [resourceRequest.id])).toHaveLength(1);
  });

  it('checks current group scope before returning a saved approval receipt', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative, 'PENDING_TEAM_DECISION');
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`;
    const key = randomUUID();
    const headers = {
      'X-PMO-Local-User-ID': fixture.manager.localUserId,
      'If-Match': '"1"',
      'Idempotency-Key': key,
      'X-Correlation-ID': randomUUID(),
    };
    await request(app!.getHttpServer())
      .post(path)
      .set(headers)
      .send({ personId: fixture.assignee.id })
      .expect(200);
    await dataSource!.getRepository(ResourcePerson).update(fixture.manager.id, { coveredGroupIds: [] });

    await request(app!.getHttpServer())
      .post(path)
      .set(headers)
      .send({ personId: fixture.assignee.id })
      .expect(403);
  });

  it('checks the waiting deadline after locking the request and suppresses approval when it has passed', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    await dataSource!.getRepository(ResourceRequest).update(resourceRequest.id, { expirationDueAt: new Date(Date.now() - 1000) });
    const current = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id });
    const queue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/presentation')
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(queue.body.items[0].availableActions).not.toContain('APPROVE');
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', `"${current.version}"`)
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id })
      .expect(422);
    expect(await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id }))
      .toMatchObject({ decisionState: 'WAITING_FOR_PRESENTATION', version: current.version });
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);
  });

  it('rechecks the waiting deadline after blocking on the shared administration lock', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    const deadline = new Date(Date.now() + 350);
    await dataSource!.getRepository(ResourceRequest).update(resourceRequest.id, { expirationDueAt: deadline });
    const current = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id });
    const lockHolder = dataSource!.createQueryRunner();
    await lockHolder.connect();
    await lockHolder.startTransaction();
    await lockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [20261120, 59]);
    let responseSettled = false;

    try {
      const waitingResponse = request(app!.getHttpServer())
        .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`)
        .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
        .set('If-Match', `"${current.version}"`)
        .set('Idempotency-Key', randomUUID())
        .send({ personId: fixture.assignee.id })
        .then((response) => {
          responseSettled = true;
          return response;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(responseSettled).toBe(false);
      await lockHolder.query('SELECT pg_sleep(0.45)');
      await lockHolder.commitTransaction();
      expect((await waitingResponse).status).toBe(422);
    } finally {
      if (lockHolder.isTransactionActive) await lockHolder.rollbackTransaction();
      await lockHolder.release();
    }
    expect(await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id }))
      .toMatchObject({ decisionState: 'WAITING_FOR_PRESENTATION', version: current.version });
  });

  it('rolls back approval, allocation, history, notice, and receipt together when notification persistence fails', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    const key = randomUUID();
    const path = `/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`;
    const createTrigger = async () => {
      await dataSource!.query(`
        CREATE FUNCTION fail_approval_notice() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_code LIKE 'REQUEST_APPROVED_%' THEN
            RAISE EXCEPTION 'test approval notice failure' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await dataSource!.query(`
        CREATE TRIGGER fail_approval_notice_before_insert
        BEFORE INSERT ON resource_allocation_notifications
        FOR EACH ROW EXECUTE FUNCTION fail_approval_notice()
      `);
    };
    await createTrigger();

    try {
      await request(app!.getHttpServer())
        .post(path)
        .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
        .set('If-Match', '"1"')
        .set('Idempotency-Key', key)
        .send({ personId: fixture.assignee.id })
        .expect(500);
      expect(await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: resourceRequest.id }))
        .toMatchObject({ decisionState: 'WAITING_FOR_PRESENTATION', version: 1, approvedConditions: null });
      expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(0);
      expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'APPROVED'", [resourceRequest.id])).toHaveLength(0);
      expect(await dataSource!.query("SELECT id FROM resource_allocation_operation_receipts WHERE operation = 'request.approve' AND idempotency_key = $1", [key])).toHaveLength(0);
    } finally {
      await dataSource!.query('DROP TRIGGER fail_approval_notice_before_insert ON resource_allocation_notifications');
      await dataSource!.query('DROP FUNCTION fail_approval_notice()');
    }

    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', key)
      .send({ personId: fixture.assignee.id })
      .expect(200);
    expect(await dataSource!.query('SELECT id FROM resource_allocations WHERE source_request_id = $1', [resourceRequest.id])).toHaveLength(1);
    expect(await dataSource!.query("SELECT id FROM resource_request_history WHERE request_id = $1 AND action = 'APPROVED'", [resourceRequest.id])).toHaveLength(1);
    expect(await dataSource!.query("SELECT id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code LIKE 'REQUEST_APPROVED_%'", [resourceRequest.id])).toHaveLength(1);
  });

  it('keeps an allocation and notifies its group leadership when the assigned person is deactivated', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);
    const approved = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id })
      .expect(200);
    const currentAssignee = await dataSource!.getRepository(ResourcePerson).findOneByOrFail({ id: fixture.assignee.id });

    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/people/${fixture.assignee.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', `"${currentAssignee.version}"`)
      .send({ active: false })
      .expect(200);

    const detail = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${resourceRequest.id}`)
      .set('X-PMO-Local-User-ID', fixture.requester.localUserId)
      .expect(200);
    expect(detail.body.allocation).toMatchObject({ id: approved.body.allocation.id, person: { personId: fixture.assignee.id } });
    expect((await dataSource!.getRepository(ResourcePerson).findOneByOrFail({ id: fixture.assignee.id })).active).toBe(false);
    const notices = await dataSource!.query(
      "SELECT recipient_id FROM resource_allocation_notifications WHERE source_request_id = $1 AND event_code LIKE 'PERSON_DEACTIVATED_%' ORDER BY recipient_id",
      [resourceRequest.id],
    ) as Array<{ recipient_id: string }>;
    expect(notices.map((notice) => notice.recipient_id).sort()).toEqual([fixture.groupAdmin.id, fixture.manager.id, fixture.supervisor.id].sort());
  });

  it('serializes approval query and body DTO validation failures into RFC 9457 errors[]', async () => {
    const fixture = await setup();
    const resourceRequest = await createRequest(fixture.requester, fixture.group, fixture.profile, fixture.initiative);

    const invalidQuery = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approval-candidates?limit=0`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(invalidQuery.body.errors).toEqual([{ path: 'limit', code: 'MIN', message: expect.any(String) }]);

    const invalidBody = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${resourceRequest.id}/approvals`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.assignee.id, weeklyHours: 0 })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(invalidBody.body.errors).toEqual([{ path: 'weeklyHours', code: 'MIN', message: expect.any(String) }]);
  });
});
