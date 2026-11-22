import 'reflect-metadata';
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
import { prepareFirstAdmin } from '../src/database/prepare-first-admin';

describe('Tech Resource Allocation entry access (#58)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_access_test')
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

    const startupBeforeMigration = await request(app.getHttpServer()).get('/health/startup').expect(503);
    expect(startupBeforeMigration.body).toMatchObject({
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    const migrationLedgerBefore = await dataSource.query("SELECT to_regclass('public.migrations') AS table_name");
    expect(migrationLedgerBefore[0].table_name).toBeNull();

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

  async function addPerson(localUserId: string, displayName: string, email: string, role: ResourceAllocationRole, active = true) {
    const person = dataSource!.getRepository(ResourcePerson).create({
      localUserId,
      displayName,
      email,
      role,
      active,
      coveredGroupIds: [],
    });
    return dataSource!.getRepository(ResourcePerson).save(person);
  }

  it('resolves only an active module person and returns each canonical role', async () => {
    const expectedRoles = [
      ResourceAllocationRole.User,
      ResourceAllocationRole.Moderator,
      ResourceAllocationRole.Supervisor,
      ResourceAllocationRole.Manager,
      ResourceAllocationRole.Admin,
    ];

    for (const [index, role] of expectedRoles.entries()) {
      const person = await addPerson(`local-role-${index}`, `Role ${index}`, `role${index}@example.test`, role);
      const response = await request(app!.getHttpServer())
        .get('/api/resource-allocation/v1/access')
        .set('X-PMO-Local-User-ID', person.localUserId)
        .expect('Cache-Control', 'no-store')
        .expect(200);

      expect(response.body).toMatchObject({
        person: {
          id: person.id,
          localUserId: person.localUserId,
          displayName: person.displayName,
          role,
          coveredGroupIds: [],
        },
      });
      expect(response.body).not.toHaveProperty('adminContacts');
    }
  });

  it('returns active Admin contacts when the selected Hub profile has no active module access', async () => {
    await addPerson('local-admin-z', 'Zoe Admin', 'zoe@example.test', ResourceAllocationRole.Admin);
    await addPerson('local-admin-a', 'Ada Admin', 'ada@example.test', ResourceAllocationRole.Admin);
    await addPerson('local-admin-inactive', 'Inactive Admin', 'inactive@example.test', ResourceAllocationRole.Admin, false);
    await addPerson('local-disabled', 'Disabled Person', 'disabled@example.test', ResourceAllocationRole.User, false);

    for (const profileId of ['local-no-access', 'local-disabled']) {
      const response = await request(app!.getHttpServer())
        .get('/api/resource-allocation/v1/access')
        .set('X-PMO-Local-User-ID', profileId)
        .expect('Content-Type', /application\/problem\+json/)
        .expect('Cache-Control', 'no-store')
        .expect(403);

      expect(response.body).toMatchObject({
        status: 403,
        code: 'ACCESS_DENIED',
        detail: 'You do not have active Tech Resource Allocation access. Contact an active Admin.',
        administrators: [
          { displayName: 'Ada Admin', email: 'ada@example.test' },
          { displayName: 'Zoe Admin', email: 'zoe@example.test' },
        ],
      });
      expect(JSON.stringify(response.body)).not.toContain('inactive@example.test');
    }
  });

  it('requires a selected Hub profile before checking module permissions', async () => {
    const response = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/access')
      .expect('Content-Type', /application\/problem\+json/)
      .expect('WWW-Authenticate', /LocalProfile/)
      .expect(401);

    expect(response.body).toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
  });
  it('does not infer access from a Hub profile and gives an empty contact list when no Admin exists', async () => {
    const response = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/access')
      .set('X-PMO-Local-User-ID', 'local-developer')
      .expect(403);

    expect(response.body).toMatchObject({ code: 'ACCESS_DENIED', administrators: [] });
  });

  it('prepares the first Admin repeatedly without duplicating or overwriting the existing person', async () => {
    const input = {
      localUserId: 'local-developer',
      displayName: 'Initial Allocation Admin',
      email: 'allocation-admin@example.test',
    };

    const first = await prepareFirstAdmin(dataSource!, input);
    const repeated = await prepareFirstAdmin(dataSource!, {
      ...input,
      displayName: 'Changed display name must not replace the existing record',
      email: 'changed@example.test',
    });

    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.person).toMatchObject({
      localUserId: input.localUserId,
      displayName: input.displayName,
      email: input.email,
      role: ResourceAllocationRole.Admin,
      active: true,
    });
    expect(await dataSource!.getRepository(ResourcePerson).count()).toBe(1);

    await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/access')
      .set('X-PMO-Local-User-ID', input.localUserId)
      .expect(200);
  });

  it('does not create another first Admin when one is already active', async () => {
    await prepareFirstAdmin(dataSource!, {
      localUserId: 'local-developer',
      displayName: 'Initial Allocation Admin',
      email: 'allocation-admin@example.test',
    });

    const result = await prepareFirstAdmin(dataSource!, {
      localUserId: 'local-contributor',
      displayName: 'Second Person',
      email: 'second@example.test',
    });

    expect(result.created).toBe(false);
    expect(result.person.localUserId).toBe('local-developer');
    expect(await dataSource!.getRepository(ResourcePerson).count()).toBe(1);
  });
  it('exposes live, ready, and startup health through the documented paths', async () => {
    const live = await request(app!.getHttpServer()).get('/health/live').expect(200);
    expect(live.body).toEqual({ service: 'resource-allocation-api', status: 'live', version: '0.1.0' });
    expect(live.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(live.headers['cache-control']).toBe('no-store');

    const ready = await request(app!.getHttpServer()).get('/health/ready').expect(200);
    expect(ready.body.status).toBe('ready');

    const startup = await request(app!.getHttpServer()).get('/health/startup').expect(200);
    expect(startup.body.status).toBe('ready');
  });
});
