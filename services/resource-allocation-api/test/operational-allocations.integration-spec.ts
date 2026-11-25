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
import { ResourceAllocationService } from '../src/allocations/resource-allocation.service';

const allocationsPath = '/api/resource-allocation/v1/allocations';

describe('Tech Resource Allocation operational and direct allocations (#92–#94)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_operational_test')
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

  async function addPerson(
    localUserId: string,
    role: ResourceAllocationRole,
    groupId: string | null = null,
    classification: ResourcePersonClassification | null = null,
  ) {
    const repository = dataSource!.getRepository(ResourcePerson);
    return repository.save(repository.create({
      localUserId,
      displayName: localUserId.replaceAll('-', ' '),
      email: `${localUserId}@example.test`,
      role,
      active: true,
      groupId,
      coveredGroupIds: [],
      classification,
    }));
  }

  async function setup() {
    const admin = await addPerson('ops-admin', ResourceAllocationRole.Admin);
    const supervisor = await addPerson('ops-supervisor', ResourceAllocationRole.Supervisor);
    const manager = await addPerson('ops-manager', ResourceAllocationRole.Manager);
    const otherSupervisor = await addPerson('ops-other-supervisor', ResourceAllocationRole.Supervisor);
    const otherManager = await addPerson('ops-other-manager', ResourceAllocationRole.Manager);
    const group = await dataSource!.getRepository(ResourceGroup).save({
      name: 'Platform', active: true, supervisorId: supervisor.id, managerId: manager.id,
    });
    const otherGroup = await dataSource!.getRepository(ResourceGroup).save({
      name: 'Data', active: true, supervisorId: otherSupervisor.id, managerId: otherManager.id,
    });
    const moderator = await addPerson('ops-moderator', ResourceAllocationRole.Moderator, group.id);
    const member = await addPerson('ops-member', ResourceAllocationRole.User, group.id, ResourcePersonClassification.Internal);
    const colleague = await addPerson('ops-colleague', ResourceAllocationRole.User, group.id, ResourcePersonClassification.ThirdParty);
    const outsider = await addPerson('ops-outsider', ResourceAllocationRole.User, otherGroup.id);
    const otherModerator = await addPerson('ops-other-moderator', ResourceAllocationRole.Moderator, otherGroup.id);
    const profile = await dataSource!.getRepository(ResourceProfile).save({ name: 'API', groupId: group.id, active: true });
    const inactiveProfile = await dataSource!.getRepository(ResourceProfile).save({ name: 'Legacy', groupId: group.id, active: false });
    const otherProfile = await dataSource!.getRepository(ResourceProfile).save({ name: 'Analytics', groupId: otherGroup.id, active: true });
    const initiative = await dataSource!.getRepository(ResourceInitiative).save({
      code: `ITDM-${randomUUID().slice(0, 8)}`, name: 'Resource allocation', active: true, codeUsed: true,
    });
    const inactiveInitiative = await dataSource!.getRepository(ResourceInitiative).save({
      code: `ITDM-${randomUUID().slice(0, 8)}`, name: 'Retired', active: false, codeUsed: true,
    });
    return {
      admin, supervisor, manager, otherSupervisor, moderator, member, colleague, outsider, otherModerator,
      group, otherGroup, profile, inactiveProfile, otherProfile, initiative, inactiveInitiative,
    };
  }

  async function businessDate(): Promise<string> {
    const rows = await dataSource!.query("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today") as Array<{ today: string }>;
    return rows[0].today;
  }

  function addDays(date: string, days: number): string {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  function create(actor: ResourcePerson, body: Record<string, unknown>, key = randomUUID()) {
    return request(app!.getHttpServer())
      .post(allocationsPath)
      .set({
        'X-PMO-Local-User-ID': actor.localUserId,
        'Idempotency-Key': key,
        'X-Correlation-ID': randomUUID(),
      })
      .send(body);
  }

  async function notices(person: ResourcePerson) {
    return dataSource!.query(
      'SELECT event_code, source_allocation_id::text AS allocation_id, title FROM resource_allocation_notifications WHERE recipient_id = $1::uuid ORDER BY created_at',
      [person.id],
    ) as Promise<Array<{ event_code: string; allocation_id: string | null; title: string }>>;
  }

  async function countEffects() {
    const [allocations, history, notifications, receipts] = await Promise.all([
      dataSource!.getRepository(ResourceAllocation).count(),
      dataSource!.getRepository(ResourceAllocationHistory).count(),
      dataSource!.query('SELECT COUNT(*)::int AS count FROM resource_allocation_notifications') as Promise<Array<{ count: number }>>,
      dataSource!.query("SELECT COUNT(*)::int AS count FROM resource_allocation_operation_receipts WHERE operation = 'allocation.create'") as Promise<Array<{ count: number }>>,
    ]);
    return { allocations, history, notifications: notifications[0].count, receipts: receipts[0].count };
  }

  describe('own operational allocations (#92)', () => {
    it('lets a member record Training for themself and notifies every group leader except the author', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const response = await create(fixture.member, {
        category: 'TRAINING',
        resourceProfileId: fixture.profile.id,
        startDate: addDays(today, 3),
        endDate: addDays(today, 10),
        weeklyHours: 12.25,
        comment: '  Cloud security course.  ',
      }).expect(201);

      expect(response.headers.location).toBe(`${allocationsPath}/${response.body.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(response.body).toMatchObject({
        requestId: null,
        source: 'SELF',
        category: 'TRAINING',
        classification: 'INTERNAL',
        comment: 'Cloud security course.',
        person: { personId: fixture.member.id },
        group: { id: fixture.group.id, name: 'Platform' },
        initiative: null,
        resourceProfile: { id: fixture.profile.id, name: 'API', active: true },
        weeklyHours: 12.3,
        state: 'NOT_STARTED',
        availableActions: ['SUSPEND', 'RESERVE', 'CANCEL'],
      });
      const saved = await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: response.body.id });
      expect(saved).toMatchObject({ origin: 'SELF', createdByPersonId: fixture.member.id, sourceRequestId: null, initiativeId: null });

      const history = await request(app!.getHttpServer())
        .get(`${allocationsPath}/${response.body.id}/history`)
        .set('X-PMO-Local-User-ID', fixture.member.localUserId)
        .expect(200);
      expect(history.body.items).toHaveLength(1);
      expect(history.body.items[0]).toMatchObject({ action: 'SELF_ALLOCATION_CREATED', actor: { personId: fixture.member.id } });

      for (const leader of [fixture.moderator, fixture.supervisor, fixture.manager]) {
        expect(await notices(leader)).toEqual([{ event_code: 'ALLOCATION_CREATED', allocation_id: response.body.id, title: 'New self allocation' }]);
      }
      for (const other of [fixture.member, fixture.colleague, fixture.admin, fixture.otherSupervisor, fixture.otherModerator]) {
        expect(await notices(other)).toEqual([]);
      }
      const inbox = await request(app!.getHttpServer())
        .get('/api/resource-allocation/v1/notifications')
        .set('X-PMO-Local-User-ID', fixture.moderator.localUserId)
        .expect(200);
      expect(inbox.body.items[0].target).toMatchObject({
        type: 'ALLOCATION', requestId: null, available: true, destination: 'ALLOCATION_DETAIL', allocationId: response.body.id,
      });
    });

    it('does not notify the author when a leader records their own operational allocation', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const response = await create(fixture.moderator, {
        category: 'INTERNAL_ACTIVITIES', resourceProfileId: fixture.profile.id, startDate: today, endDate: today, weeklyHours: 4, comment: 'Team ceremonies.',
      }).expect(201);
      expect(response.body).toMatchObject({ source: 'SELF', state: 'IN_PROGRESS', classification: null });
      expect(await notices(fixture.moderator)).toEqual([]);
      expect((await notices(fixture.supervisor)).map(({ allocation_id: id }) => id)).toEqual([response.body.id]);
    });

    it('denies own allocations for a colleague, outside the group, or in an initiative category without effects', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const base = { resourceProfileId: fixture.profile.id, startDate: today, endDate: addDays(today, 2), weeklyHours: 8, comment: 'Support rotation.' };
      const before = await countEffects();

      const colleague = await create(fixture.member, { ...base, category: 'ROUTINE_SUPPORT', personId: fixture.colleague.id })
        .expect('Content-Type', /application\/problem\+json/)
        .expect(403);
      expect(colleague.body.code).toBe('ACCESS_DENIED');
      const initiative = await create(fixture.member, { ...base, category: 'EXECUTION_PROJECT', initiativeId: fixture.initiative.id }).expect(403);
      expect(initiative.body.code).toBe('ACCESS_DENIED');
      const otherGroupProfile = await create(fixture.member, { ...base, category: 'TRAINING', resourceProfileId: fixture.otherProfile.id }).expect(422);
      expect(otherGroupProfile.body).toMatchObject({ code: 'INVALID_ALLOCATION_REFERENCE', errors: [{ path: 'resourceProfileId' }] });
      const inactiveProfile = await create(fixture.member, { ...base, category: 'TRAINING', resourceProfileId: fixture.inactiveProfile.id }).expect(422);
      expect(inactiveProfile.body.code).toBe('INVALID_ALLOCATION_REFERENCE');

      expect(await countEffects()).toEqual(before);
    });

    it('validates categories, comments, dates, and hours while allowing past periods, overlap, and totals above 40', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const base = { category: 'ROUTINE_SUPPORT', resourceProfileId: fixture.profile.id, startDate: today, endDate: addDays(today, 4), weeklyHours: 30, comment: 'On call.' };

      const missing = await create(fixture.member, { ...base, comment: '   ' }).expect(400);
      expect(missing.body).toMatchObject({ code: 'VALIDATION_ERROR', errors: [{ path: 'comment', code: 'REQUIRED' }] });
      const withInitiative = await create(fixture.member, { ...base, initiativeId: fixture.initiative.id }).expect(400);
      expect(withInitiative.body.errors).toEqual([expect.objectContaining({ path: 'initiativeId', code: 'NOT_ALLOWED' })]);
      const noProfile = await create(fixture.member, { ...base, resourceProfileId: undefined }).expect(400);
      expect(noProfile.body.errors).toEqual([expect.objectContaining({ path: 'resourceProfileId', code: 'REQUIRED' })]);
      await create(fixture.member, { ...base, category: 'MAINTENANCE' }).expect(400);
      await create(fixture.member, { ...base, weeklyHours: 0 }).expect(400);
      await create(fixture.member, { ...base, weeklyHours: 40.5 }).expect(400);
      await create(fixture.member, { ...base, startDate: '2026-02-30' }).expect(400);
      const reversed = await create(fixture.member, { ...base, startDate: addDays(today, 5), endDate: today }).expect(422);
      expect(reversed.body.code).toBe('INVALID_BUSINESS_DATE');
      expect(await dataSource!.getRepository(ResourceAllocation).count()).toBe(0);

      const past = await create(fixture.member, { ...base, startDate: addDays(today, -20), endDate: addDays(today, -10) }).expect(201);
      expect(past.body).toMatchObject({ state: 'DONE', availableActions: [] });
      const endsToday = await create(fixture.member, { ...base, startDate: addDays(today, -3), endDate: today }).expect(201);
      expect(endsToday.body.state).toBe('IN_PROGRESS');
      await create(fixture.member, { ...base, weeklyHours: 40 }).expect(201);
      expect(await dataSource!.getRepository(ResourceAllocation).countBy({ personId: fixture.member.id })).toBe(3);
    });

    it('replays a lost response without duplicating effects and rejects a reused key with other content', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const key = randomUUID();
      const body = { category: 'TRAINING', resourceProfileId: fixture.profile.id, startDate: today, endDate: today, weeklyHours: 6, comment: 'Workshop.' };
      const first = await create(fixture.member, body, key).expect(201);
      const afterFirst = await countEffects();
      const replay = await create(fixture.member, body, key).expect(201).expect('Idempotency-Replayed', 'true');
      expect(replay.headers.etag).toBeUndefined();
      expect(replay.body.id).toBe(first.body.id);
      expect(await countEffects()).toEqual(afterFirst);
      const conflict = await create(fixture.member, { ...body, weeklyHours: 7 }, key).expect(409);
      expect(conflict.body.code).toBe('RESOURCE_CONFLICT');
      expect(await countEffects()).toEqual(afterFirst);
    });

    it('rolls back the allocation, history, and receipt when a notice cannot be stored', async () => {
      const fixture = await setup();
      const today = await businessDate();
      await dataSource!.query(`
        CREATE FUNCTION fail_creation_notice() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test notification failure'; END
        $$
      `);
      await dataSource!.query('CREATE TRIGGER fail_creation_notice_before_insert BEFORE INSERT ON resource_allocation_notifications FOR EACH ROW EXECUTE FUNCTION fail_creation_notice()');
      try {
        await create(fixture.member, {
          category: 'TRAINING', resourceProfileId: fixture.profile.id, startDate: today, endDate: today, weeklyHours: 6, comment: 'Workshop.',
        }).expect(500);
        expect(await countEffects()).toEqual({ allocations: 0, history: 0, notifications: 0, receipts: 0 });
      } finally {
        await dataSource!.query('DROP TRIGGER fail_creation_notice_before_insert ON resource_allocation_notifications');
        await dataSource!.query('DROP FUNCTION fail_creation_notice()');
      }
    });

    it('keeps the classification recorded at creation when the person record changes later', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const unclassified = await addPerson('ops-unclassified', ResourceAllocationRole.User, fixture.group.id, null);
      const internal = await create(fixture.member, {
        category: 'TRAINING', resourceProfileId: fixture.profile.id, startDate: today, endDate: today, weeklyHours: 2, comment: 'Course.',
      }).expect(201);
      const unknown = await create(unclassified, {
        category: 'TRAINING', resourceProfileId: fixture.profile.id, startDate: today, endDate: today, weeklyHours: 2, comment: 'Course.',
      }).expect(201);
      expect(unknown.body.classification).toBeNull();

      await dataSource!.getRepository(ResourcePerson).update(fixture.member.id, { classification: ResourcePersonClassification.ThirdParty });
      const reread = await request(app!.getHttpServer())
        .get(`${allocationsPath}/${internal.body.id}`)
        .set('X-PMO-Local-User-ID', fixture.member.localUserId)
        .expect(200);
      expect(reread.body.classification).toBe('INTERNAL');
    });
  });

  describe('direct allocations by leadership (#93)', () => {
    it('lets a Moderator allocate initiative work in their group, recording the author and notifying only the person', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const response = await create(fixture.moderator, {
        personId: fixture.colleague.id,
        category: 'EXECUTION_PROJECT',
        initiativeId: fixture.initiative.id,
        resourceProfileId: fixture.profile.id,
        startDate: addDays(today, -2),
        endDate: addDays(today, 5),
        weeklyHours: 20,
      }).expect(201);
      expect(response.body).toMatchObject({
        source: 'DIRECT',
        requestId: null,
        category: 'EXECUTION_PROJECT',
        classification: 'THIRD_PARTY',
        comment: null,
        initiative: { id: fixture.initiative.id, code: fixture.initiative.code },
        state: 'IN_PROGRESS',
      });
      const saved = await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: response.body.id });
      expect(saved).toMatchObject({ origin: 'DIRECT', createdByPersonId: fixture.moderator.id, approvedStartDate: addDays(today, -2) });
      const history = await dataSource!.getRepository(ResourceAllocationHistory).findBy({ allocationId: response.body.id });
      expect(history.map(({ action }) => action)).toEqual(['DIRECT_ALLOCATION_CREATED']);
      expect(await notices(fixture.colleague)).toEqual([{ event_code: 'ALLOCATION_CREATED', allocation_id: response.body.id, title: 'New direct allocation' }]);
      for (const other of [fixture.moderator, fixture.supervisor, fixture.manager, fixture.member]) {
        expect(await notices(other)).toEqual([]);
      }
      const visible = await request(app!.getHttpServer())
        .get(allocationsPath)
        .set('X-PMO-Local-User-ID', fixture.colleague.localUserId)
        .expect(200);
      expect(visible.body.items.map(({ id }: { id: string }) => id)).toEqual([response.body.id]);
    });

    it('applies leadership scope by role and lets Admin allocate globally', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const body = (personId: string, resourceProfileId: string) => ({
        personId, category: 'ROUTINE_SUPPORT', resourceProfileId, startDate: today, endDate: today, weeklyHours: 10, comment: 'Support.',
      });
      await create(fixture.supervisor, body(fixture.member.id, fixture.profile.id)).expect(201);
      await create(fixture.manager, body(fixture.member.id, fixture.profile.id)).expect(201);
      await create(fixture.admin, body(fixture.outsider.id, fixture.otherProfile.id)).expect(201);
      const coveringSupervisor = await addPerson('ops-covering-supervisor', ResourceAllocationRole.Supervisor);
      await dataSource!.getRepository(ResourcePerson).update(coveringSupervisor.id, { coveredGroupIds: [fixture.otherGroup.id] });
      await create(coveringSupervisor, body(fixture.outsider.id, fixture.otherProfile.id)).expect(201);

      const before = await countEffects();
      const denied = [
        await create(fixture.moderator, body(fixture.outsider.id, fixture.otherProfile.id)),
        await create(fixture.otherSupervisor, body(fixture.member.id, fixture.profile.id)),
        await create(fixture.member, body(fixture.colleague.id, fixture.profile.id)),
      ];
      expect(denied.map(({ status, body: problem }) => [status, problem.code])).toEqual([
        [403, 'ACCESS_DENIED'], [403, 'ACCESS_DENIED'], [403, 'ACCESS_DENIED'],
      ]);
      expect(await countEffects()).toEqual(before);
    });

    it('rejects inactive or mismatched references and inactive people without effects', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const base = {
        personId: fixture.member.id, category: 'POC_BBP', initiativeId: fixture.initiative.id, resourceProfileId: fixture.profile.id,
        startDate: today, endDate: today, weeklyHours: 10,
      };
      const before = await countEffects();
      expect((await create(fixture.moderator, { ...base, initiativeId: fixture.inactiveInitiative.id }).expect(422)).body.errors[0].path).toBe('initiativeId');
      expect((await create(fixture.moderator, { ...base, resourceProfileId: fixture.inactiveProfile.id }).expect(422)).body.errors[0].path).toBe('resourceProfileId');
      expect((await create(fixture.admin, { ...base, resourceProfileId: fixture.otherProfile.id }).expect(422)).body.errors[0].path).toBe('resourceProfileId');
      expect((await create(fixture.moderator, { ...base, initiativeId: undefined }).expect(400)).body.errors[0]).toMatchObject({ path: 'initiativeId', code: 'REQUIRED' });
      await dataSource!.getRepository(ResourcePerson).update(fixture.colleague.id, { active: false });
      expect((await create(fixture.moderator, { ...base, personId: fixture.colleague.id }).expect(422)).body.errors[0].path).toBe('personId');
      await create(fixture.moderator, { ...base, personId: randomUUID() }).expect(422);
      expect(await countEffects()).toEqual(before);
    });
  });

  describe('direct allocation scope options (#93)', () => {
    it('lists only the groups each role may allocate directly, including covered groups', async () => {
      const fixture = await setup();
      const covering = await addPerson('ops-covering', ResourceAllocationRole.Supervisor);
      await dataSource!.getRepository(ResourcePerson).update(covering.id, { coveredGroupIds: [fixture.otherGroup.id] });
      const groupsFor = async (person: ResourcePerson) => (await request(app!.getHttpServer())
        .get('/api/resource-allocation/v1/allocation-groups')
        .set('X-PMO-Local-User-ID', person.localUserId)
        .expect(200)).body.items.map(({ name }: { name: string }) => name).sort();
      expect(await groupsFor(fixture.member)).toEqual([]);
      expect(await groupsFor(fixture.moderator)).toEqual(['Platform']);
      expect(await groupsFor(fixture.supervisor)).toEqual(['Platform']);
      expect(await groupsFor(fixture.manager)).toEqual(['Platform']);
      expect(await groupsFor(covering)).toEqual(['Data']);
      expect((await groupsFor(fixture.admin)).sort()).toEqual(['Data', 'Platform']);
      const firstPage = await request(app!.getHttpServer()).get('/api/resource-allocation/v1/allocation-groups')
        .query({ limit: 1 }).set('X-PMO-Local-User-ID', fixture.admin.localUserId).expect(200);
      expect(firstPage.body.items).toHaveLength(1);
      expect(firstPage.body.page).toMatchObject({ limit: 1, nextCursor: expect.any(String) });
      const secondPage = await request(app!.getHttpServer()).get('/api/resource-allocation/v1/allocation-groups')
        .query({ limit: 1, cursor: firstPage.body.page.nextCursor }).set('X-PMO-Local-User-ID', fixture.admin.localUserId).expect(200);
      expect(secondPage.body).toMatchObject({ page: { nextCursor: null } });
      expect([firstPage.body.items[0].name, secondPage.body.items[0].name].sort()).toEqual(['Data', 'Platform']);
      await request(app!.getHttpServer()).get('/api/resource-allocation/v1/allocation-groups')
        .query({ cursor: 'not-a-cursor' }).set('X-PMO-Local-User-ID', fixture.admin.localUserId).expect(400);
    });

    it('answers a User direct attempt with 403 whether or not the person exists', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const body = { category: 'TRAINING', resourceProfileId: fixture.profile.id, startDate: today, endDate: today, weeklyHours: 2, comment: 'Course.' };
      await create(fixture.member, { ...body, personId: randomUUID() }).expect(403);
      await create(fixture.member, { ...body, personId: fixture.outsider.id }).expect(403);
    });
  });

  describe('vacation (#94)', () => {
    it('records own Vacation at 40 weekly hours without profile or initiative and notifies leaders', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const response = await create(fixture.member, { category: 'VACATION', startDate: addDays(today, 7), endDate: addDays(today, 20) }).expect(201);
      expect(response.body).toMatchObject({
        source: 'SELF', category: 'VACATION', weeklyHours: 40, resourceProfile: null, initiative: null, comment: null,
        state: 'NOT_STARTED', availableActions: ['CANCEL'],
      });
      const saved = await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: response.body.id });
      expect(saved).toMatchObject({ resourceProfileId: null, resourceProfileSnapshot: null, initiativeId: null, weeklyHours: '40.0' });
      expect((await notices(fixture.moderator)).map(({ allocation_id: id }) => id)).toEqual([response.body.id]);

      await create(fixture.member, { category: 'VACATION', startDate: addDays(today, 7), endDate: addDays(today, 9), weeklyHours: 40 }).expect(201);
      const incompatible = await create(fixture.member, {
        category: 'VACATION', resourceProfileId: fixture.profile.id, initiativeId: fixture.initiative.id, startDate: today, endDate: today, weeklyHours: 20,
      }).expect(400);
      expect(incompatible.body.errors.map(({ path }: { path: string }) => path).sort()).toEqual(['initiativeId', 'resourceProfileId', 'weeklyHours']);
      const described = await create(fixture.member, { category: 'VACATION', startDate: today, endDate: today, comment: 'Hidden text' }).expect(400);
      expect(described.body.errors).toEqual([expect.objectContaining({ path: 'comment', code: 'NOT_ALLOWED' })]);
    });

    it('lets leadership register Vacation directly and keeps colleagues from reading it', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const response = await create(fixture.moderator, {
        personId: fixture.member.id, category: 'VACATION', startDate: addDays(today, -10), endDate: addDays(today, -1),
      }).expect(201);
      expect(response.body).toMatchObject({ source: 'DIRECT', state: 'DONE', classification: 'INTERNAL' });
      expect((await notices(fixture.member)).map(({ title }) => title)).toEqual(['New direct allocation']);
      await create(fixture.otherModerator, { personId: fixture.member.id, category: 'VACATION', startDate: today, endDate: today }).expect(403);

      await request(app!.getHttpServer())
        .get(`${allocationsPath}/${response.body.id}`)
        .set('X-PMO-Local-User-ID', fixture.colleague.localUserId)
        .expect(403);
      const colleagueList = await request(app!.getHttpServer())
        .get(allocationsPath)
        .set('X-PMO-Local-User-ID', fixture.colleague.localUserId)
        .expect(200);
      expect(colleagueList.body.items).toEqual([]);
      const ownList = await request(app!.getHttpServer())
        .get(allocationsPath)
        .set('X-PMO-Local-User-ID', fixture.member.localUserId)
        .expect(200);
      expect(ownList.body.items).toEqual([expect.objectContaining({ id: response.body.id, category: 'VACATION', resourceProfile: null })]);
    });

    it('rejects suspend and reserve for Vacation and moves it only through date-driven states', async () => {
      const fixture = await setup();
      const today = await businessDate();
      const vacation = await create(fixture.member, { category: 'VACATION', startDate: today, endDate: addDays(today, 3) }).expect(201);
      expect(vacation.body).toMatchObject({ state: 'IN_PROGRESS', availableActions: ['COMPLETE', 'CANCEL'] });
      for (const command of ['suspensions', 'reservations']) {
        const rejected = await request(app!.getHttpServer())
          .post(`${allocationsPath}/${vacation.body.id}/${command}`)
          .set({
            'X-PMO-Local-User-ID': fixture.member.localUserId,
            'If-Match': '"1"',
            'Idempotency-Key': randomUUID(),
            'X-Correlation-ID': randomUUID(),
          })
          .send({ reason: 'Trying an unsupported transition.' })
          .expect(422);
        expect(rejected.body.code).toBe('INVALID_ALLOCATION_TRANSITION');
      }
      expect(await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: vacation.body.id })).toMatchObject({ state: 'IN_PROGRESS', version: 1 });

      const future = await create(fixture.member, { category: 'VACATION', startDate: addDays(today, 1), endDate: addDays(today, 2) }).expect(201);
      await dataSource!.query(
        'UPDATE resource_allocations SET effective_start_date = $2::date, approved_start_date = $2::date WHERE id = $1::uuid',
        [future.body.id, today],
      );
      await dataSource!.query(
        "UPDATE resource_allocations SET effective_end_date = $2::date, approved_end_date = $2::date, effective_start_date = $3::date, approved_start_date = $3::date, state = 'IN_PROGRESS' WHERE id = $1::uuid",
        [vacation.body.id, addDays(today, -1), addDays(today, -4)],
      );
      const worker = app!.get(ResourceAllocationService);
      expect(await worker.processScheduledBatch()).toBe(2);
      expect(await worker.processScheduledBatch()).toBe(0);
      expect(await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: future.body.id })).toMatchObject({ state: 'IN_PROGRESS' });
      expect(await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({ id: vacation.body.id })).toMatchObject({ state: 'DONE' });
    });
  });
});
