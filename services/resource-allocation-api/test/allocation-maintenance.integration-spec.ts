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
import { ResourcePersonClassification } from '../src/people/resource-person-classification';
import { ResourceAllocationRole } from '../src/people/resource-allocation-role';
import { ResourceGroup } from '../src/groups/resource-group.entity';
import { ResourceProfile } from '../src/resource-profiles/resource-profile.entity';
import { ResourceInitiative } from '../src/initiatives/resource-initiative.entity';
import { ResourceAllocation } from '../src/allocations/resource-allocation.entity';
import { ResourceAllocationHistory } from '../src/allocations/resource-allocation-history.entity';
import { ResourceRequest } from '../src/requests/resource-request.entity';
import { ResourceSubmission } from '../src/submissions/resource-submission.entity';
import { ResourceSubmissionLine } from '../src/submissions/resource-submission-line.entity';

const allocationsPath = '/api/resource-allocation/v1/allocations';

describe('Tech Resource Allocation maintenance after approval (#95–#97)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_maintenance_test')
      .withUsername('resource_allocation_test')
      .withPassword('test_only_password')
      .start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(container.getConnectionUri())] }).compile();
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

  async function addPerson(localUserId: string, role: ResourceAllocationRole, groupId: string | null = null, classification: ResourcePersonClassification | null = null) {
    const repository = dataSource!.getRepository(ResourcePerson);
    return repository.save(repository.create({
      localUserId, displayName: localUserId, email: `${localUserId}@example.test`, role, active: true, groupId, coveredGroupIds: [], classification,
    }));
  }

  async function setup() {
    const admin = await addPerson('mt-admin', ResourceAllocationRole.Admin);
    const supervisor = await addPerson('mt-supervisor', ResourceAllocationRole.Supervisor);
    const manager = await addPerson('mt-manager', ResourceAllocationRole.Manager);
    const otherManager = await addPerson('mt-other-manager', ResourceAllocationRole.Manager);
    const group = await dataSource!.getRepository(ResourceGroup).save({ name: 'Platform', active: true, supervisorId: supervisor.id, managerId: manager.id });
    const otherGroup = await dataSource!.getRepository(ResourceGroup).save({ name: 'Data', active: true, supervisorId: otherManager.id, managerId: otherManager.id });
    const moderator = await addPerson('mt-moderator', ResourceAllocationRole.Moderator, group.id);
    const requester = await addPerson('mt-requester', ResourceAllocationRole.User, otherGroup.id);
    const member = await addPerson('mt-member', ResourceAllocationRole.User, group.id, ResourcePersonClassification.Internal);
    const contractor = await addPerson('mt-contractor', ResourceAllocationRole.User, group.id, ResourcePersonClassification.ThirdParty);
    const outsider = await addPerson('mt-outsider', ResourceAllocationRole.User, otherGroup.id);
    const profile = await dataSource!.getRepository(ResourceProfile).save({ name: 'API', groupId: group.id, active: true });
    const otherProfile = await dataSource!.getRepository(ResourceProfile).save({ name: 'Cloud', groupId: group.id, active: true });
    const foreignProfile = await dataSource!.getRepository(ResourceProfile).save({ name: 'Analytics', groupId: otherGroup.id, active: true });
    const initiative = await dataSource!.getRepository(ResourceInitiative).save({ code: `ITDM-${randomUUID().slice(0, 6)}`, name: 'Plan', active: true, codeUsed: true });
    return { admin, supervisor, manager, otherManager, moderator, requester, member, contractor, outsider, group, otherGroup, profile, otherProfile, foreignProfile, initiative };
  }

  type Fixture = Awaited<ReturnType<typeof setup>>;

  async function today(): Promise<string> {
    const rows = await dataSource!.query("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today") as Array<{ today: string }>;
    return rows[0].today;
  }

  function addDays(date: string, days: number): string {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  function headers(actor: ResourcePerson, version?: number, key: string = randomUUID()) {
    return {
      'X-PMO-Local-User-ID': actor.localUserId,
      'Idempotency-Key': key,
      'X-Correlation-ID': randomUUID(),
      ...(version === undefined ? {} : { 'If-Match': `"${version}"` }),
    };
  }

  function create(actor: ResourcePerson, body: Record<string, unknown>) {
    return request(app!.getHttpServer()).post(allocationsPath).set(headers(actor)).send(body).expect(201);
  }

  function patch(actor: ResourcePerson, id: string, version: number, body: Record<string, unknown>, key?: string) {
    return request(app!.getHttpServer()).patch(`${allocationsPath}/${id}`)
      .set(headers(actor, version, key)).set('Content-Type', 'application/merge-patch+json').send(body);
  }

  function reopen(actor: ResourcePerson, id: string, version: number, body: Record<string, unknown>, key?: string) {
    return request(app!.getHttpServer()).post(`${allocationsPath}/${id}/reopenings`).set(headers(actor, version, key)).send(body);
  }

  function command(actor: ResourcePerson, id: string, version: number, path: string, reason = 'Operational change') {
    return request(app!.getHttpServer()).post(`${allocationsPath}/${id}/${path}`).set(headers(actor, version)).send({ reason });
  }

  async function notices(person: ResourcePerson) {
    return (await dataSource!.query(
      'SELECT event_code FROM resource_allocation_notifications WHERE recipient_id = $1::uuid ORDER BY created_at, event_code',
      [person.id],
    ) as Array<{ event_code: string }>).map(({ event_code: code }) => code);
  }

  async function clearNotices() {
    await dataSource!.query('DELETE FROM resource_allocation_notifications');
  }

  async function requestAllocation(f: Fixture, startDate: string, endDate: string) {
    const conditions = {
      initiativeId: f.initiative.id, initiativeCode: f.initiative.code, initiativeName: f.initiative.name, category: 'EXECUTION_PROJECT',
      groupId: f.group.id, groupName: f.group.name, resourceProfileId: f.profile.id, resourceProfileName: f.profile.name,
      startDate, endDate, weeklyHours: 20,
    };
    const submission = await dataSource!.getRepository(ResourceSubmission).save({ requesterId: f.requester.id, category: 'EXECUTION_PROJECT', lineCount: 1, correlationId: randomUUID() });
    const line = await dataSource!.getRepository(ResourceSubmissionLine).save({
      submissionId: submission.id, requesterId: f.requester.id, attemptKey: randomUUID(), attemptPayloadHash: 'a'.repeat(64), lineNumber: 0,
      submittedConditions: conditions, status: 'RECEIVED' as never, requestId: null, problem: null, requestOutcome: null, claimToken: null, claimedAt: null, completedAt: null,
    });
    const approved = { personId: f.member.id, personName: f.member.displayName, resourceProfileId: f.profile.id, resourceProfileName: f.profile.name, startDate, endDate, weeklyHours: 20 };
    const requestItem = await dataSource!.getRepository(ResourceRequest).save({
      submissionLineId: line.id, requesterId: f.requester.id,
      requesterSnapshot: { personId: f.requester.id, displayName: f.requester.displayName, role: f.requester.role },
      requestedConditions: conditions, approvedConditions: approved, decisionState: 'APPROVED',
      receivedAt: new Date(), stageEnteredAt: new Date(), expirationDueAt: new Date(Date.now() + 86_400_000), removedAt: null,
    });
    await dataSource!.getRepository(ResourceSubmissionLine).update(line.id, {
      status: 'SUCCEEDED' as never, requestId: requestItem.id, requestOutcome: { decisionState: 'APPROVED', requestedConditions: conditions }, completedAt: new Date(),
    });
    const now = new Date();
    const allocation = await dataSource!.getRepository(ResourceAllocation).save({
      sourceRequestId: requestItem.id, origin: 'REQUEST', category: 'EXECUTION_PROJECT', comment: null, classification: ResourcePersonClassification.Internal, createdByPersonId: null,
      personId: f.member.id, personSnapshot: { personId: f.member.id, displayName: f.member.displayName, role: f.member.role },
      groupId: f.group.id, groupSnapshot: { id: f.group.id, name: f.group.name },
      initiativeId: f.initiative.id, initiativeSnapshot: { id: f.initiative.id, code: f.initiative.code, name: f.initiative.name },
      resourceProfileId: f.profile.id, resourceProfileSnapshot: { id: f.profile.id, name: f.profile.name },
      approvedStartDate: startDate, approvedEndDate: endDate, effectiveStartDate: startDate, effectiveEndDate: endDate,
      weeklyHours: '20.0', state: 'NOT_STARTED', stateEnteredAt: now, approvedAt: now,
    });
    return { allocation, requestItem };
  }

  describe('structural changes (#95)', () => {
    it('lets in-scope leadership reassign, re-profile, and re-date a request allocation while preserving the decision and history', async () => {
      const f = await setup();
      const day = await today();
      const { allocation, requestItem } = await requestAllocation(f, addDays(day, 10), addDays(day, 30));
      const response = await patch(f.moderator, allocation.id, 1, {
        reason: 'Rebalance the team', personId: f.contractor.id, resourceProfileId: f.otherProfile.id,
        startDate: addDays(day, 12), endDate: addDays(day, 40), weeklyHours: 12.25,
      }).expect(200);
      expect(response.headers.etag).toBe('"2"');
      expect(response.body).toMatchObject({
        person: { personId: f.contractor.id }, resourceProfile: { id: f.otherProfile.id }, classification: 'THIRD_PARTY',
        startDate: addDays(day, 12), endDate: addDays(day, 40), weeklyHours: 12.3, state: 'NOT_STARTED', version: 2,
        approvedPeriod: { startDate: addDays(day, 10), endDate: addDays(day, 30) },
      });
      const savedRequest = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: requestItem.id });
      expect(savedRequest.approvedConditions).toMatchObject({ personId: f.member.id, startDate: addDays(day, 10), weeklyHours: 20 });
      const history = await dataSource!.getRepository(ResourceAllocationHistory).findBy({ allocationId: allocation.id });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ action: 'ALLOCATION_UPDATED', reason: 'Rebalance the team' });
      expect(history[0].beforeSnapshot).toMatchObject({ person: { personId: f.member.id }, weeklyHours: 20 });
      expect(history[0].afterSnapshot).toMatchObject({ person: { personId: f.contractor.id }, weeklyHours: 12.3 });
      for (const person of [f.member, f.contractor, f.requester]) expect(await notices(person)).toEqual(['ALLOCATION_UPDATED_2']);
      for (const person of [f.moderator, f.supervisor, f.manager]) expect(await notices(person)).toEqual([]);
    });

    it('denies structural edits to users, the self-allocation author, other leaders, and closed allocations without effects', async () => {
      const f = await setup();
      const day = await today();
      const own = await create(f.member, { category: 'TRAINING', resourceProfileId: f.profile.id, startDate: day, endDate: addDays(day, 5), weeklyHours: 4, comment: 'Course' });
      expect((await patch(f.member, own.body.id, 1, { reason: 'More hours', weeklyHours: 8 }).expect(403)).body.code).toBe('ACCESS_DENIED');
      await patch(f.otherManager, own.body.id, 1, { reason: 'More hours', weeklyHours: 8 }).expect(403);
      await patch(f.moderator, own.body.id, 1, { weeklyHours: 8 }).expect(400);
      await patch(f.moderator, own.body.id, 1, { reason: 'Other group', personId: f.outsider.id }).expect(400);
      await patch(f.moderator, own.body.id, 1, { reason: 'Other group', resourceProfileId: f.foreignProfile.id }).expect(400);
      await patch(f.moderator, own.body.id, 1, { reason: 'Reverse', startDate: addDays(day, 9), endDate: addDays(day, 8) }).expect(422);
      const done = await create(f.member, { category: 'TRAINING', resourceProfileId: f.profile.id, startDate: addDays(day, -9), endDate: addDays(day, -2), weeklyHours: 4, comment: 'Course' });
      expect((await patch(f.admin, done.body.id, 1, { reason: 'Late fix', weeklyHours: 8 }).expect(422)).body.code).toBe('INVALID_ALLOCATION_TRANSITION');
      expect(await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: own.body.id })).toMatchObject({ version: 1, weeklyHours: '4.0' });
      expect(await dataSource!.getRepository(ResourceAllocationHistory).countBy({ action: 'ALLOCATION_UPDATED' })).toBe(0);
    });

    it('rejects stale versions, replays the same attempt once, and rejects a reused key with other content', async () => {
      const f = await setup();
      const day = await today();
      const own = await create(f.member, { category: 'TRAINING', resourceProfileId: f.profile.id, startDate: day, endDate: addDays(day, 5), weeklyHours: 4, comment: 'Course' });
      const key = randomUUID();
      const first = await patch(f.moderator, own.body.id, 1, { reason: 'More hours', weeklyHours: 8 }, key).expect(200);
      const replay = await patch(f.moderator, own.body.id, 1, { reason: 'More hours', weeklyHours: 8 }, key).expect(200).expect('Idempotency-Replayed', 'true');
      expect(replay.body).toEqual(first.body);
      await patch(f.moderator, own.body.id, 1, { reason: 'More hours', weeklyHours: 9 }, key).expect(409);
      expect((await patch(f.supervisor, own.body.id, 1, { reason: 'Stale', weeklyHours: 6 }).expect(412)).body.code).toBe('PRECONDITION_FAILED');
      expect(await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: own.body.id })).toMatchObject({ version: 2, weeklyHours: '8.0' });
      expect(await dataSource!.getRepository(ResourceAllocationHistory).countBy({ allocationId: own.body.id, action: 'ALLOCATION_UPDATED' })).toBe(1);
    });

    it('lets a covering leader edit, serializes concurrent edits, rejects no-op edits, and rolls back when a notice fails', async () => {
      const f = await setup();
      const day = await today();
      const covering = await addPerson('mt-covering', ResourceAllocationRole.Supervisor);
      await dataSource!.getRepository(ResourcePerson).update(covering.id, { coveredGroupIds: [f.group.id] });
      const own = await create(f.member, { category: 'TRAINING', resourceProfileId: f.profile.id, startDate: day, endDate: addDays(day, 5), weeklyHours: 4, comment: 'Course' });
      await patch(covering, own.body.id, 1, { reason: 'Covered group', weeklyHours: 5 }).expect(200);

      const attempts = await Promise.all([
        patch(f.moderator, own.body.id, 2, { reason: 'First', weeklyHours: 6 }),
        patch(f.manager, own.body.id, 2, { reason: 'Second', weeklyHours: 7 }),
      ]);
      expect(attempts.map(({ status }) => status).sort()).toEqual([200, 412]);
      expect(await dataSource!.getRepository(ResourceAllocationHistory).countBy({ allocationId: own.body.id, action: 'ALLOCATION_UPDATED' })).toBe(2);

      const noop = await patch(f.moderator, own.body.id, 3, { reason: 'Nothing', weeklyHours: Number((await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: own.body.id })).weeklyHours) }).expect(400);
      expect(noop.body.code).toBe('VALIDATION_ERROR');

      await dataSource!.query(`
        CREATE FUNCTION fail_maintenance_notice() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test notification failure'; END
        $$
      `);
      await dataSource!.query('CREATE TRIGGER fail_maintenance_notice_before_insert BEFORE INSERT ON resource_allocation_notifications FOR EACH ROW EXECUTE FUNCTION fail_maintenance_notice()');
      try {
        await patch(f.moderator, own.body.id, 3, { reason: 'Will fail', weeklyHours: 9 }).expect(500);
        expect(await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: own.body.id })).toMatchObject({ version: 3 });
        expect(await dataSource!.getRepository(ResourceAllocationHistory).countBy({ allocationId: own.body.id, action: 'ALLOCATION_UPDATED' })).toBe(2);
        expect(await dataSource!.query("SELECT id FROM resource_allocation_operation_receipts WHERE operation = 'allocation.update'")).toHaveLength(2);
      } finally {
        await dataSource!.query('DROP TRIGGER fail_maintenance_notice_before_insert ON resource_allocation_notifications');
        await dataSource!.query('DROP FUNCTION fail_maintenance_notice()');
      }
    });

    it('switches only among operational categories and confirms the derived state when held work becomes Vacation', async () => {
      const f = await setup();
      const day = await today();
      const training = await create(f.member, { category: 'TRAINING', resourceProfileId: f.profile.id, startDate: addDays(day, -2), endDate: addDays(day, 5), weeklyHours: 4, comment: 'Course' });
      await command(f.member, training.body.id, 1, 'suspensions').expect(200);
      const needsConfirmation = await patch(f.moderator, training.body.id, 2, { reason: 'Actually vacation', category: 'VACATION' }).expect(422);
      expect(needsConfirmation.body.code).toBe('DERIVED_STATE_CONFIRMATION_REQUIRED');
      const vacation = await patch(f.moderator, training.body.id, 2, { reason: 'Actually vacation', category: 'VACATION', confirmDerivedState: true }).expect(200);
      expect(vacation.body).toMatchObject({ category: 'VACATION', weeklyHours: 40, resourceProfile: null, comment: null, state: 'IN_PROGRESS', availableActions: ['COMPLETE', 'CANCEL'] });

      const missing = await patch(f.moderator, training.body.id, 3, { reason: 'Back to work', category: 'ROUTINE_SUPPORT' }).expect(400);
      expect(missing.body.errors.map(({ path }: { path: string }) => path).sort()).toEqual(['comment', 'resourceProfileId', 'weeklyHours']);
      const routine = await patch(f.moderator, training.body.id, 3, {
        reason: 'Back to work', category: 'ROUTINE_SUPPORT', resourceProfileId: f.profile.id, weeklyHours: 10, comment: 'Support',
      }).expect(200);
      expect(routine.body).toMatchObject({ category: 'ROUTINE_SUPPORT', weeklyHours: 10, resourceProfile: { id: f.profile.id } });

      const { allocation } = await requestAllocation(f, addDays(day, 3), addDays(day, 9));
      await patch(f.admin, allocation.id, 1, { reason: 'Convert', category: 'TRAINING' }).expect(422);
      const direct = await create(f.moderator, { personId: f.member.id, category: 'TRAINING', resourceProfileId: f.profile.id, startDate: day, endDate: day, weeklyHours: 2, comment: 'X' });
      await request(app!.getHttpServer()).patch(`${allocationsPath}/${direct.body.id}`).set(headers(f.moderator, 1)).set('Content-Type', 'application/merge-patch+json')
        .send({ reason: 'Convert', category: 'EXECUTION_PROJECT' }).expect(400);
    });

    it('derives states from edited dates while holding suspension until the new period ends', async () => {
      const f = await setup();
      const day = await today();
      const own = await create(f.member, { category: 'TRAINING', resourceProfileId: f.profile.id, startDate: addDays(day, -3), endDate: addDays(day, 5), weeklyHours: 4, comment: 'Course' });
      await command(f.member, own.body.id, 1, 'suspensions').expect(200);
      const held = await patch(f.moderator, own.body.id, 2, { reason: 'Extend', endDate: addDays(day, 20) }).expect(200);
      expect(held.body.state).toBe('SUSPENDED');
      const ended = await patch(f.moderator, own.body.id, 3, { reason: 'Ended earlier', startDate: addDays(day, -10), endDate: addDays(day, -1) }).expect(200);
      expect(ended.body).toMatchObject({ state: 'DONE', endDate: addDays(day, -1) });
      const future = await create(f.member, { category: 'TRAINING', resourceProfileId: f.profile.id, startDate: day, endDate: day, weeklyHours: 4, comment: 'Course' });
      expect((await patch(f.moderator, future.body.id, 1, { reason: 'Move', startDate: addDays(day, 2), endDate: addDays(day, 2) }).expect(200)).body.state).toBe('NOT_STARTED');
      expect((await patch(f.moderator, future.body.id, 2, { reason: 'Back', startDate: day, endDate: day }).expect(200)).body.state).toBe('IN_PROGRESS');
    });

    it('lets only Admin correct the recorded classification and keeps it on other edits', async () => {
      const f = await setup();
      const day = await today();
      const own = await create(f.member, { category: 'TRAINING', resourceProfileId: f.profile.id, startDate: day, endDate: addDays(day, 5), weeklyHours: 4, comment: 'Course' });
      await dataSource!.getRepository(ResourcePerson).update(f.member.id, { classification: ResourcePersonClassification.ThirdParty });
      expect((await patch(f.moderator, own.body.id, 1, { reason: 'Hours', weeklyHours: 6 }).expect(200)).body.classification).toBe('INTERNAL');
      await patch(f.moderator, own.body.id, 2, { reason: 'Fix', classification: 'THIRD_PARTY' }).expect(403);
      const corrected = await patch(f.admin, own.body.id, 2, { reason: 'Contract evidence', classification: null }).expect(200);
      expect(corrected.body.classification).toBeNull();
    });
  });

  describe('reopening (#96)', () => {
    it('lets only Admin reopen closed allocations with new dates and eligible replacements', async () => {
      const f = await setup();
      const day = await today();
      const own = await create(f.member, { category: 'TRAINING', resourceProfileId: f.profile.id, startDate: day, endDate: addDays(day, 5), weeklyHours: 4, comment: 'Course' });
      await reopen(f.admin, own.body.id, 1, { reason: 'Not closed', startDate: day, endDate: day }).expect(422);
      await command(f.member, own.body.id, 1, 'cancellations', 'Recorded by mistake').expect(200);
      await clearNotices();
      await reopen(f.moderator, own.body.id, 2, { reason: 'Reopen', startDate: day, endDate: day }).expect(403);
      await reopen(f.admin, own.body.id, 2, { reason: 'Reopen' }).expect(400);
      const reopened = await reopen(f.admin, own.body.id, 2, {
        reason: 'Training rescheduled', startDate: addDays(day, 7), endDate: addDays(day, 9), personId: f.contractor.id, resourceProfileId: f.otherProfile.id,
      }).expect(200);
      expect(reopened.body).toMatchObject({ state: 'NOT_STARTED', person: { personId: f.contractor.id }, classification: 'THIRD_PARTY', resourceProfile: { id: f.otherProfile.id }, version: 3 });
      const actions = (await dataSource!.getRepository(ResourceAllocationHistory).find({ where: { allocationId: own.body.id }, order: { occurredAt: 'ASC' } })).map(({ action }) => action);
      expect(actions).toEqual(['SELF_ALLOCATION_CREATED', expect.stringContaining('CANCEL'), 'ALLOCATION_REOPENED']);
      expect(await notices(f.member)).toEqual(['ALLOCATION_REOPENED_3']);
      expect(await notices(f.contractor)).toEqual(['ALLOCATION_REOPENED_3']);
    });

    it('requires an active group and ITDM, and serializes two concurrent reopen attempts', async () => {
      const f = await setup();
      const day = await today();
      const { allocation } = await requestAllocation(f, addDays(day, -10), addDays(day, -2));
      await dataSource!.query("UPDATE resource_allocations SET state = 'DONE' WHERE id = $1::uuid", [allocation.id]);
      await dataSource!.getRepository(ResourceInitiative).update(f.initiative.id, { active: false });
      await reopen(f.admin, allocation.id, 1, { reason: 'Reopen', startDate: day, endDate: day }).expect(422);
      await dataSource!.getRepository(ResourceInitiative).update(f.initiative.id, { active: true });
      const attempts = await Promise.all([
        reopen(f.admin, allocation.id, 1, { reason: 'First', startDate: day, endDate: addDays(day, 3) }),
        reopen(f.admin, allocation.id, 1, { reason: 'Second', startDate: day, endDate: addDays(day, 4) }),
      ]);
      expect(attempts.map(({ status }) => status).sort()).toEqual([200, 412]);
      expect(await dataSource!.getRepository(ResourceAllocationHistory).countBy({ allocationId: allocation.id, action: 'ALLOCATION_REOPENED' })).toBe(1);
      expect((await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: allocation.id })).state).toBe('IN_PROGRESS');
    });
  });

  describe('cancellation and state-change notices (#97)', () => {
    it('lets a person cancel their own open allocation with a reason, keeps it readable, and notifies group leaders only', async () => {
      const f = await setup();
      const day = await today();
      const own = await create(f.member, { category: 'TRAINING', resourceProfileId: f.profile.id, startDate: addDays(day, 2), endDate: addDays(day, 5), weeklyHours: 4, comment: 'Course' });
      await clearNotices();
      await command(f.member, own.body.id, 1, 'cancellations', '   ').expect(400);
      const canceled = await command(f.member, own.body.id, 1, 'cancellations', 'Recorded by mistake').expect(200);
      expect(canceled.body.state).toBe('CANCELED');
      await request(app!.getHttpServer()).get(`${allocationsPath}/${own.body.id}`).set('X-PMO-Local-User-ID', f.member.localUserId).expect(200);
      expect(await dataSource!.getRepository(ResourceAllocation).countBy({ id: own.body.id })).toBe(1);
      for (const leader of [f.moderator, f.supervisor, f.manager]) expect(await notices(leader)).toEqual(['ALLOCATION_CANCELED_2']);
      expect(await notices(f.member)).toEqual([]);
    });

    it('notifies the allocated person and requester, not other leaders, when leadership changes the state', async () => {
      const f = await setup();
      const day = await today();
      const { allocation } = await requestAllocation(f, day, addDays(day, 9));
      await dataSource!.query("UPDATE resource_allocations SET state = 'IN_PROGRESS' WHERE id = $1::uuid", [allocation.id]);
      await command(f.moderator, allocation.id, 1, 'suspensions', 'Blocked by dependency').expect(200);
      expect(await notices(f.member)).toEqual(['ALLOCATION_SUSPENDED_2']);
      expect(await notices(f.requester)).toEqual(['ALLOCATION_SUSPENDED_2']);
      for (const leader of [f.moderator, f.supervisor, f.manager]) expect(await notices(leader)).toEqual([]);
    });
  });
});
