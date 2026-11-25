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

describe('Admin person classification', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_person_classification_test')
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

  async function addPerson(localUserId: string, role: ResourceAllocationRole) {
    const repository = dataSource!.getRepository(ResourcePerson);
    return repository.save(repository.create({
      localUserId,
      displayName: localUserId,
      email: `${localUserId}@example.test`,
      role,
      active: true,
      coveredGroupIds: [],
      groupId: null,
    }));
  }

  const personPath = (id: string) => `/api/resource-allocation/v1/admin/people/${id}`;

  it('keeps legacy people Unclassified and lets Admin set classification on creation', async () => {
    const admin = await addPerson('classification-admin', ResourceAllocationRole.Admin);
    const legacyPerson = await addPerson('legacy-person', ResourceAllocationRole.User);

    const legacyDetail = await request(app!.getHttpServer())
      .get(personPath(legacyPerson.id))
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(legacyDetail.body.classification).toBeNull();

    const created = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/people')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', randomUUID())
      .send({
        localUserId: 'third-party-person',
        displayName: 'Third Party Person',
        email: 'third-party@example.test',
        role: ResourceAllocationRole.User,
        classification: 'THIRD_PARTY',
      })
      .expect('ETag', '"1"')
      .expect(201);

    expect(created.body).toMatchObject({ classification: 'THIRD_PARTY', version: 1 });
    const collection = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/admin/people')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(collection.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: legacyPerson.id, classification: null }),
      expect.objectContaining({ id: created.body.id, classification: 'THIRD_PARTY' }),
    ]));

    const history = await request(app!.getHttpServer())
      .get(`${personPath(created.body.id)}/classification-history`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(history.body).toMatchObject({
      items: [{
        previousClassification: null,
        nextClassification: 'THIRD_PARTY',
        actor: { personId: admin.id, displayName: admin.displayName, role: ResourceAllocationRole.Admin },
      }],
      page: { nextCursor: null, limit: 50 },
    });
  });

  it('keeps the version and audit unchanged when Admin repeats the current classification', async () => {
    const admin = await addPerson('classification-admin', ResourceAllocationRole.Admin);
    const person = await addPerson('unclassified-person', ResourceAllocationRole.User);

    const repeated = await request(app!.getHttpServer())
      .patch(personPath(person.id))
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ classification: null })
      .expect('ETag', '"1"')
      .expect(200);

    expect(repeated.body).toMatchObject({ classification: null, version: 1 });
    const history = await request(app!.getHttpServer())
      .get(`${personPath(person.id)}/classification-history`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(history.body.items).toEqual([]);
  });

  it('rejects classification history cursors outside the PostgreSQL bigint range', async () => {
    const admin = await addPerson('classification-admin', ResourceAllocationRole.Admin);
    const person = await addPerson('classified-person', ResourceAllocationRole.User);
    const cursor = Buffer.from(JSON.stringify({
      version: 1,
      personId: person.id,
      sequence: '9223372036854775808',
    })).toString('base64url');

    const response = await request(app!.getHttpServer())
      .get(`${personPath(person.id)}/classification-history`)
      .query({ cursor })
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('lets Admin change or clear classification with current ETags without changing the person role', async () => {
    const admin = await addPerson('classification-admin', ResourceAllocationRole.Admin);
    const person = await addPerson('classified-person', ResourceAllocationRole.User);

    const classified = await request(app!.getHttpServer())
      .patch(personPath(person.id))
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ classification: 'INTERNAL' })
      .expect('ETag', '"2"')
      .expect(200);
    expect(classified.body).toMatchObject({ classification: 'INTERNAL', role: ResourceAllocationRole.User, version: 2 });

    await request(app!.getHttpServer())
      .patch(personPath(person.id))
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"1"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ classification: 'THIRD_PARTY' })
      .expect('Content-Type', /application\/problem\+json/)
      .expect(412);

    const cleared = await request(app!.getHttpServer())
      .patch(personPath(person.id))
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('If-Match', '"2"')
      .set('Content-Type', 'application/merge-patch+json')
      .send({ classification: null })
      .expect('ETag', '"3"')
      .expect(200);
    expect(cleared.body).toMatchObject({ classification: null, role: ResourceAllocationRole.User, version: 3 });

    const history = await request(app!.getHttpServer())
      .get(`${personPath(person.id)}/classification-history`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(history.body.items).toMatchObject([
      { previousClassification: null, nextClassification: 'INTERNAL' },
      { previousClassification: 'INTERNAL', nextClassification: null },
    ]);
    const access = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/access')
      .set('X-PMO-Local-User-ID', person.localUserId)
      .expect(200);
    expect(access.body.person.role).toBe(ResourceAllocationRole.User);
  });

  it('denies Users and every leadership role direct classification writes and history reads', async () => {
    const admin = await addPerson('classification-admin', ResourceAllocationRole.Admin);
    const target = await addPerson('classification-target', ResourceAllocationRole.User);
    const actors = [
      await addPerson('classification-user', ResourceAllocationRole.User),
      await addPerson('classification-moderator', ResourceAllocationRole.Moderator),
      await addPerson('classification-supervisor', ResourceAllocationRole.Supervisor),
      await addPerson('classification-manager', ResourceAllocationRole.Manager),
    ];

    for (const actor of actors) {
      await request(app!.getHttpServer())
        .patch(personPath(target.id))
        .set('X-PMO-Local-User-ID', actor.localUserId)
        .set('If-Match', '"1"')
        .set('Content-Type', 'application/merge-patch+json')
        .send({ classification: 'INTERNAL' })
        .expect('Content-Type', /application\/problem\+json/)
        .expect(403);
      await request(app!.getHttpServer())
        .get(`${personPath(target.id)}/classification-history`)
        .set('X-PMO-Local-User-ID', actor.localUserId)
        .expect('Content-Type', /application\/problem\+json/)
        .expect(403);
    }

    const unchanged = await request(app!.getHttpServer())
      .get(personPath(target.id))
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(unchanged.body).toMatchObject({ classification: null, role: ResourceAllocationRole.User, version: 1 });
    const history = await request(app!.getHttpServer())
      .get(`${personPath(target.id)}/classification-history`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(history.body.items).toEqual([]);
  });

  it('replays a classified person create without appending duplicate history', async () => {
    const admin = await addPerson('classification-admin', ResourceAllocationRole.Admin);
    const idempotencyKey = randomUUID();
    const payload = {
      localUserId: 'idempotent-classified-person',
      displayName: 'Idempotent Person',
      email: 'idempotent@example.test',
      role: ResourceAllocationRole.User,
      classification: 'INTERNAL',
    };

    const created = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/people')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(201);
    const replay = await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/admin/people')
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect('Idempotency-Replayed', 'true')
      .expect(201);

    expect(replay.body).toEqual(created.body);
    const history = await request(app!.getHttpServer())
      .get(`${personPath(created.body.id)}/classification-history`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(history.body.items).toHaveLength(1);
  });

  it('rolls back the person update when classification history cannot be recorded', async () => {
    const admin = await addPerson('classification-admin', ResourceAllocationRole.Admin);
    const person = await addPerson('classification-target', ResourceAllocationRole.User);
    await dataSource!.query(`
      CREATE FUNCTION fail_person_classification_history_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test classification audit failure' USING ERRCODE = 'P0001'; END;
      $$
    `);
    await dataSource!.query(`
      CREATE TRIGGER fail_person_classification_history_before_insert
      BEFORE INSERT ON resource_person_classification_history
      FOR EACH ROW EXECUTE FUNCTION fail_person_classification_history_insert()
    `);

    try {
      await request(app!.getHttpServer())
        .patch(personPath(person.id))
        .set('X-PMO-Local-User-ID', admin.localUserId)
        .set('If-Match', '"1"')
        .set('Content-Type', 'application/merge-patch+json')
        .send({ classification: 'THIRD_PARTY' })
        .expect('Content-Type', /application\/problem\+json/)
        .expect(500);
    } finally {
      await dataSource!.query('DROP TRIGGER IF EXISTS fail_person_classification_history_before_insert ON resource_person_classification_history');
      await dataSource!.query('DROP FUNCTION IF EXISTS fail_person_classification_history_insert()');
    }

    const unchanged = await request(app!.getHttpServer())
      .get(personPath(person.id))
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(unchanged.body).toMatchObject({ classification: null, version: 1 });
    const history = await request(app!.getHttpServer())
      .get(`${personPath(person.id)}/classification-history`)
      .set('X-PMO-Local-User-ID', admin.localUserId)
      .expect(200);
    expect(history.body.items).toEqual([]);
  });

});
