import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { RESOURCE_ALLOCATION_DATA_SOURCE } from '../src/database/database.module';
import { prepareFirstAdmin } from '../src/database/prepare-first-admin';
import { ResourceAllocationSubmissionWorker } from '../src/submissions/resource-allocation-submission.worker';

const api = '/api/resource-allocation/v1';
const admin = 'revalidation-admin';
const requester = 'revalidation-requester';
const assignee = 'revalidation-assignee';
const manager = 'revalidation-manager';
const supervisor = 'revalidation-supervisor';

function futureDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('Tech Resource Allocation revalidation atomicity (#68)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_revalidation_atomicity')
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
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE resource_people, resource_initiatives RESTART IDENTITY CASCADE');
    await prepareFirstAdmin(dataSource, { localUserId: admin, displayName: 'Revalidation Admin', email: `${admin}@example.test` });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await container?.stop();
    }
  });

  async function createAdminRecord(record: string, body: object): Promise<string> {
    const response = await request(app.getHttpServer()).post(`${api}/admin/${record}`)
      .set('X-PMO-Local-User-ID', admin)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(201);
    return response.body.id;
  }

  function createPerson(localUserId: string, role: string, groupId?: string) {
    return createAdminRecord('people', { localUserId, displayName: localUserId, email: `${localUserId}@example.test`, role, ...(groupId ? { groupId } : {}) });
  }

  async function createFixture() {
    const supervisorId = await createPerson(supervisor, 'ALLOCATION_SUPERVISOR');
    const managerId = await createPerson(manager, 'ALLOCATION_MANAGER');
    const groupId = await createAdminRecord('groups', { name: 'Technology', supervisorId, managerId });
    const personId = await createPerson(assignee, 'ALLOCATION_USER', groupId);
    await createPerson(requester, 'ALLOCATION_USER', groupId);
    const resourceProfileId = await createAdminRecord('resource-profiles', { name: 'Engineer', groupId });
    const initiativeId = await createAdminRecord('initiatives', { code: 'ITDM-AC68', name: 'Delivery' });
    return { groupId, personId, resourceProfileId, initiativeId };
  }

  async function readRequest(id: string) {
    return request(app.getHttpServer()).get(`${api}/requests/${id}`)
      .set('X-PMO-Local-User-ID', requester)
      .expect(200);
  }

  async function createProposal(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<string> {
    const receipt = await request(app.getHttpServer()).post(`${api}/submissions`)
      .set('X-PMO-Local-User-ID', requester)
      .set('Idempotency-Key', randomUUID())
      .send({
        initiativeId: fixture.initiativeId,
        category: 'EXECUTION_PROJECT',
        lines: [{
          attemptKey: randomUUID(), groupId: fixture.groupId, resourceProfileId: fixture.resourceProfileId,
          startDate: futureDate(10), endDate: futureDate(20), weeklyHours: 8,
        }],
      })
      .expect(202);
    await app.get(ResourceAllocationSubmissionWorker).processBatch(1);
    const lines = await request(app.getHttpServer()).get(`${api}/submissions/${receipt.body.id}/lines`)
      .set('X-PMO-Local-User-ID', requester)
      .expect(200);
    expect(lines.body.items).toEqual([expect.objectContaining({ status: 'SUCCEEDED', requestId: expect.any(String) })]);
    const id: string = lines.body.items[0].requestId;
    const original = await readRequest(id);
    const referral = await request(app.getHttpServer()).post(`${api}/requests/${id}/referrals`)
      .set('X-PMO-Local-User-ID', admin)
      .set('If-Match', original.headers.etag)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    const proposal = await request(app.getHttpServer()).post(`${api}/requests/${id}/approvals`)
      .set('X-PMO-Local-User-ID', manager)
      .set('If-Match', referral.headers.etag)
      .set('Idempotency-Key', randomUUID())
      .send({ personId: fixture.personId, weeklyHours: 12, explanation: 'Combine two delivery tracks.' })
      .expect(200);
    expect(proposal.body).toMatchObject({ decisionState: 'APPROVED_WITH_CHANGES', allocation: null });
    return id;
  }

  function readAssignee(personId: string) {
    return request(app.getHttpServer()).get(`${api}/admin/people/${personId}`)
      .set('X-PMO-Local-User-ID', admin)
      .expect(200);
  }

  function deactivate(personId: string, etag: string) {
    return request(app.getHttpServer()).patch(`${api}/admin/people/${personId}`)
      .set('X-PMO-Local-User-ID', admin)
      .set('If-Match', etag)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ active: false });
  }

  function acceptProposal(requestId: string, etag: string) {
    return request(app.getHttpServer()).post(`${api}/requests/${requestId}/acceptances`)
      .set('X-PMO-Local-User-ID', requester)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({});
  }

  async function persistedEffects(requestIds: string[]) {
    const [effects] = await dataSource.query(`
      SELECT
        (SELECT count(*)::integer FROM resource_request_history WHERE request_id = ANY($1::uuid[])) AS history,
        (SELECT count(*)::integer FROM resource_allocation_notifications WHERE source_request_id = ANY($1::uuid[])) AS notifications,
        (SELECT count(*)::integer FROM resource_allocations WHERE source_request_id = ANY($1::uuid[])) AS allocations
    `, [requestIds]);
    return effects;
  }

  it('rolls back the person change and all affected proposals when a notification cannot be persisted', async () => {
    const fixture = await createFixture();
    const firstId = await createProposal(fixture);
    const secondId = await createProposal(fixture);
    const before = await persistedEffects([firstId, secondId]);
    const person = await readAssignee(fixture.personId);
    const beforeFirst = await readRequest(firstId);
    const beforeSecond = await readRequest(secondId);

    await dataSource.query(`
      CREATE FUNCTION reject_revalidation_notification() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'test cannot persist revalidation notification';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_revalidation_notification_trigger
      BEFORE INSERT ON resource_allocation_notifications
      FOR EACH ROW EXECUTE FUNCTION reject_revalidation_notification();
    `);
    try {
      await deactivate(fixture.personId, person.headers.etag)
        .expect(500)
        .expect('Content-Type', /application\/problem\+json/);
      expect((await readAssignee(fixture.personId)).body.active).toBe(true);
      expect((await readRequest(firstId)).headers.etag).toBe(beforeFirst.headers.etag);
      expect((await readRequest(secondId)).headers.etag).toBe(beforeSecond.headers.etag);
      expect(await persistedEffects([firstId, secondId])).toEqual(before);
    } finally {
      await dataSource.query(`
        DROP TRIGGER reject_revalidation_notification_trigger ON resource_allocation_notifications;
        DROP FUNCTION reject_revalidation_notification();
      `);
    }

    await deactivate(fixture.personId, person.headers.etag).expect(200);
    const afterFirst = await readRequest(firstId);
    const afterSecond = await readRequest(secondId);
    expect(afterFirst.body).toMatchObject({ decisionState: 'REQUIRES_REVALIDATION', allocation: null });
    expect(afterSecond.body).toMatchObject({ decisionState: 'REQUIRES_REVALIDATION', allocation: null });
    await acceptProposal(firstId, beforeFirst.headers.etag).expect(412);
    await acceptProposal(firstId, afterFirst.headers.etag).expect(422);
    const after = await persistedEffects([firstId, secondId]);
    expect(after.history).toBe(before.history + 2);
    expect(after.notifications).toBeGreaterThan(before.notifications);
    expect(after.allocations).toBe(0);
  });

  it('serializes acceptance against deactivation and preserves a commitment only if acceptance wins', async () => {
    const fixture = await createFixture();
    const proposalId = await createProposal(fixture);
    const proposal = await readRequest(proposalId);
    const person = await readAssignee(fixture.personId);

    const [accepted, deactivated] = await Promise.all([
      acceptProposal(proposalId, proposal.headers.etag),
      deactivate(fixture.personId, person.headers.etag),
    ]);

    expect(deactivated.status).toBe(200);
    expect((await readAssignee(fixture.personId)).body.active).toBe(false);
    const persisted = await readRequest(proposalId);
    const effects = await persistedEffects([proposalId]);
    expect([
      { status: 200, state: 'APPROVED', allocations: 1 },
      { status: 412, state: 'REQUIRES_REVALIDATION', allocations: 0 },
    ]).toContainEqual({ status: accepted.status, state: persisted.body.decisionState, allocations: effects.allocations });
  });
});
