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
import { ResourceAllocationHistory } from '../src/allocations/resource-allocation-history.entity';
import { ResourceAllocationService } from '../src/allocations/resource-allocation.service';

const week = '2099-01-05';
const weekEnd = '2099-01-09';

describe('Tech Resource Allocation comparison after operational and maintenance flows (#100)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_comparison_flows_test')
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
    const admin = await addPerson('fl-admin', ResourceAllocationRole.Admin);
    const supervisor = await addPerson('fl-supervisor', ResourceAllocationRole.Supervisor);
    const manager = await addPerson('fl-manager', ResourceAllocationRole.Manager);
    const group = await dataSource!.getRepository(ResourceGroup).save({ name: 'Platform', active: true, supervisorId: supervisor.id, managerId: manager.id });
    const moderator = await addPerson('fl-moderator', ResourceAllocationRole.Moderator, group.id);
    const internal = await addPerson('fl-internal', ResourceAllocationRole.User, group.id, ResourcePersonClassification.Internal);
    const contractor = await addPerson('fl-contractor', ResourceAllocationRole.User, group.id, ResourcePersonClassification.ThirdParty);
    const profile = await dataSource!.getRepository(ResourceProfile).save({ name: 'API', groupId: group.id, active: true });
    return { admin, moderator, internal, contractor, group, profile };
  }

  function send(method: 'post' | 'patch', path: string, actor: ResourcePerson, body: Record<string, unknown>, version?: number) {
    const call = request(app!.getHttpServer())[method](`/api/resource-allocation/v1${path}`)
      .set({ 'X-PMO-Local-User-ID': actor.localUserId, 'Idempotency-Key': randomUUID(), 'X-Correlation-ID': randomUUID() });
    if (version !== undefined) call.set('If-Match', `"${version}"`);
    if (method === 'patch') call.set('Content-Type', 'application/merge-patch+json');
    return call.send(body);
  }

  async function capacity(actor: ResourcePerson, f: Awaited<ReturnType<typeof setup>>, classification: string, fte: number) {
    await send('post', '/capacities', actor, { groupId: f.group.id, resourceProfileId: f.profile.id, classification, effectiveDate: '2099-01-01', fte, reason: 'Plan' }).expect(201);
  }

  async function weekFigures(actor: ResourcePerson, weekStart = week) {
    const response = await request(app!.getHttpServer()).get('/api/resource-allocation/v1/capacity-comparison')
      .query({ weekStart }).set('X-PMO-Local-User-ID', actor.localUserId).expect(200);
    const group = response.body.weeks[0].groups[0];
    const profile = group?.profiles[0];
    const row = (classification: string | null) => profile?.classifications.find((item: { classification: string | null }) => item.classification === classification);
    return {
      vacation: group?.vacationHours ?? 0,
      internal: row('INTERNAL')?.plannedHours ?? 0,
      thirdParty: row('THIRD_PARTY')?.plannedHours ?? 0,
      unclassified: row(null)?.plannedHours ?? 0,
      suspended: profile?.total.suspendedHours ?? 0,
      total: profile?.total,
    };
  }

  it('moves weekly load with own creation, Vacation conversion, person swap, classification correction, cancellation, and reopening', async () => {
    const f = await setup();
    await capacity(f.admin, f, 'INTERNAL', 1);
    await capacity(f.admin, f, 'THIRD_PARTY', 1);

    const training = await send('post', '/allocations', f.internal, {
      category: 'TRAINING', resourceProfileId: f.profile.id, startDate: week, endDate: weekEnd, weeklyHours: 20, comment: 'Course',
    }).expect(201);
    expect(await weekFigures(f.moderator)).toMatchObject({ internal: 20, thirdParty: 0, vacation: 0 });
    expect((await weekFigures(f.moderator)).total).toMatchObject({ capacityHours: 80, utilizationPercent: 25 });

    await send('patch', `/allocations/${training.body.id}`, f.moderator, { reason: 'Was vacation', category: 'VACATION' }, 1).expect(200);
    expect(await weekFigures(f.moderator)).toMatchObject({ internal: 0, vacation: 40 });
    expect((await weekFigures(f.moderator)).total).toMatchObject({ capacityHours: 80 });

    await send('patch', `/allocations/${training.body.id}`, f.moderator, {
      reason: 'Back to work', category: 'ROUTINE_SUPPORT', resourceProfileId: f.profile.id, weeklyHours: 10, comment: 'Support',
    }, 2).expect(200);
    await send('patch', `/allocations/${training.body.id}`, f.moderator, { reason: 'Reassign', personId: f.contractor.id }, 3).expect(200);
    expect(await weekFigures(f.moderator)).toMatchObject({ internal: 0, thirdParty: 10, vacation: 0 });

    await send('patch', `/allocations/${training.body.id}`, f.admin, { reason: 'No contract evidence', classification: null }, 4).expect(200);
    const unknown = await weekFigures(f.moderator);
    expect(unknown).toMatchObject({ thirdParty: 0, unclassified: 10 });
    expect(unknown.total).toMatchObject({ complete: false, utilizationPercent: null });

    await send('post', `/allocations/${training.body.id}/cancellations`, f.moderator, { reason: 'Not needed' }, 5).expect(200);
    expect(await weekFigures(f.moderator)).toMatchObject({ unclassified: 0, thirdParty: 0 });

    await send('post', `/allocations/${training.body.id}/reopenings`, f.admin, { reason: 'Needed after all', startDate: '2099-01-07', endDate: weekEnd, personId: f.internal.id }, 6).expect(200);
    expect(await weekFigures(f.moderator)).toMatchObject({ internal: 6, unclassified: 0 });

    const actions = (await dataSource!.getRepository(ResourceAllocationHistory).find({ where: { allocationId: training.body.id }, order: { occurredAt: 'ASC' } }))
      .map(({ action }) => action);
    expect(actions).toEqual([
      'SELF_ALLOCATION_CREATED', 'ALLOCATION_UPDATED', 'ALLOCATION_UPDATED', 'ALLOCATION_UPDATED', 'ALLOCATION_UPDATED',
      expect.stringContaining('CANCEL'), 'ALLOCATION_REOPENED',
    ]);
  });

  it('reflects corrections of past periods, suspension, and lifecycle completion in current values', async () => {
    const f = await setup();
    await capacity(f.admin, f, 'INTERNAL', 1);
    await capacity(f.admin, f, 'THIRD_PARTY', 0);
    const direct = await send('post', '/allocations', f.moderator, {
      personId: f.internal.id, category: 'INTERNAL_ACTIVITIES', resourceProfileId: f.profile.id, startDate: week, endDate: '2099-01-20', weeklyHours: 30, comment: 'Ops',
    }).expect(201);
    await send('post', `/allocations/${direct.body.id}/suspensions`, f.moderator, { reason: 'Paused' }, 1).expect(200);
    expect(await weekFigures(f.moderator)).toMatchObject({ internal: 0, suspended: 30 });
    await send('post', `/allocations/${direct.body.id}/resumptions`, f.moderator, { reason: 'Resumed' }, 2).expect(200);
    await send('patch', `/allocations/${direct.body.id}`, f.moderator, { reason: 'Fewer hours', weeklyHours: 20 }, 3).expect(200);
    expect(await weekFigures(f.moderator)).toMatchObject({ internal: 20, suspended: 0 });
    expect((await weekFigures(f.moderator)).total).toMatchObject({ capacityHours: 40, complete: true, utilizationPercent: 50 });

    const pastWeek = '2001-01-01';
    await send('post', '/capacities', f.admin, { groupId: f.group.id, resourceProfileId: f.profile.id, classification: 'INTERNAL', effectiveDate: '2000-12-01', fte: 1, reason: 'Historic' }).expect(201);
    const past = await send('post', '/allocations', f.moderator, {
      personId: f.internal.id, category: 'TRAINING', resourceProfileId: f.profile.id, startDate: pastWeek, endDate: '2001-01-05', weeklyHours: 10, comment: 'Old course',
    }).expect(201);
    expect(past.body.state).toBe('DONE');
    expect((await weekFigures(f.moderator, pastWeek)).internal).toBe(10);
    await send('post', `/allocations/${past.body.id}/reopenings`, f.admin, { reason: 'Correct the record', startDate: pastWeek, endDate: '2001-01-02' }, 1).expect(200);
    expect((await weekFigures(f.moderator, pastWeek)).internal).toBe(4);

    const worker = app!.get(ResourceAllocationService);
    await worker.processScheduledBatch();
    expect((await weekFigures(f.moderator, pastWeek)).internal).toBe(4);
  });
});
