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
import { ResourceSubmission } from '../src/submissions/resource-submission.entity';
import { ResourceSubmissionLine } from '../src/submissions/resource-submission-line.entity';
import { ResourceSubmissionLineStatus } from '../src/submissions/submission-category';
import { ResourceRequest } from '../src/requests/resource-request.entity';
import { ResourceAllocation } from '../src/allocations/resource-allocation.entity';
import { ResourceAllocationHistory } from '../src/allocations/resource-allocation-history.entity';

const apiRoot = '/api/resource-allocation/v1';
const adminProfilesPath = `${apiRoot}/admin/resource-profiles`;

describe('delegated resource profile administration (#91)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_profile_delegation_test')
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
      displayName: localUserId,
      email: `${localUserId}@example.test`,
      role,
      active: true,
      groupId,
      coveredGroupIds: [],
    }));
  }

  async function setup() {
    const admin = await addPerson('profile-admin', ResourceAllocationRole.Admin);
    const user = await addPerson('profile-user', ResourceAllocationRole.User);
    const moderatorA = await addPerson('profile-moderator-a', ResourceAllocationRole.Moderator);
    const moderatorB = await addPerson('profile-moderator-b', ResourceAllocationRole.Moderator);
    const supervisor = await addPerson('profile-supervisor', ResourceAllocationRole.Supervisor);
    const manager = await addPerson('profile-manager', ResourceAllocationRole.Manager);
    const outsider = await addPerson('profile-outsider', ResourceAllocationRole.Supervisor);
    const groups = dataSource!.getRepository(ResourceGroup);
    const groupA = await groups.save(groups.create({ name: 'Platform', active: true, supervisorId: supervisor.id, managerId: manager.id }));
    const groupB = await groups.save(groups.create({ name: 'Data', active: true, supervisorId: outsider.id, managerId: outsider.id }));
    moderatorA.groupId = groupA.id;
    moderatorB.groupId = groupB.id;
    await dataSource!.getRepository(ResourcePerson).save([moderatorA, moderatorB]);
    const profiles = dataSource!.getRepository(ResourceProfile);
    const profileA = await profiles.save(profiles.create({ name: 'Platform Engineer', groupId: groupA.id, active: true }));
    const profileB = await profiles.save(profiles.create({ name: 'Data Engineer', groupId: groupB.id, active: true }));
    return { admin, user, moderatorA, moderatorB, supervisor, manager, outsider, groupA, groupB, profileA, profileB };
  }

  function createProfile(actor: ResourcePerson, groupId: string, key = randomUUID()) {
    return request(app!.getHttpServer())
      .post(adminProfilesPath)
      .set('X-PMO-Local-User-ID', actor.localUserId)
      .set('Idempotency-Key', key)
      .send({ name: 'Site Reliability Engineer', groupId });
  }

  it('lets a Moderator manage profiles in their own group and denies direct access outside it', async () => {
    const fixture = await setup();

    const created = await createProfile(fixture.moderatorA, fixture.groupA.id).expect(201);
    expect(created.headers.etag).toBe('"1"');
    expect(created.body).toMatchObject({ name: 'Site Reliability Engineer', groupId: fixture.groupA.id, active: true, version: 1 });

    const listed = await request(app!.getHttpServer())
      .get(adminProfilesPath)
      .set('X-PMO-Local-User-ID', fixture.moderatorA.localUserId)
      .expect(200);
    expect(listed.body.items.map((profile: { id: string }) => profile.id).sort()).toEqual([fixture.profileA.id, created.body.id].sort());

    const outsideRead = await request(app!.getHttpServer())
      .get(`${adminProfilesPath}/${fixture.profileB.id}`)
      .set('X-PMO-Local-User-ID', fixture.moderatorA.localUserId)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(403);
    expect(outsideRead.body.code).toBe('ACCESS_DENIED');

    const outsideCreate = await createProfile(fixture.moderatorA, fixture.groupB.id).expect(403);
    expect(outsideCreate.body.code).toBe('ACCESS_DENIED');
  });

  it.each([
    ['Supervisor', ResourceAllocationRole.Supervisor],
    ['Manager', ResourceAllocationRole.Manager],
  ] as const)('%s scope follows current group assignments rather than profile payload or cached coverage', async (_label, role) => {
    const fixture = await setup();
    const actor = role === ResourceAllocationRole.Supervisor ? fixture.supervisor : fixture.manager;

    const manageableGroups = await request(app!.getHttpServer())
      .get(`${apiRoot}/admin/resource-profile-groups`)
      .set('X-PMO-Local-User-ID', actor.localUserId)
      .expect(200);
    expect(manageableGroups.body.items).toEqual([{ id: fixture.groupA.id, name: 'Platform' }]);

    const created = await createProfile(actor, fixture.groupA.id).expect(201);
    expect(created.body.groupId).toBe(fixture.groupA.id);

    const outsideCreate = await createProfile(actor, fixture.groupB.id).expect(403);
    expect(outsideCreate.body.code).toBe('ACCESS_DENIED');
    await request(app!.getHttpServer())
      .patch(`${adminProfilesPath}/${fixture.profileB.id}`)
      .set('X-PMO-Local-User-ID', actor.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Moved into my scope', groupId: fixture.groupA.id })
      .expect(403);
  });

  it('rechecks scope at save time, preserves ETag conflicts, and records one immutable audit entry per change', async () => {
    const fixture = await setup();
    const key = randomUUID();
    const firstCreate = await createProfile(fixture.moderatorA, fixture.groupA.id, key).expect(201);
    await createProfile(fixture.moderatorA, fixture.groupA.id, key)
      .expect('Idempotency-Replayed', 'true')
      .expect(201);

    const updated = await request(app!.getHttpServer())
      .patch(`${adminProfilesPath}/${firstCreate.body.id}`)
      .set('X-PMO-Local-User-ID', fixture.moderatorA.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Platform SRE' })
      .expect('ETag', '"2"')
      .expect(200);
    expect(updated.body.name).toBe('Platform SRE');

    await request(app!.getHttpServer())
      .patch(`${adminProfilesPath}/${firstCreate.body.id}`)
      .set('X-PMO-Local-User-ID', fixture.moderatorA.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Stale update' })
      .expect(412);

    await dataSource!.getRepository(ResourcePerson).update(fixture.moderatorA.id, { groupId: fixture.groupB.id });
    await request(app!.getHttpServer())
      .patch(`${adminProfilesPath}/${firstCreate.body.id}`)
      .set('X-PMO-Local-User-ID', fixture.moderatorA.localUserId)
      .set('If-Match', '"2"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Out of scope edit' })
      .expect(403);

    await createProfile(fixture.moderatorA, fixture.groupA.id, key).expect(403);

    const detail = await request(app!.getHttpServer())
      .get(`${adminProfilesPath}/${firstCreate.body.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(detail.body).toMatchObject({ name: 'Platform SRE', version: 2 });

    const audits = await dataSource!.query(`
      SELECT action, before_snapshot, after_snapshot
      FROM resource_profile_audit_events
      WHERE profile_id = $1::uuid
      ORDER BY occurred_at, id
    `, [firstCreate.body.id]) as Array<{ action: string; before_snapshot: Record<string, unknown>; after_snapshot: Record<string, unknown> }>;
    expect(audits).toHaveLength(2);
    expect(audits.map((event) => event.action)).toEqual(['PROFILE_CREATED', 'PROFILE_RENAMED']);
    expect(audits[0].after_snapshot).toMatchObject({ name: 'Site Reliability Engineer', groupId: fixture.groupA.id, active: true });
    expect(audits[1].before_snapshot).toMatchObject({ name: 'Site Reliability Engineer' });
    expect(audits[1].after_snapshot).toMatchObject({ name: 'Platform SRE' });
  });

  it('keeps inactive profiles and historical references while excluding them from new selections', async () => {
    const fixture = await setup();
    const admin = fixture.admin;
    const created = await createProfile(admin, fixture.groupA.id).expect(201);
    const inactive = await request(app!.getHttpServer())
      .patch(`${adminProfilesPath}/${created.body.id}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ active: false })
      .expect('ETag', '"2"')
      .expect(200);
    expect(inactive.body.active).toBe(false);

    const adminDetail = await request(app!.getHttpServer())
      .get(`${adminProfilesPath}/${created.body.id}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(adminDetail.body).toMatchObject({ id: created.body.id, active: false });
    const selector = await request(app!.getHttpServer())
      .get(`${apiRoot}/resource-profiles`)
      .set('X-PMO-Local-User-ID', fixture.user.localUserId)
      .expect(200);
    expect(selector.body.items.map((profile: { id: string }) => profile.id)).not.toContain(created.body.id);
    expect(await dataSource!.getRepository(ResourceProfile).findOneBy({ id: created.body.id })).toMatchObject({ active: false });
  });

  it('shows a renamed profile in current completed allocation queries and leaves recorded events unchanged', async () => {
    const fixture = await setup();
    const todayRows = await dataSource!.query("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today") as Array<{ today: string }>;
    const today = new Date(`${todayRows[0].today}T00:00:00.000Z`);
    today.setUTCDate(today.getUTCDate() - 2);
    const endDate = today.toISOString().slice(0, 10);
    today.setUTCDate(today.getUTCDate() - 5);
    const startDate = today.toISOString().slice(0, 10);
    const now = new Date();
    const initiative = await dataSource!.getRepository(ResourceInitiative).save({
      code: `ITDM-${randomUUID().slice(0, 8)}`, name: 'Platform renewal', active: true, codeUsed: true,
    });
    const submission = await dataSource!.getRepository(ResourceSubmission).save({
      requesterId: fixture.user.id, category: 'EXECUTION_PROJECT', lineCount: 1, correlationId: randomUUID(),
    });
    const conditions = {
      groupId: fixture.groupA.id,
      resourceProfileId: fixture.profileA.id,
      resourceProfileName: fixture.profileA.name,
      initiativeId: initiative.id,
      startDate,
      endDate,
      weeklyHours: 12,
    };
    const line = await dataSource!.getRepository(ResourceSubmissionLine).save({
      submissionId: submission.id,
      requesterId: fixture.user.id,
      attemptKey: randomUUID(),
      attemptPayloadHash: 'a'.repeat(64),
      lineNumber: 0,
      submittedConditions: conditions,
      status: ResourceSubmissionLineStatus.Received,
      requestId: null,
      problem: null,
      requestOutcome: null,
      claimToken: null,
      claimedAt: null,
      completedAt: null,
    });
    const sourceRequest = await dataSource!.getRepository(ResourceRequest).save({
      submissionLineId: line.id,
      requesterId: fixture.user.id,
      requesterSnapshot: { id: fixture.user.id, displayName: fixture.user.displayName },
      requestedConditions: conditions,
      approvedConditions: conditions,
      decisionState: 'APPROVED',
      receivedAt: now,
      stageEnteredAt: now,
      expirationDueAt: now,
      removedAt: null,
    });
    await dataSource!.getRepository(ResourceSubmissionLine).update(line.id, {
      requestId: sourceRequest.id,
      status: ResourceSubmissionLineStatus.Succeeded,
      requestOutcome: { decisionState: 'APPROVED', requestedConditions: conditions },
      completedAt: now,
    });
    const allocation = await dataSource!.getRepository(ResourceAllocation).save({
      sourceRequestId: sourceRequest.id,
      personId: fixture.user.id,
      personSnapshot: { id: fixture.user.id, displayName: fixture.user.displayName },
      groupId: fixture.groupA.id,
      groupSnapshot: { id: fixture.groupA.id, name: 'Platform' },
      initiativeId: initiative.id,
      initiativeSnapshot: { id: initiative.id, code: initiative.code, name: initiative.name },
      resourceProfileId: fixture.profileA.id,
      resourceProfileSnapshot: { id: fixture.profileA.id, name: fixture.profileA.name },
      approvedStartDate: startDate,
      approvedEndDate: endDate,
      effectiveStartDate: startDate,
      effectiveEndDate: endDate,
      weeklyHours: '12.0',
      state: 'DONE',
      stateEnteredAt: now,
      approvedAt: now,
    });
    await dataSource!.getRepository(ResourceAllocationHistory).insert({
      allocationId: allocation.id,
      actorSnapshot: { displayName: 'Historical approver', role: 'ALLOCATION_ADMIN' },
      action: 'ALLOCATION_CREATED',
      reason: null,
      beforeSnapshot: { resourceProfile: { id: fixture.profileA.id, name: 'Platform Engineer' } },
      afterSnapshot: { resourceProfile: { id: fixture.profileA.id, name: 'Platform Engineer' } },
      correlationId: randomUUID(),
    });

    await request(app!.getHttpServer())
      .patch(`${adminProfilesPath}/${fixture.profileA.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ groupId: fixture.groupB.id })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(409);
    expect(await dataSource!.getRepository(ResourceProfile).findOneBy({ id: fixture.profileA.id })).toMatchObject({ groupId: fixture.groupA.id, version: 1 });

    const rename = await request(app!.getHttpServer())
      .patch(`${adminProfilesPath}/${fixture.profileA.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Platform Reliability Engineer' })
      .expect(200);
    expect(rename.body.name).toBe('Platform Reliability Engineer');

    const collection = await request(app!.getHttpServer())
      .get(`${apiRoot}/allocations`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(collection.body.items).toContainEqual(expect.objectContaining({
      id: allocation.id,
      state: 'DONE',
      resourceProfile: { id: fixture.profileA.id, name: 'Platform Reliability Engineer', active: true },
    }));

    const history = await request(app!.getHttpServer())
      .get(`${apiRoot}/allocations/${allocation.id}/history`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(history.body.items[0]).toMatchObject({
      before: { resourceProfile: { id: fixture.profileA.id, name: 'Platform Engineer' } },
      after: { resourceProfile: { id: fixture.profileA.id, name: 'Platform Engineer' } },
    });

    await request(app!.getHttpServer())
      .patch(`${adminProfilesPath}/${fixture.profileA.id}`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .set('If-Match', '"2"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ active: false })
      .expect(200);
    const inactiveCollection = await request(app!.getHttpServer())
      .get(`${apiRoot}/allocations`)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(inactiveCollection.body.items).toContainEqual(expect.objectContaining({
      id: allocation.id,
      resourceProfile: { id: fixture.profileA.id, name: 'Platform Reliability Engineer', active: false },
    }));
    expect(await dataSource!.getRepository(ResourceProfile).findOneBy({ id: fixture.profileA.id })).toMatchObject({ active: false });
  });

  it('keeps profile administration unavailable to User and preserves Admin global scope', async () => {
    const fixture = await setup();

    const denied = await request(app!.getHttpServer())
      .get(adminProfilesPath)
      .set('X-PMO-Local-User-ID', fixture.user.localUserId)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(403);
    expect(denied.body.code).toBe('ACCESS_DENIED');

    const adminList = await request(app!.getHttpServer())
      .get(adminProfilesPath)
      .set('X-PMO-Local-User-ID', fixture.admin.localUserId)
      .expect(200);
    expect(adminList.body.items.map((profile: { id: string }) => profile.id).sort()).toEqual([fixture.profileA.id, fixture.profileB.id].sort());
  });
});
