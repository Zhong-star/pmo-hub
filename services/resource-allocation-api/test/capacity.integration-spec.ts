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
import { ResourceGroup } from '../src/groups/resource-group.entity';
import { ResourcePerson } from '../src/people/resource-person.entity';
import { ResourceAllocationRole } from '../src/people/resource-allocation-role';
import { ResourceProfile } from '../src/resource-profiles/resource-profile.entity';

describe('Tech Resource Allocation capacity maintenance (#98)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_capacity_test')
      .withUsername('resource_allocation_test')
      .withPassword('test_only_password')
      .start();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(container.getConnectionUri())],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
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
    return dataSource!.getRepository(ResourcePerson).save(dataSource!.getRepository(ResourcePerson).create({
      localUserId,
      displayName: localUserId,
      email: `${localUserId}@example.test`,
      role,
      active: true,
      coveredGroupIds: [],
      groupId,
    }));
  }

  async function addGroupWithProfile() {
    const supervisor = await addPerson('capacity-supervisor', ResourceAllocationRole.Supervisor);
    const manager = await addPerson('capacity-manager', ResourceAllocationRole.Manager);
    const groupRepository = dataSource!.getRepository(ResourceGroup);
    const group = await groupRepository.save(groupRepository.create({
      name: 'Platform Engineering',
      active: true,
      supervisorId: supervisor.id,
      managerId: manager.id,
    }));
    const profileRepository = dataSource!.getRepository(ResourceProfile);
    const profile = await profileRepository.save(profileRepository.create({
      name: 'Software Engineer',
      groupId: group.id,
      active: true,
    }));
    return { group, profile, supervisor, manager };
  }

  it('lets an Admin create and list a rounded, versioned capacity entry', async () => {
    const admin = await addPerson('capacity-admin', ResourceAllocationRole.Admin);
    const { group, profile } = await addGroupWithProfile();
    const capacityPath = '/api/resource-allocation/v1/capacities';
    const createKey = randomUUID();

    const created = await request(app!.getHttpServer())
      .post(capacityPath)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', createKey)
      .send({
        groupId: group.id,
        resourceProfileId: profile.id,
        classification: 'INTERNAL',
        effectiveDate: '2027-01-04',
        fte: 0.15,
        reason: 'Initial annual capacity plan',
      })
      .expect('Content-Type', /application\/json/)
      .expect(201);

    expect(created.headers.etag).toBe('"1"');
    expect(created.headers.location).toBe(`${capacityPath}/${created.body.id}`);
    expect(created.body).toMatchObject({
      group: { id: group.id, name: 'Platform Engineering' },
      resourceProfile: { id: profile.id, name: 'Software Engineer', active: true },
      classification: 'INTERNAL',
      effectiveDate: '2027-01-04',
      fte: 0.2,
      version: 1,
    });

    const collection = await request(app!.getHttpServer())
      .get(capacityPath)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);

    expect(collection.body).toMatchObject({
      items: [{ id: created.body.id, classification: 'INTERNAL', effectiveDate: '2027-01-04', fte: 0.2 }],
      page: { nextCursor: null, limit: 50 },
    });

    const replayedCreate = await request(app!.getHttpServer())
      .post(capacityPath)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', createKey)
      .send({
        groupId: group.id,
        resourceProfileId: profile.id,
        classification: 'INTERNAL',
        effectiveDate: '2027-01-04',
        fte: 0.15,
        reason: 'Initial annual capacity plan',
      })
      .expect('Idempotency-Replayed', 'true')
      .expect(201);
    expect(replayedCreate.body.id).toBe(created.body.id);
  });

  it('replays the same capacity edit and exposes its immutable audit history', async () => {
    const admin = await addPerson('capacity-admin', ResourceAllocationRole.Admin);
    const { group, profile } = await addGroupWithProfile();
    const capacityPath = '/api/resource-allocation/v1/capacities';
    const created = await request(app!.getHttpServer())
      .post(capacityPath)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({
        groupId: group.id,
        resourceProfileId: profile.id,
        classification: 'THIRD_PARTY',
        effectiveDate: '2027-01-04',
        fte: 1,
        reason: 'Initial vendor plan',
      })
      .expect(201);
    const path = `${capacityPath}/${created.body.id}`;
    const editKey = randomUUID();
    const edit = () => request(app!.getHttpServer())
      .patch(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', editKey)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ fte: 40.1, reason: 'Approved headcount adjustment' });

    const updated = await edit().expect(200);
    expect(updated.headers.etag).toBe('"2"');
    expect(updated.body).toMatchObject({ fte: 40.1, version: 2 });

    const replayed = await edit()
      .expect('Idempotency-Replayed', 'true')
      .expect(200);
    expect(replayed.headers.etag).toBeUndefined();
    expect(replayed.body).toMatchObject({ id: created.body.id, fte: 40.1, version: 2 });

    const history = await request(app!.getHttpServer())
      .get(`${path}/history`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(history.body.items).toHaveLength(2);
    expect(history.body.items.map((event: { action: string }) => event.action)).toEqual(['CREATED', 'UPDATED']);
    expect(history.body.items[1]).toMatchObject({
      actor: { id: admin.id, displayName: admin.displayName },
      reason: 'Approved headcount adjustment',
      before: { fte: 1 },
      after: { fte: 40.1 },
    });
  });

  it('prevents a capacity-backed profile from moving groups through Admin maintenance', async () => {
    const admin = await addPerson('capacity-admin', ResourceAllocationRole.Admin);
    const { group, profile, supervisor, manager } = await addGroupWithProfile();
    const secondGroup = await dataSource!.getRepository(ResourceGroup).save(dataSource!.getRepository(ResourceGroup).create({
      name: 'Data Platform',
      active: true,
      supervisorId: supervisor.id,
      managerId: manager.id,
    }));
    const capacity = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/capacities')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({
        groupId: group.id,
        resourceProfileId: profile.id,
        classification: 'INTERNAL',
        effectiveDate: '2027-01-04',
        fte: 2,
        reason: 'Capacity plan that pins the profile to its group',
      })
      .expect(201);

    const profilePath = `/api/resource-allocation/v1/admin/resource-profiles/${profile.id}`;
    const moveProfile = () => request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/resource-profiles/${profile.id}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ groupId: secondGroup.id });
    const moved = await moveProfile()
      .expect('Content-Type', /application\/problem\+json/)
      .expect(409);
    expect(moved.body.code).toBe('RESOURCE_CONFLICT');

    await request(app!.getHttpServer())
      .delete(`/api/resource-allocation/v1/capacities/${capacity.body.id}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Remove unused planned capacity' })
      .expect(204);
    const movedAfterRemoval = await moveProfile()
      .expect('Content-Type', /application\/problem\+json/)
      .expect(409);
    expect(movedAfterRemoval.body.code).toBe('RESOURCE_CONFLICT');

    const unchanged = await request(app!.getHttpServer())
      .get(profilePath)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(unchanged.body.groupId).toBe(group.id);
  });

  it('accepts zero and large FTE, rejects invalid values, and serializes duplicate keys', async () => {
    const admin = await addPerson('capacity-admin', ResourceAllocationRole.Admin);
    const { group, profile } = await addGroupWithProfile();
    const path = '/api/resource-allocation/v1/capacities';
    const create = (classification: string, effectiveDate: string, fte: number, idempotencyKey = randomUUID()) =>
      request(app!.getHttpServer())
        .post(path)
        .set('X-PMO-Local-User-ID', admin.localUserId)
        .set('Idempotency-Key', idempotencyKey)
        .send({ groupId: group.id, resourceProfileId: profile.id, classification, effectiveDate, fte, reason: 'Approved capacity baseline' });

    const zero = await create('INTERNAL', '2027-01-04', 0).expect(201);
    expect(zero.body.fte).toBe(0);
    const large = await create('THIRD_PARTY', '2027-01-04', 1_000_000).expect(201);
    expect(large.body.fte).toBe(1_000_000);

    const negative = await create('INTERNAL', '2027-01-11', -0.1).expect(400);
    expect(negative.body.code).toBe('VALIDATION_ERROR');
    const unclassified = await create('UNCLASSIFIED', '2027-01-11', 1).expect(400);
    expect(unclassified.body.code).toBe('VALIDATION_ERROR');

    const duplicate = await create('INTERNAL', '2027-01-04', 2).expect(409);
    expect(duplicate.body.code).toBe('RESOURCE_CONFLICT');

    const concurrent = await Promise.all([
      create('INTERNAL', '2027-01-11', 2),
      create('INTERNAL', '2027-01-11', 3),
    ]);
    expect(concurrent.map(({ status }) => status).sort()).toEqual([201, 409]);
  });

  it('enforces leadership scope and blocks date-based permission bypasses', async () => {
    const admin = await addPerson('capacity-admin', ResourceAllocationRole.Admin);
    const { group, profile, supervisor, manager } = await addGroupWithProfile();
    const moderator = await addPerson('capacity-moderator', ResourceAllocationRole.Moderator, group.id);
    const path = '/api/resource-allocation/v1/capacities';
    const postAs = (actor: ResourcePerson, date: string, classification = 'INTERNAL') => request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', actor.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ groupId: group.id, resourceProfileId: profile.id, classification, effectiveDate: date, fte: 1, reason: 'Leadership capacity plan' });

    await postAs(supervisor, '2099-01-04').expect(201);
    await postAs(manager, '2099-01-05').expect(201);
    const future = await postAs(moderator, '2099-01-06').expect(201);
    const newGroup = await dataSource!.getRepository(ResourceGroup).save(dataSource!.getRepository(ResourceGroup).create({
      name: 'Security Engineering', active: true, supervisorId: admin.id, managerId: admin.id,
    }));
    const newProfile = await dataSource!.getRepository(ResourceProfile).save(dataSource!.getRepository(ResourceProfile).create({
      name: 'Security Engineer', groupId: newGroup.id, active: true,
    }));
    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ groupId: newGroup.id, resourceProfileId: newProfile.id, classification: 'INTERNAL', effectiveDate: '2099-01-04', fte: 1, reason: 'Out-of-scope plan' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(403);

    const outOfScopeEntry = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ groupId: newGroup.id, resourceProfileId: newProfile.id, classification: 'INTERNAL', effectiveDate: '2099-01-08', fte: 1, reason: 'Admin global capacity plan' })
      .expect(201);
    await request(app!.getHttpServer())
      .get(`${path}?groupId=${newGroup.id}`)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .expect(403);
    await request(app!.getHttpServer())
      .get(`${path}/${outOfScopeEntry.body.id}`)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .expect(403);
    await request(app!.getHttpServer())
      .get(`${path}/${outOfScopeEntry.body.id}/history`)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .expect(403);

    const pastForAdmin = await postAs(admin, '2000-01-03', 'THIRD_PARTY').expect(201);
    const moderatorCannotChangePast = await request(app!.getHttpServer())
      .patch(`${path}/${pastForAdmin.body.id}`)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'application/merge-patch+json')
      .send({ effectiveDate: '2099-01-07', reason: 'Move historic capacity forward' })
      .expect(403);
    expect(moderatorCannotChangePast.body.code).toBe('ACCESS_DENIED');

    const moderatorCannotBackdate = await request(app!.getHttpServer())
      .patch(`${path}/${future.body.id}`)
      .set('X-PMO-Local-User-ID', moderator.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'application/merge-patch+json')
      .send({ effectiveDate: '2000-01-03', reason: 'Backdate future capacity' })
      .expect(403);
    expect(moderatorCannotBackdate.body.code).toBe('ACCESS_DENIED');

    const user = await addPerson('capacity-user', ResourceAllocationRole.User);
    await request(app!.getHttpServer())
      .get(path)
      .set('X-PMO-Local-User-ID', user.localUserId)
      .expect(403);
  });

  it('covers covered groups, denies other leaders, locks past removal to Admin, and rejects a move onto a taken date', async () => {
    const admin = await addPerson('capacity-admin', ResourceAllocationRole.Admin);
    const { group, profile, supervisor, manager } = await addGroupWithProfile();
    const outsiderSupervisor = await addPerson('capacity-outsider-supervisor', ResourceAllocationRole.Supervisor);
    const outsiderManager = await addPerson('capacity-outsider-manager', ResourceAllocationRole.Manager);
    const covering = await addPerson('capacity-covering-manager', ResourceAllocationRole.Manager);
    await dataSource!.getRepository(ResourcePerson).update(covering.id, { coveredGroupIds: [group.id] });
    const path = '/api/resource-allocation/v1/capacities';
    const body = (effectiveDate: string) => ({
      groupId: group.id, resourceProfileId: profile.id, classification: 'INTERNAL', effectiveDate, fte: 1, reason: 'Plan',
    });
    const post = (actor: ResourcePerson, effectiveDate: string) => request(app!.getHttpServer())
      .post(path).set('X-PMO-Local-User-ID', actor.localUserId).set('Idempotency-Key', randomUUID()).send(body(effectiveDate));
    const patch = (actor: ResourcePerson, id: string, version: number, change: Record<string, unknown>) => request(app!.getHttpServer())
      .patch(`${path}/${id}`).set('X-PMO-Local-User-ID', actor.localUserId).set('If-Match', `"${version}"`)
      .set('Idempotency-Key', randomUUID()).set('Content-Type', 'application/merge-patch+json').send({ reason: 'Correction', ...change });
    const remove = (actor: ResourcePerson, id: string, version: number) => request(app!.getHttpServer())
      .delete(`${path}/${id}`).set('X-PMO-Local-User-ID', actor.localUserId).set('If-Match', `"${version}"`)
      .set('Idempotency-Key', randomUUID()).send({ reason: 'Remove' });

    const covered = await post(covering, '2099-03-01').expect(201);
    await post(outsiderSupervisor, '2099-03-02').expect(403);
    await post(outsiderManager, '2099-03-03').expect(403);
    await request(app!.getHttpServer()).get(`${path}/${covered.body.id}`).set('X-PMO-Local-User-ID', outsiderManager.localUserId).expect(403);
    await post(supervisor, '2099-03-08').expect(201);

    const taken = await patch(manager, covered.body.id, 1, { effectiveDate: '2099-03-08' }).expect(409);
    expect(taken.body.code).toBe('RESOURCE_CONFLICT');

    const past = await post(admin, '2001-01-01').expect(201);
    await remove(supervisor, past.body.id, 1).expect(403);
    await patch(manager, past.body.id, 1, { fte: 2 }).expect(403);
    const corrected = await patch(admin, past.body.id, 1, { fte: 2, effectiveDate: '2001-01-02' }).expect(200);
    expect(corrected.body).toMatchObject({ fte: 2, effectiveDate: '2001-01-02', version: 2 });
    await remove(admin, past.body.id, 2).expect(204);

    await dataSource!.getRepository(ResourcePerson).update(covering.id, { active: false });
    await post(covering, '2099-04-01').expect(403);
  });

  it('orders entries chronologically within each group, profile, and classification and shows when each value ends', async () => {
    const admin = await addPerson('capacity-admin', ResourceAllocationRole.Admin);
    const { group, profile } = await addGroupWithProfile();
    const path = '/api/resource-allocation/v1/capacities';
    for (const [effectiveDate, classification] of [['2099-03-01', 'INTERNAL'], ['2099-01-04', 'INTERNAL'], ['2099-02-01', 'THIRD_PARTY'], ['2099-02-01', 'INTERNAL']]) {
      await request(app!.getHttpServer()).post(path).set('X-PMO-Local-User-ID', admin.localUserId).set('Idempotency-Key', randomUUID())
        .send({ groupId: group.id, resourceProfileId: profile.id, classification, effectiveDate, fte: 1, reason: 'Plan' }).expect(201);
    }
    const seen: Array<[string, string, string | null]> = [];
    let cursor: string | null = null;
    do {
      const page: { body: { items: Array<{ classification: string; effectiveDate: string; effectiveUntil: string | null }>; page: { nextCursor: string | null } } } = await request(app!.getHttpServer()).get(path).query({ limit: 1, ...(cursor ? { cursor } : {}) })
        .set('X-PMO-Local-User-ID', admin.localUserId).expect(200);
      for (const item of page.body.items) seen.push([item.classification, item.effectiveDate, item.effectiveUntil]);
      cursor = page.body.page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([
      ['INTERNAL', '2099-01-04', '2099-01-31'],
      ['INTERNAL', '2099-02-01', '2099-02-28'],
      ['INTERNAL', '2099-03-01', null],
      ['THIRD_PARTY', '2099-02-01', null],
    ]);
    const stringValue = await request(app!.getHttpServer()).post(path).set('X-PMO-Local-User-ID', admin.localUserId).set('Idempotency-Key', randomUUID())
      .send({ groupId: group.id, resourceProfileId: profile.id, classification: 'THIRD_PARTY', effectiveDate: '2099-05-01', fte: '', reason: 'Plan' });
    expect(stringValue.status).toBe(400);
  });

  it('removes a future vigency without erasing its audit tombstone or prior capacity', async () => {
    const admin = await addPerson('capacity-admin', ResourceAllocationRole.Admin);
    const { group, profile } = await addGroupWithProfile();
    const path = '/api/resource-allocation/v1/capacities';
    const create = (date: string, fte: number) => request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ groupId: group.id, resourceProfileId: profile.id, classification: 'INTERNAL', effectiveDate: date, fte, reason: 'Approved capacity forecast' });
    const earlier = await create('2027-01-04', 1.5).expect(201);
    const later = await create('2027-02-01', 0).expect(201);
    const firstPage = await request(app!.getHttpServer())
      .get(`${path}?limit=1`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(firstPage.body.items).toHaveLength(1);
    expect(firstPage.body.page.nextCursor).toEqual(expect.any(String));
    const secondPage = await request(app!.getHttpServer())
      .get(`${path}?limit=1&cursor=${encodeURIComponent(firstPage.body.page.nextCursor)}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.items[0].id).not.toBe(firstPage.body.items[0].id);

    const removalKey = randomUUID();
    const removal = () => request(app!.getHttpServer())
      .delete(`${path}/${later.body.id}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', removalKey)
      .send({ reason: 'Restore the previous capacity period' });
    await removal().expect(204);
    await removal().expect(204);

    const active = await request(app!.getHttpServer())
      .get(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(active.body.items).toHaveLength(1);
    expect(active.body.items[0]).toMatchObject({ id: earlier.body.id, effectiveDate: '2027-01-04', fte: 1.5 });

    const firstHistoryPage = await request(app!.getHttpServer())
      .get(`${path}/${later.body.id}/history?limit=1`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(firstHistoryPage.body.items.map((event: { action: string }) => event.action)).toEqual(['CREATED']);
    expect(firstHistoryPage.body.page.nextCursor).toEqual(expect.any(String));
    const secondHistoryPage = await request(app!.getHttpServer())
      .get(`${path}/${later.body.id}/history?limit=1&cursor=${encodeURIComponent(firstHistoryPage.body.page.nextCursor)}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(secondHistoryPage.body.items.map((event: { action: string }) => event.action)).toEqual(['REMOVED']);
    expect(secondHistoryPage.body.items[0]).toMatchObject({
      reason: 'Restore the previous capacity period',
      before: { effectiveDate: '2027-02-01', fte: 0 },
      after: null,
    });

    await create('2027-02-01', 0.5).expect(201);
    const afterReplacement = await request(app!.getHttpServer())
      .get(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(afterReplacement.body.items).toHaveLength(2);
  });

  it('preserves and displays inactive profile capacity while excluding it from new selections', async () => {
    const admin = await addPerson('capacity-admin', ResourceAllocationRole.Admin);
    const { group, profile } = await addGroupWithProfile();
    const path = '/api/resource-allocation/v1/capacities';
    const capacity = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ groupId: group.id, resourceProfileId: profile.id, classification: 'INTERNAL', effectiveDate: '2027-01-04', fte: 1.4, reason: 'Existing profile capacity' })
      .expect(201);

    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/resource-profiles/${profile.id}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ active: false })
      .expect(200);

    const capacities = await request(app!.getHttpServer())
      .get(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(capacities.body.items).toMatchObject([{ id: capacity.body.id, fte: 1.4, resourceProfile: { active: false } }]);

    const options = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/capacity-options')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(options.body.groups).toMatchObject([{ id: group.id, resourceProfiles: [] }]);

    const unavailable = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ groupId: group.id, resourceProfileId: profile.id, classification: 'INTERNAL', effectiveDate: '2027-01-11', fte: 2, reason: 'New capacity on inactive profile' })
      .expect(422);
    expect(unavailable.body.code).toBe('CAPACITY_TARGET_NOT_ELIGIBLE');
  });

  it('serializes concurrent edits using the capacity ETag', async () => {
    const admin = await addPerson('capacity-admin', ResourceAllocationRole.Admin);
    const { group, profile } = await addGroupWithProfile();
    const path = '/api/resource-allocation/v1/capacities';
    const created = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ groupId: group.id, resourceProfileId: profile.id, classification: 'INTERNAL', effectiveDate: '2027-01-04', fte: 1, reason: 'Initial plan' })
      .expect(201);
    const update = (fte: number) => request(app!.getHttpServer())
      .patch(`${path}/${created.body.id}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'application/merge-patch+json')
      .send({ fte, reason: 'Competing capacity adjustment' });
    const outcomes = await Promise.all([update(2), update(3)]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 412]);

    const capacityHistory = await request(app!.getHttpServer())
      .get(`${path}/${created.body.id}/history`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(capacityHistory.body.items).toHaveLength(2);
  });
});
