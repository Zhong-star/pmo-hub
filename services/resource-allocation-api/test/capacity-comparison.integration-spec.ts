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

const week = '2099-01-05';
const comparisonPath = '/api/resource-allocation/v1/capacity-comparison';

describe('Tech Resource Allocation weekly capacity comparison (#99)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_comparison_test')
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
    const admin = await addPerson('cmp-admin', ResourceAllocationRole.Admin);
    const supervisor = await addPerson('cmp-supervisor', ResourceAllocationRole.Supervisor);
    const manager = await addPerson('cmp-manager', ResourceAllocationRole.Manager);
    const group = await dataSource!.getRepository(ResourceGroup).save({ name: 'Platform', active: true, supervisorId: supervisor.id, managerId: manager.id });
    const otherGroup = await dataSource!.getRepository(ResourceGroup).save({ name: 'Data', active: true, supervisorId: admin.id, managerId: admin.id });
    const moderator = await addPerson('cmp-moderator', ResourceAllocationRole.Moderator, group.id);
    const internal = await addPerson('cmp-internal', ResourceAllocationRole.User, group.id, ResourcePersonClassification.Internal);
    const contractor = await addPerson('cmp-contractor', ResourceAllocationRole.User, group.id, ResourcePersonClassification.ThirdParty);
    const unknown = await addPerson('cmp-unknown', ResourceAllocationRole.User, group.id, null);
    const outsider = await addPerson('cmp-outsider', ResourceAllocationRole.User, otherGroup.id, ResourcePersonClassification.Internal);
    const profile = await dataSource!.getRepository(ResourceProfile).save({ name: 'API', groupId: group.id, active: true });
    const otherProfile = await dataSource!.getRepository(ResourceProfile).save({ name: 'Analytics', groupId: otherGroup.id, active: true });
    const initiative = await dataSource!.getRepository(ResourceInitiative).save({ code: `ITDM-${randomUUID().slice(0, 6)}`, name: 'Plan', active: true, codeUsed: true });
    return { admin, supervisor, manager, moderator, internal, contractor, unknown, outsider, group, otherGroup, profile, otherProfile, initiative };
  }

  function post(path: string, actor: ResourcePerson, body: Record<string, unknown>) {
    return request(app!.getHttpServer()).post(path)
      .set({ 'X-PMO-Local-User-ID': actor.localUserId, 'Idempotency-Key': randomUUID(), 'X-Correlation-ID': randomUUID() })
      .send(body);
  }

  function allocate(actor: ResourcePerson, person: ResourcePerson, profileId: string | null, startDate: string, endDate: string, weeklyHours: number, category = 'ROUTINE_SUPPORT') {
    return post('/api/resource-allocation/v1/allocations', actor, {
      personId: person.id, category, startDate, endDate,
      ...(category === 'VACATION' ? {} : { resourceProfileId: profileId, weeklyHours, comment: 'Planned work' }),
    }).expect(201);
  }

  function capacity(actor: ResourcePerson, groupId: string, profileId: string, classification: string, effectiveDate: string, fte: number) {
    return post('/api/resource-allocation/v1/capacities', actor, { groupId, resourceProfileId: profileId, classification, effectiveDate, fte, reason: 'Plan' }).expect(201);
  }

  function compare(actor: ResourcePerson, query: Record<string, string> = { weekStart: week }) {
    return request(app!.getHttpServer()).get(comparisonPath).query(query).set('X-PMO-Local-User-ID', actor.localUserId);
  }

  it('prorates load and capacity by weekday, keeps classifications and Unclassified apart, and suppresses incomplete totals', async () => {
    const f = await setup();
    await capacity(f.admin, f.group.id, f.profile.id, 'INTERNAL', '2099-01-01', 1);
    await capacity(f.admin, f.group.id, f.profile.id, 'INTERNAL', '2099-01-07', 0.5);
    await capacity(f.admin, f.group.id, f.profile.id, 'THIRD_PARTY', '2099-01-07', 1);
    await allocate(f.admin, f.internal, f.profile.id, '2099-01-05', '2099-01-06', 40);
    await allocate(f.admin, f.contractor, f.profile.id, '2099-01-03', '2099-01-20', 10);
    await allocate(f.admin, f.unknown, f.profile.id, '2099-01-09', '2099-01-11', 20);

    const response = await compare(f.supervisor).expect(200);
    expect(response.body.weeks).toHaveLength(1);
    const [currentWeek] = response.body.weeks;
    expect(currentWeek).toMatchObject({ weekStart: week, weekEnd: '2099-01-11' });
    const [group] = currentWeek.groups;
    expect(group).toMatchObject({ group: { name: 'Platform' }, unclassifiedHours: 4, vacationHours: 0 });
    const [profile] = group.profiles;
    const byClassification = Object.fromEntries(profile.classifications.map((row: { classification: string | null }) => [row.classification ?? 'UNCLASSIFIED', row]));
    expect(byClassification.INTERNAL).toMatchObject({ plannedHours: 16, capacityHours: 28, capacityFte: 0.7, complete: true });
    expect(byClassification.INTERNAL.utilizationPercent).toBeCloseTo(57.142857, 5);
    expect(byClassification.THIRD_PARTY).toMatchObject({ plannedHours: 10, capacityHours: 24, capacityFte: 0.6, complete: false, utilizationPercent: null });
    expect(byClassification.UNCLASSIFIED).toMatchObject({ plannedHours: 4, capacityHours: null, utilizationPercent: null });
    expect(profile.total).toMatchObject({ plannedHours: 30, capacityHours: 52, complete: false, utilizationPercent: null });
    expect(currentWeek.total).toMatchObject({ plannedHours: 30, capacityHours: 52, complete: false, utilizationPercent: null });
  });

  it('reports 150 percent without blocking, counts Done, excludes Canceled, separates suspension and vacation', async () => {
    const f = await setup();
    await capacity(f.admin, f.group.id, f.profile.id, 'INTERNAL', '2099-01-01', 1);
    await capacity(f.admin, f.group.id, f.profile.id, 'THIRD_PARTY', '2099-01-01', 0);
    await allocate(f.admin, f.internal, f.profile.id, week, '2099-01-09', 30);
    await allocate(f.admin, f.internal, f.profile.id, week, '2099-01-09', 30);
    const canceled = await allocate(f.admin, f.internal, f.profile.id, week, '2099-01-09', 20);
    const suspended = await allocate(f.admin, f.internal, f.profile.id, week, '2099-01-09', 10);
    await allocate(f.admin, f.internal, null, week, '2099-01-06', 40, 'VACATION');
    await dataSource!.query("UPDATE resource_allocations SET state = 'CANCELED' WHERE id = $1::uuid", [canceled.body.id]);
    await dataSource!.query("UPDATE resource_allocations SET state = 'SUSPENDED' WHERE id = $1::uuid", [suspended.body.id]);

    const response = await compare(f.moderator).expect(200);
    const [group] = response.body.weeks[0].groups;
    expect(group.vacationHours).toBe(16);
    expect(group.profiles[0].total).toMatchObject({ plannedHours: 60, suspendedHours: 10, capacityHours: 40, complete: true, utilizationPercent: 150 });
    const thirdParty = group.profiles[0].classifications.find((row: { classification: string }) => row.classification === 'THIRD_PARTY');
    expect(thirdParty).toMatchObject({ capacityHours: 0, complete: true, utilizationPercent: null });

    const endedSuspension = await allocate(f.admin, f.internal, f.profile.id, '2001-01-01', '2001-01-05', 5);
    await dataSource!.query("UPDATE resource_allocations SET state = 'SUSPENDED' WHERE id = $1::uuid", [endedSuspension.body.id]);
    const past = await allocate(f.admin, f.internal, f.profile.id, '2001-01-01', '2001-01-05', 10);
    expect(past.body.state).toBe('DONE');
    const pastWeek = await compare(f.moderator, { weekStart: '2001-01-01' }).expect(200);
    expect(pastWeek.body.weeks[0].groups[0].profiles[0].total).toMatchObject({ plannedHours: 15, suspendedHours: 0 });
  });

  it('aggregates every authorized record, applies scope and filters, and rejects invalid ranges', async () => {
    const f = await setup();
    await capacity(f.admin, f.otherGroup.id, f.otherProfile.id, 'INTERNAL', '2099-01-01', 1);
    for (let index = 0; index < 60; index += 1) await allocate(f.admin, f.internal, f.profile.id, week, '2099-01-09', 1);
    await allocate(f.admin, f.outsider, f.otherProfile.id, week, '2099-01-09', 8);

    const scoped = await compare(f.moderator).expect(200);
    expect(scoped.body.weeks[0].groups.map(({ group }: { group: { name: string } }) => group.name)).toEqual(['Platform']);
    expect(scoped.body.weeks[0].total.plannedHours).toBe(60);
    const admin = await compare(f.admin).expect(200);
    expect(admin.body.weeks[0].groups.map(({ group }: { group: { name: string } }) => group.name)).toEqual(['Data', 'Platform']);
    expect(admin.body.weeks[0].total.plannedHours).toBe(68);
    const filtered = await compare(f.admin, { weekStart: week, groupId: f.otherGroup.id, classification: 'INTERNAL' }).expect(200);
    expect(filtered.body).toMatchObject({ vacationIncluded: false });
    expect(filtered.body.weeks[0].groups[0].profiles[0].total).toMatchObject({ plannedHours: 8, capacityHours: 40, complete: true, utilizationPercent: 20 });
    expect(filtered.body.weeks[0].total).toMatchObject({ complete: true, utilizationPercent: 20 });

    await compare(f.moderator, { weekStart: week, groupId: f.otherGroup.id }).expect(403);
    await compare(f.internal).expect(403);
    await compare(f.admin, { weekStart: '2099-01-06' }).expect(400);
    await compare(f.admin, { weekStart: week, weekEnd: '2098-12-29' }).expect(400);
    await compare(f.admin, { weekStart: week, weekEnd: '2099-12-28' }).expect(400);
    const farFuture = await compare(f.admin, { weekStart: '9999-12-27' }).expect(400);
    expect(farFuture.body.detail).toContain('weekStart');
    expect((await compare(f.admin, { weekStart: '2099-02-30' }).expect(400)).body.detail).toContain('weekStart');
    const range = await compare(f.admin, { weekStart: week, weekEnd: '2099-01-19' }).expect(200);
    expect(range.body.weeks.map(({ weekStart }: { weekStart: string }) => weekStart)).toEqual([week, '2099-01-12', '2099-01-19']);
    const current = await compare(f.admin, {}).expect(200);
    expect(current.body.weeks[0].weekStart <= current.body.businessDate).toBe(true);
  });

  it('keeps an inactive profile with capacity in the comparison and flags it', async () => {
    const f = await setup();
    await capacity(f.admin, f.group.id, f.profile.id, 'INTERNAL', '2099-01-01', 1);
    await dataSource!.getRepository(ResourceProfile).update(f.profile.id, { active: false });
    const response = await compare(f.admin).expect(200);
    expect(response.body.weeks[0].groups[0].profiles[0]).toMatchObject({ resourceProfile: { name: 'API', active: false }, total: { capacityHours: 40 } });
  });
});
