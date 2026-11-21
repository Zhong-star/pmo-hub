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
    expect(tooLongCode.body.errors).toEqual([
      { path: 'code', code: 'IS_TRIMMED_LENGTH', message: expect.any(String) },
    ]);

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

    const invalidPerson = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/people')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({
        localUserId: 'invalid-role-person',
        displayName: 'Invalid',
        email: 'not-an-email',
        role: 'ALLOCATION_COORDINATOR',
        unexpectedField: 'ignore',
      })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);
    expect(invalidPerson.body.code).toBe('VALIDATION_ERROR');
    expect(invalidPerson.body.errors).toEqual(expect.arrayContaining([
      { path: 'email', code: 'IS_EMAIL', message: expect.any(String) },
      { path: 'role', code: 'IS_ENUM', message: expect.any(String) },
      { path: 'unexpectedField', code: 'WHITELIST_VALIDATION', message: expect.any(String) },
    ]));
    expect(JSON.stringify(invalidPerson.body)).not.toMatch(/SELECT|INSERT|at\s+\w+\s+\(/i);
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
    expect(missingKey.body).not.toHaveProperty('errors');

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

    const unauthenticated = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/people')
      .expect('Content-Type', /application\/problem\+json/)
      .expect('WWW-Authenticate', /LocalProfile/)
      .expect(401);
    expect(unauthenticated.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(unauthenticated.body).not.toHaveProperty('errors');
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
});
