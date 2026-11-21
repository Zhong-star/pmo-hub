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
import { ResourceInitiative } from '../src/initiatives/resource-initiative.entity';
import { ResourceAllocationSubmissionWorker } from '../src/submissions/resource-allocation-submission.worker';

describe('Tech Resource Allocation administration (#59)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_admin_test')
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

  it('denies non-Admins access to administrative collections', async () => {
    const user = await addPerson('ordinary-user', ResourceAllocationRole.User);

    const response = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/admin/initiatives')
      .set('X-PMO-Local-User-ID', user.localUserId)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(403);

    expect(response.body).toMatchObject({ status: 403, code: 'ACCESS_DENIED' });
  });

  it('lets an Admin create and list an ITDM initiative', async () => {
    const admin = await addPerson('allocation-admin', ResourceAllocationRole.Admin);

    const created = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/initiatives')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ code: '  ITDM-041  ', name: 'Planning portal' })
      .expect('Content-Type', /application\/json/)
      .expect(201);

    expect(created.headers.etag).toBe('"1"');
    expect(created.headers.location).toBe(`/api/resource-allocation/v1/admin/initiatives/${created.body.id}`);
    expect(created.body).toMatchObject({ code: 'ITDM-041', name: 'Planning portal', active: true, version: 1 });

    const collection = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/admin/initiatives')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);

    expect(collection.body).toMatchObject({
      items: [{ id: created.body.id, code: 'ITDM-041', name: 'Planning portal' }],
      page: { nextCursor: null, limit: 50 },
    });
  });

  it('requires the current ETag to update an ITDM', async () => {
    const admin = await addPerson('allocation-admin', ResourceAllocationRole.Admin);
    const created = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/initiatives')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ code: 'ITDM-042', name: 'Data model' })
      .expect(201);
    const path = `/api/resource-allocation/v1/admin/initiatives/${created.body.id}`;

    const missingVersion = await request(app!.getHttpServer())
      .patch(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Updated data model' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(missingVersion.body.code).toBe('VALIDATION_ERROR');

    await request(app!.getHttpServer())
      .patch(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"99"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Updated data model' })
      .expect(412);

    const updated = await request(app!.getHttpServer())
      .patch(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ code: ' ITDM-042 ', name: 'Updated data model' })
      .expect('ETag', '"2"')
      .expect(200);

    expect(updated.body).toMatchObject({ code: 'ITDM-042', name: 'Updated data model', version: 2 });
  });

  it('treats ITDM codes as unique after trimming and ignoring case', async () => {
    const admin = await addPerson('allocation-admin', ResourceAllocationRole.Admin);
    await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/initiatives')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ code: ' ITDM-043 ', name: 'First entry' })
      .expect(201);

    const duplicate = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/initiatives')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ code: 'itdm-043', name: 'Second entry' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(409);

    expect(duplicate.body).toMatchObject({ code: 'RESOURCE_CONFLICT', status: 409 });
  });

  it('enforces trimmed ITDM code and name limits', async () => {
    const admin = await addPerson('allocation-admin', ResourceAllocationRole.Admin);
    const path = '/api/resource-allocation/v1/admin/initiatives';

    const valid = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ code: `${' '.repeat(10)}${'I'.repeat(100)}${' '.repeat(10)}`, name: `${' '.repeat(4)}${'N'.repeat(200)}${' '.repeat(4)}` })
      .expect(201);
    expect(valid.body.code).toBe('I'.repeat(100));
    expect(valid.body.name).toBe('N'.repeat(200));

    const tooLongCode = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ code: 'I'.repeat(101), name: 'Over-limit code' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(tooLongCode.body.code).toBe('VALIDATION_ERROR');

    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ code: 'ITDM-LIMIT-1', name: 'N'.repeat(201) })
      .expect(400);

    await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Missing code' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);

    await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/people')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ localUserId: 'invalid-role-person', displayName: 'Invalid', email: 'invalid@example.test', role: 'ALLOCATION_COORDINATOR' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
  });

  it('replays an identical create receipt and conflicts when its content changes', async () => {
    const admin = await addPerson('allocation-admin', ResourceAllocationRole.Admin);
    const key = randomUUID();
    const path = '/api/resource-allocation/v1/admin/initiatives';
    const body = { code: 'ITDM-045', name: 'Capacity planner' };

    const missingKey = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .send(body)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(missingKey.body.code).toBe('VALIDATION_ERROR');

    const created = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const replay = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', key)
      .send(body)
      .expect('Idempotency-Replayed', 'true')
      .expect(201);

    expect(replay.body).toEqual(created.body);
    expect(replay.headers.location).toBe(created.headers.location);
    expect(replay.headers.etag).toBeUndefined();

    const changed = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', key)
      .send({ code: 'ITDM-046', name: 'Different content' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(409);

    expect(changed.body).toMatchObject({ code: 'RESOURCE_CONFLICT', status: 409 });
    expect(await dataSource!.getRepository(ResourceInitiative).count()).toBe(1);
  });

  it('scopes an idempotency key to the active Admin actor', async () => {
    const firstAdmin = await addPerson('admin-one', ResourceAllocationRole.Admin);
    const secondAdmin = await addPerson('admin-two', ResourceAllocationRole.Admin);
    const key = randomUUID();
    const path = '/api/resource-allocation/v1/admin/initiatives';

    const first = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', firstAdmin.localUserId)
      .set('Idempotency-Key', key)
      .send({ code: 'ITDM-047', name: 'First actor initiative' })
      .expect(201);
    const second = await request(app!.getHttpServer())
      .post(path)
      .set('X-PMO-Local-User-ID', secondAdmin.localUserId)
      .set('Idempotency-Key', key)
      .send({ code: 'ITDM-048', name: 'Second actor initiative' })
      .expect(201);

    expect(second.body.id).not.toBe(first.body.id);
    expect(await dataSource!.getRepository(ResourceInitiative).count()).toBe(2);
  });

  it('paginates beyond 50 and rejects a cursor reused with different filters', async () => {
    const admin = await addPerson('allocation-admin', ResourceAllocationRole.Admin);
    await dataSource!.getRepository(ResourceInitiative).save(Array.from({ length: 51 }, (_, index) => ({
      code: `PAGE-${index.toString().padStart(2, '0')}`,
      name: `Page initiative ${index}`,
      active: true,
    })));

    const firstPage = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/admin/initiatives?limit=50&active=true')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(firstPage.body.items).toHaveLength(50);
    expect(firstPage.body.page.limit).toBe(50);
    expect(firstPage.body.page.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/admin/initiatives?limit=50&active=true&cursor=${encodeURIComponent(firstPage.body.page.nextCursor)}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(secondPage.body.items).toHaveLength(1);
    expect(firstPage.body.items.map((item: { id: string }) => item.id)).not.toContain(secondPage.body.items[0].id);

    const wrongFilter = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/admin/initiatives?limit=50&active=false&cursor=${encodeURIComponent(firstPage.body.page.nextCursor)}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(wrongFilter.body.code).toBe('VALIDATION_ERROR');
  });

  it('replaces an active group responsible atomically and keeps leadership coverage current', async () => {
    const admin = await addPerson('allocation-admin', ResourceAllocationRole.Admin);
    const firstSupervisor = await addPerson('supervisor-one', ResourceAllocationRole.Supervisor);
    const secondSupervisor = await addPerson('supervisor-two', ResourceAllocationRole.Supervisor);
    const manager = await addPerson('group-manager', ResourceAllocationRole.Manager);

    const group = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/groups')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Platform Engineering', supervisorId: firstSupervisor.id, managerId: manager.id })
      .expect(201);

    expect(group.headers.etag).toBe('"1"');
    expect(group.body).toMatchObject({
      name: 'Platform Engineering',
      active: true,
      supervisorId: firstSupervisor.id,
      managerId: manager.id,
      version: 1,
    });

    const replaced = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/groups/${group.body.id}`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ supervisorId: secondSupervisor.id })
      .expect('ETag', '"2"')
      .expect(200);

    expect(replaced.body.supervisorId).toBe(secondSupervisor.id);
    const [oldSupervisor, newSupervisor] = await Promise.all([
      request(app!.getHttpServer()).get(`/api/resource-allocation/v1/admin/people/${firstSupervisor.id}`)
        .set('X-PMO-Local-User-ID', admin.localUserId).expect(200),
      request(app!.getHttpServer()).get(`/api/resource-allocation/v1/admin/people/${secondSupervisor.id}`)
        .set('X-PMO-Local-User-ID', admin.localUserId).expect(200),
    ]);
    expect(oldSupervisor.body.coveredGroupIds).toEqual([]);
    expect(newSupervisor.body.coveredGroupIds).toEqual([group.body.id]);
  });

  it('returns only minimum active selection data to an authorized non-Admin', async () => {
    const admin = await addPerson('allocation-admin', ResourceAllocationRole.Admin);
    const supervisor = await addPerson('group-supervisor', ResourceAllocationRole.Supervisor);
    const manager = await addPerson('group-manager', ResourceAllocationRole.Manager);
    const group = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/groups')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Cloud Engineering', supervisorId: supervisor.id, managerId: manager.id })
      .expect(201);
    const user = await addPerson('flow-user', ResourceAllocationRole.User, group.body.id);
    await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/resource-profiles')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Platform Engineer', groupId: group.body.id })
      .expect(201);
    await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/initiatives')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ code: 'ITDM-044', name: 'Cloud migration' })
      .expect(201);

    const [people, groups, profiles, initiatives] = await Promise.all([
      request(app!.getHttpServer()).get('/api/resource-allocation/v1/people').set('X-PMO-Local-User-ID', user.localUserId).expect(200),
      request(app!.getHttpServer()).get('/api/resource-allocation/v1/groups').set('X-PMO-Local-User-ID', user.localUserId).expect(200),
      request(app!.getHttpServer()).get('/api/resource-allocation/v1/resource-profiles').set('X-PMO-Local-User-ID', user.localUserId).expect(200),
      request(app!.getHttpServer()).get('/api/resource-allocation/v1/initiatives').set('X-PMO-Local-User-ID', user.localUserId).expect(200),
    ]);

    expect(people.body.items).toContainEqual({ id: user.id, displayName: 'flow-user', groupId: group.body.id });
    expect(JSON.stringify(people.body)).not.toContain('@example.test');
    expect(JSON.stringify(people.body)).not.toContain('localUserId');
    expect(groups.body.items).toContainEqual({ id: group.body.id, name: 'Cloud Engineering' });
    expect(profiles.body.items).toEqual(expect.arrayContaining([expect.objectContaining({
      name: 'Platform Engineer',
      groupId: group.body.id,
    })]));
    expect(initiatives.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ITDM-044', name: 'Cloud migration' })]));
    expect(JSON.stringify(initiatives.body)).not.toContain('version');
  });

  it('preserves one active Admin when two deactivations race', async () => {
    const firstAdmin = await addPerson('admin-one', ResourceAllocationRole.Admin);
    const secondAdmin = await addPerson('admin-two', ResourceAllocationRole.Admin);

    const responses = await Promise.all([
      request(app!.getHttpServer())
        .patch(`/api/resource-allocation/v1/admin/people/${firstAdmin.id}`)
        .set('X-PMO-Local-User-ID', firstAdmin.localUserId)
        .set('If-Match', '"1"')
        .set('Content-Type', 'application/merge-patch+json')
        .send({ active: false }),
      request(app!.getHttpServer())
        .patch(`/api/resource-allocation/v1/admin/people/${secondAdmin.id}`)
        .set('X-PMO-Local-User-ID', secondAdmin.localUserId)
        .set('If-Match', '"1"')
        .set('Content-Type', 'application/merge-patch+json')
        .send({ active: false }),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 422]);
    const activeAdmins = await dataSource!.getRepository(ResourcePerson).count({
      where: { active: true, role: ResourceAllocationRole.Admin },
    });
    expect(activeAdmins).toBe(1);
    expect(responses.find(({ status }) => status === 422)?.body.code).toBe('LAST_ACTIVE_ADMIN_REQUIRED');
  });

  it('notifies all active Admins globally and target group leadership when deactivating a person with active commitments', async () => {
    const actingAdmin = await addPerson('acting-admin', ResourceAllocationRole.Admin);
    const unassignedAdmin = await addPerson('unassigned-admin', ResourceAllocationRole.Admin);
    const inactiveAdmin = await dataSource!.getRepository(ResourcePerson).save(dataSource!.getRepository(ResourcePerson).create({
      localUserId: 'inactive-admin',
      displayName: 'inactive-admin',
      email: 'inactive-admin@example.test',
      role: ResourceAllocationRole.Admin,
      active: false,
      coveredGroupIds: [],
      groupId: null,
    }));

    const targetSupervisor = await addPerson('target-supervisor', ResourceAllocationRole.Supervisor);
    const targetManager = await addPerson('target-manager', ResourceAllocationRole.Manager);
    const otherSupervisor = await addPerson('other-supervisor', ResourceAllocationRole.Supervisor);
    const otherManager = await addPerson('other-manager', ResourceAllocationRole.Manager);

    const createGroup = async (name: string, supervisorId: string, managerId: string) => {
      const response = await request(app!.getHttpServer())
        .post('/api/resource-allocation/v1/admin/groups')
        .set('X-PMO-Local-User-ID', actingAdmin.localUserId)
        .set('Idempotency-Key', randomUUID())
        .send({ name, supervisorId, managerId })
        .expect(201);
      return response.body.id as string;
    };

    const targetGroupId = await createGroup('Target Group', targetSupervisor.id, targetManager.id);
    const otherGroupId = await createGroup('Other Group', otherSupervisor.id, otherManager.id);

    const otherGroupAdmin = await addPerson('other-group-admin', ResourceAllocationRole.Admin, otherGroupId);
    const targetModerator = await addPerson('target-moderator', ResourceAllocationRole.Moderator, targetGroupId);
    const otherModerator = await addPerson('other-moderator', ResourceAllocationRole.Moderator, otherGroupId);
    await dataSource!.getRepository(ResourcePerson).save(dataSource!.getRepository(ResourcePerson).create({
      localUserId: 'inactive-target-moderator',
      displayName: 'inactive-target-moderator',
      email: 'inactive-target-moderator@example.test',
      role: ResourceAllocationRole.Moderator,
      active: false,
      coveredGroupIds: [],
      groupId: targetGroupId,
    }));

    const requester = await addPerson('commitment-requester', ResourceAllocationRole.User, targetGroupId);
    const assignee = await addPerson('commitment-assignee', ResourceAllocationRole.User, targetGroupId);

    const profileRes = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/resource-profiles')
      .set('X-PMO-Local-User-ID', actingAdmin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Backend Dev', groupId: targetGroupId })
      .expect(201);
    const initiativeRes = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/initiatives')
      .set('X-PMO-Local-User-ID', actingAdmin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({ code: 'ITDM-073', name: 'Global Admin Notice' })
      .expect(201);

    const futureDate = (days: number) => {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const [year, month, day] = today.split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
    };

    const activeAttemptKey = randomUUID();
    const endedAttemptKey = randomUUID();
    const submission = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', requester.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({
        initiativeId: initiativeRes.body.id,
        category: 'EXECUTION_PROJECT',
        lines: [
          {
            attemptKey: activeAttemptKey,
            groupId: targetGroupId,
            resourceProfileId: profileRes.body.id,
            startDate: futureDate(1),
            endDate: futureDate(10),
            weeklyHours: 16,
          },
          {
            attemptKey: endedAttemptKey,
            groupId: targetGroupId,
            resourceProfileId: profileRes.body.id,
            startDate: futureDate(0),
            endDate: futureDate(5),
            weeklyHours: 8,
          },
        ],
      })
      .expect(202);
    await app!.get(ResourceAllocationSubmissionWorker).processBatch(2);
    const lines = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${submission.body.id}/lines`)
      .set('X-PMO-Local-User-ID', requester.localUserId)
      .expect(200);
    const activeRequestId = lines.body.items.find((line: { attemptKey: string }) => line.attemptKey === activeAttemptKey).requestId as string;
    const endedRequestId = lines.body.items.find((line: { attemptKey: string }) => line.attemptKey === endedAttemptKey).requestId as string;

    const approveActive = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${activeRequestId}/approvals`)
      .set('X-PMO-Local-User-ID', actingAdmin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', randomUUID())
      .send({ personId: assignee.id })
      .expect(200);
    expect(approveActive.body.decisionState).toBe('APPROVED');

    const approveEnded = await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${endedRequestId}/approvals`)
      .set('X-PMO-Local-User-ID', actingAdmin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', randomUUID())
      .send({ personId: assignee.id })
      .expect(200);
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/allocations/${approveEnded.body.allocation.id}/completions`)
      .set('X-PMO-Local-User-ID', actingAdmin.localUserId)
      .set('If-Match', '"1"')
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', randomUUID())
      .send({ reason: 'Already completed before deactivation.' })
      .expect(200);

    await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/people/${assignee.id}`)
      .set('X-PMO-Local-User-ID', actingAdmin.localUserId)
      .set('If-Match', `"${assignee.version}"`)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ active: false })
      .expect(200);

    const activeNotices = await dataSource!.query(`
      SELECT recipient_id
      FROM resource_allocation_notifications
      WHERE source_request_id = $1 AND event_code LIKE 'PERSON_DEACTIVATED_%'
      ORDER BY recipient_id
    `, [activeRequestId]) as Array<{ recipient_id: string }>;
    expect(activeNotices.map((notice) => notice.recipient_id).sort()).toEqual([
      unassignedAdmin.id,
      otherGroupAdmin.id,
      targetModerator.id,
      targetSupervisor.id,
      targetManager.id,
    ].sort());
    expect(activeNotices.map((notice) => notice.recipient_id)).not.toContain(actingAdmin.id);
    expect(activeNotices.map((notice) => notice.recipient_id)).not.toContain(inactiveAdmin.id);
    expect(activeNotices.map((notice) => notice.recipient_id)).not.toContain(otherModerator.id);

    const endedNotices = await dataSource!.query(`
      SELECT recipient_id
      FROM resource_allocation_notifications
      WHERE source_request_id = $1 AND event_code LIKE 'PERSON_DEACTIVATED_%'
    `, [endedRequestId]);
    expect(endedNotices).toHaveLength(0);

    const [unassignedInbox, otherAdminInbox, actingInbox] = await Promise.all([
      request(app!.getHttpServer()).get('/api/resource-allocation/v1/notifications').set('X-PMO-Local-User-ID', unassignedAdmin.localUserId).expect(200),
      request(app!.getHttpServer()).get('/api/resource-allocation/v1/notifications').set('X-PMO-Local-User-ID', otherGroupAdmin.localUserId).expect(200),
      request(app!.getHttpServer()).get('/api/resource-allocation/v1/notifications').set('X-PMO-Local-User-ID', actingAdmin.localUserId).expect(200),
    ]);
    expect(unassignedInbox.body.items.some((item: { eventCode: string }) => item.eventCode.startsWith('PERSON_DEACTIVATED_'))).toBe(true);
    expect(otherAdminInbox.body.items.some((item: { eventCode: string }) => item.eventCode.startsWith('PERSON_DEACTIVATED_'))).toBe(true);
    expect(actingInbox.body.items.some((item: { eventCode: string }) => item.eventCode.startsWith('PERSON_DEACTIVATED_'))).toBe(false);
  });
});
