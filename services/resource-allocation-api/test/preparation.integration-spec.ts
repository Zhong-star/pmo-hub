import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { RESOURCE_ALLOCATION_DATA_SOURCE } from '../src/database/database.module';
import { prepareFirstAdmin } from '../src/database/prepare-first-admin';
import {
  prepareMinimalRecords,
  readMinimalRecordsOptionsFromEnv,
} from '../src/database/prepare-minimal-records';
import { prepareDemoData } from '../src/database/prepare-demo-data';
import { ResourceAllocation } from '../src/allocations/resource-allocation.entity';
import { ResourceAllocationHistory } from '../src/allocations/resource-allocation-history.entity';
import { ResourceGroup } from '../src/groups/resource-group.entity';
import { ResourceInitiative } from '../src/initiatives/resource-initiative.entity';
import { ResourceAllocationNotification } from '../src/notifications/resource-allocation-notification.entity';
import { ResourceAllocationRole } from '../src/people/resource-allocation-role';
import { ResourcePerson } from '../src/people/resource-person.entity';
import { ResourceProfile } from '../src/resource-profiles/resource-profile.entity';
import { ResourceRequest } from '../src/requests/resource-request.entity';
import { ResourceRequestAudit } from '../src/requests/resource-request-audit.entity';
import { ResourceRequestHistory } from '../src/requests/resource-request-history.entity';
import { ResourceSubmission } from '../src/submissions/resource-submission.entity';
import { ResourceSubmissionLine } from '../src/submissions/resource-submission-line.entity';
import { ResourceRequestDecisionState, ResourceSubmissionLineStatus } from '../src/submissions/submission-category';

const execFileAsync = promisify(execFile);
const serviceRoot = resolve(__dirname, '..');

function runNpmScript(scriptName: string, env: NodeJS.ProcessEnv) {
  return process.platform === 'win32'
    ? execFileAsync('cmd.exe', ['/d', '/c', 'npm', 'run', scriptName], {
        cwd: serviceRoot,
        env,
        timeout: 120_000,
        windowsHide: true,
      })
    : execFileAsync('npm', ['run', scriptName], {
        cwd: serviceRoot,
        env,
        timeout: 120_000,
        windowsHide: true,
      });
}

describe('Tech Resource Allocation local preparation scripts (#75)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_preparation_test')
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
    await dataSource?.query(`
      TRUNCATE TABLE
        resource_allocation_notifications,
        resource_allocation_history,
        resource_allocations,
        resource_request_audits,
        resource_request_history,
        resource_requests,
        resource_submission_entries,
        resource_submission_lines,
        resource_submissions,
        resource_allocation_operation_receipts,
        resource_profiles,
        resource_initiatives,
        resource_groups,
        resource_people
      RESTART IDENTITY CASCADE
    `);
  });

  it('provisions minimal operational baseline without creating demo requests or allocations and keeps First Admin and unprovisioned profiles intact', async () => {
    await prepareFirstAdmin(dataSource!, {
      localUserId: 'local-developer',
      displayName: 'Local Developer',
      email: 'local-developer@example.test',
    });

    const result = await prepareMinimalRecords(dataSource!);

    expect(result.groupCreated).toBe(true);
    expect(result.group).toMatchObject({ name: 'Platform Engineering', active: true });
    expect(result.profilesCreated).toBe(2);
    expect(result.profiles).toHaveLength(2);
    expect(result.initiativeCreated).toBe(true);
    expect(result.initiative).toMatchObject({ code: 'ITDM-LOCAL-001', active: true });

    const groups = await dataSource!.getRepository(ResourceGroup).find();
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.active).toBe(true);
    expect(group.supervisorId).toBeTruthy();
    expect(group.managerId).toBeTruthy();

    const people = await dataSource!.getRepository(ResourcePerson).find({ order: { localUserId: 'ASC' } });
    expect(people.map((person) => person.localUserId)).toEqual([
      'local-contributor',
      'local-developer',
      'local-moderator',
      'local-pmo',
      'local-supervisor',
    ]);

    const supervisor = people.find((person) => person.id === group.supervisorId);
    const manager = people.find((person) => person.id === group.managerId);
    expect(supervisor).toMatchObject({ role: ResourceAllocationRole.Supervisor, active: true, coveredGroupIds: [group.id] });
    expect(manager).toMatchObject({ localUserId: 'local-pmo', role: ResourceAllocationRole.Manager, active: true, coveredGroupIds: [group.id] });
    expect(people.find((person) => person.localUserId === 'local-moderator')).toMatchObject({
      role: ResourceAllocationRole.Moderator,
      active: true,
      groupId: group.id,
    });
    expect(people.find((person) => person.localUserId === 'local-contributor')).toMatchObject({
      role: ResourceAllocationRole.User,
      active: true,
      groupId: group.id,
    });
    expect(people.find((person) => person.localUserId === 'local-developer')).toMatchObject({
      role: ResourceAllocationRole.Admin,
      active: true,
    });

    const profiles = await dataSource!.getRepository(ResourceProfile).find({ order: { name: 'ASC' } });
    expect(profiles).toHaveLength(2);
    expect(profiles.every((profile) => profile.active && profile.groupId === group.id)).toBe(true);

    const initiatives = await dataSource!.getRepository(ResourceInitiative).find();
    expect(initiatives).toHaveLength(1);
    expect(initiatives[0]).toMatchObject({ code: 'ITDM-LOCAL-001', active: true });

    // Strict separation: minimal prep must never create requests, submissions, allocations, audits, or notifications.
    expect(await dataSource!.getRepository(ResourceSubmission).count()).toBe(0);
    expect(await dataSource!.getRepository(ResourceSubmissionLine).count()).toBe(0);
    expect(await dataSource!.getRepository(ResourceRequest).count()).toBe(0);
    expect(await dataSource!.getRepository(ResourceRequestAudit).count()).toBe(0);
    expect(await dataSource!.getRepository(ResourceAllocation).count()).toBe(0);
    expect(await dataSource!.getRepository(ResourceAllocationNotification).count()).toBe(0);

    // Real HTTP API verification.
    await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/access')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/access')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/access')
      .set('X-PMO-Local-User-ID', 'local-no-access')
      .expect(403);

    const selectableGroups = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/groups')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(selectableGroups.body.items).toHaveLength(1);

    const selectableProfiles = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/resource-profiles?groupId=${group.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(selectableProfiles.body.items).toHaveLength(2);

    const selectableInitiatives = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/initiatives')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(selectableInitiatives.body.items).toHaveLength(1);
  });

  it('is idempotent under repeated and concurrent runs and preserves manual administrative edits', async () => {
    await prepareFirstAdmin(dataSource!, {
      localUserId: 'local-developer',
      displayName: 'Local Developer',
      email: 'local-developer@example.test',
    });

    const first = await prepareMinimalRecords(dataSource!);
    expect(first.groupCreated).toBe(true);
    expect(first.profilesCreated).toBe(2);
    expect(first.initiativeCreated).toBe(true);
    expect(first.peopleCreated).toBe(4);

    const [second, concurrent] = await Promise.all([
      prepareMinimalRecords(dataSource!),
      prepareMinimalRecords(dataSource!),
    ]);
    for (const runResult of [second, concurrent]) {
      expect(runResult.groupCreated).toBe(false);
      expect(runResult.profilesCreated).toBe(0);
      expect(runResult.initiativeCreated).toBe(false);
      expect(runResult.peopleCreated).toBe(0);
    }

    // Apply real administrative edits via HTTP API.
    const adminHeader = 'local-developer';
    const editedGroup = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/groups/${first.group.id}`)
      .set('X-PMO-Local-User-ID', adminHeader)
      .set('If-Match', `"${first.group.version}"`)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Platform Engineering Custom' })
      .expect(200);

    const targetProfile = first.profiles[0];
    const editedProfile = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/resource-profiles/${targetProfile.id}`)
      .set('X-PMO-Local-User-ID', adminHeader)
      .set('If-Match', `"${targetProfile.version}"`)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Principal Engineer', active: false })
      .expect(200);

    const editedInitiative = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/initiatives/${first.initiative.id}`)
      .set('X-PMO-Local-User-ID', adminHeader)
      .set('If-Match', `"${first.initiative.version}"`)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ code: 'ITDM-CUSTOM-001', name: 'Renamed Baseline ITDM', active: false })
      .expect(200);

    const contributor = first.people.find((person) => person.localUserId === 'local-contributor')!;
    const editedContributor = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/people/${contributor.id}`)
      .set('X-PMO-Local-User-ID', adminHeader)
      .set('If-Match', `"${contributor.version}"`)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ displayName: 'Edited Contributor', email: 'edited-contributor@example.test' })
      .expect(200);

    const moderator = first.people.find((person) => person.localUserId === 'local-moderator')!;
    const deactivatedModerator = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/people/${moderator.id}`)
      .set('X-PMO-Local-User-ID', adminHeader)
      .set('If-Match', `"${moderator.version}"`)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ active: false })
      .expect(200);

    // Re-run minimal preparation after manual edits.
    const afterEdits = await prepareMinimalRecords(dataSource!);
    expect(afterEdits.groupCreated).toBe(false);
    expect(afterEdits.profilesCreated).toBe(0);
    expect(afterEdits.initiativeCreated).toBe(false);
    expect(afterEdits.peopleCreated).toBe(0);

    expect(await dataSource!.getRepository(ResourceGroup).count()).toBe(1);
    expect(await dataSource!.getRepository(ResourceProfile).count()).toBe(2);
    expect(await dataSource!.getRepository(ResourceInitiative).count()).toBe(1);
    expect(await dataSource!.getRepository(ResourcePerson).count()).toBe(5);

    const reloadedGroup = await dataSource!.getRepository(ResourceGroup).findOneByOrFail({ id: first.group.id });
    expect(reloadedGroup).toMatchObject({ name: 'Platform Engineering Custom', version: editedGroup.body.version });

    const reloadedProfile = await dataSource!.getRepository(ResourceProfile).findOneByOrFail({ id: targetProfile.id });
    expect(reloadedProfile).toMatchObject({
      name: 'Principal Engineer',
      active: false,
      version: editedProfile.body.version,
    });

    const reloadedInitiative = await dataSource!.getRepository(ResourceInitiative).findOneByOrFail({
      id: first.initiative.id,
    });
    expect(reloadedInitiative).toMatchObject({
      code: 'ITDM-CUSTOM-001',
      name: 'Renamed Baseline ITDM',
      active: false,
      version: editedInitiative.body.version,
    });

    const reloadedContributor = await dataSource!.getRepository(ResourcePerson).findOneByOrFail({ id: contributor.id });
    expect(reloadedContributor).toMatchObject({
      displayName: 'Edited Contributor',
      email: 'edited-contributor@example.test',
      version: editedContributor.body.version,
    });

    const reloadedModerator = await dataSource!.getRepository(ResourcePerson).findOneByOrFail({ id: moderator.id });
    expect(reloadedModerator).toMatchObject({
      active: false,
      version: deactivatedModerator.body.version,
    });
  });

  it('supports environment overrides, fails safely on conflicting role without overwriting, and does not block First Admin', async () => {
    const customOptions = readMinimalRecordsOptionsFromEnv({
      RESOURCE_ALLOCATION_MINIMAL_GROUP_NAME: 'Data Architecture',
      RESOURCE_ALLOCATION_MINIMAL_PROFILE_NAMES: 'Data Engineer, Analytics Engineer',
      RESOURCE_ALLOCATION_MINIMAL_INITIATIVE_CODE: 'ITDM-DATA-01',
      RESOURCE_ALLOCATION_MINIMAL_INITIATIVE_NAME: 'Data Foundation',
      RESOURCE_ALLOCATION_MINIMAL_MANAGER_LOCAL_USER_ID: 'local-pmo',
      RESOURCE_ALLOCATION_MINIMAL_MANAGER_DISPLAY_NAME: 'Custom PMO',
      RESOURCE_ALLOCATION_MINIMAL_MANAGER_EMAIL: 'custom-pmo@example.test',
    });

    const prepared = await prepareMinimalRecords(dataSource!, customOptions);
    expect(prepared.group.name).toBe('Data Architecture');
    expect(prepared.profiles.map((profile) => profile.name)).toEqual(['Analytics Engineer', 'Data Engineer']);
    expect(prepared.initiative).toMatchObject({ code: 'ITDM-DATA-01', name: 'Data Foundation' });

    // First Admin can still be prepared afterwards because minimal prep never creates an Admin.
    const adminResult = await prepareFirstAdmin(dataSource!, {
      localUserId: 'local-developer',
      displayName: 'Local Developer',
      email: 'local-developer@example.test',
    });
    expect(adminResult.created).toBe(true);

    // Clear and test conflict when First Admin took the configured Manager Hub profile before minimal prep.
    await dataSource!.query(`
      TRUNCATE TABLE resource_profiles, resource_initiatives, resource_groups, resource_people RESTART IDENTITY CASCADE
    `);
    await prepareFirstAdmin(dataSource!, {
      localUserId: 'local-pmo',
      displayName: 'PMO Admin',
      email: 'pmo-admin@example.test',
    });

    await expect(prepareMinimalRecords(dataSource!)).rejects.toThrow(/Manager Hub profile \(local-pmo\)/);
    expect(await dataSource!.getRepository(ResourcePerson).count({ where: { localUserId: 'local-pmo' } })).toBe(1);
    const untouchedPmo = await dataSource!.getRepository(ResourcePerson).findOneByOrFail({ localUserId: 'local-pmo' });
    expect(untouchedPmo.role).toBe(ResourceAllocationRole.Admin);
    expect(await dataSource!.getRepository(ResourceGroup).count()).toBe(0);
  });

  it('populates separate optional demo requests, decisions, allocations, and history across lifecycle stages and exposes valid API views', async () => {
    await prepareFirstAdmin(dataSource!, {
      localUserId: 'local-developer',
      displayName: 'Local Developer',
      email: 'local-developer@example.test',
    });
    await prepareMinimalRecords(dataSource!);

    const demo = await prepareDemoData(dataSource!);

    expect(demo.initiativesCreated).toBe(2);
    expect(demo.submissionsCreated).toBe(2);
    expect(demo.requestsCreated).toBe(12);
    expect(demo.allocationsCreated).toBe(4);
    expect(demo.failedLinesCreated).toBe(1);

    const requests = await dataSource!.getRepository(ResourceRequest).find();
    expect(requests).toHaveLength(12);
    expect(new Set(requests.map((item) => item.decisionState))).toEqual(
      new Set([
        ResourceRequestDecisionState.WaitingForPresentation,
        ResourceRequestDecisionState.PendingTeamDecision,
        ResourceRequestDecisionState.ApprovedWithChanges,
        ResourceRequestDecisionState.Approved,
        ResourceRequestDecisionState.Denied,
        ResourceRequestDecisionState.PreN3,
        ResourceRequestDecisionState.Escalation,
        ResourceRequestDecisionState.RequiresRevalidation,
        ResourceRequestDecisionState.Cancelled,
      ]),
    );

    const allocations = await dataSource!.getRepository(ResourceAllocation).find();
    expect(allocations).toHaveLength(4);
    expect(new Set(allocations.map((item) => item.state))).toEqual(
      new Set(['IN_PROGRESS', 'NOT_STARTED', 'SUSPENDED', 'DONE']),
    );
    expect(await dataSource!.getRepository(ResourceRequestHistory).count()).toBeGreaterThanOrEqual(12);
    expect(await dataSource!.getRepository(ResourceAllocationHistory).count()).toBeGreaterThanOrEqual(4);
    expect(await dataSource!.getRepository(ResourceAllocationNotification).count()).toBeGreaterThan(0);

    // Verify all HTTP read surfaces against the seeded demo records.
    const submissionsRes = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/submissions')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(submissionsRes.body.items).toHaveLength(2);
    const failedSubmission = submissionsRes.body.items.find((item: { counts: { failed: number } }) => item.counts.failed === 1);
    expect(failedSubmission).toBeDefined();

    const failedLinesRes = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/submissions/${failedSubmission.id}/lines`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(failedLinesRes.body.items[0]).toMatchObject({
      status: ResourceSubmissionLineStatus.Failed,
      problem: { code: 'INVALID_BUSINESS_DATE' },
    });

    const presentationQueue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/presentation')
      .set('X-PMO-Local-User-ID', 'local-developer')
      .expect(200);
    expect(presentationQueue.body.items).toHaveLength(1);
    expect(presentationQueue.body.items[0].availableActions).toContain('REFER');

    const teamQueue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/team-decision')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(teamQueue.body.items).toHaveLength(1);
    expect(teamQueue.body.items[0].availableActions).toContain('APPROVE');

    const exceptionsQueue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/exceptions')
      .set('X-PMO-Local-User-ID', 'local-developer')
      .expect(200);
    expect(exceptionsQueue.body.items.map((item: { decisionState: string }) => item.decisionState).sort()).toEqual([
      'ESCALATION',
      'PRE_N3',
    ]);

    const revalidationQueue = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/request-queues/revalidation')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(revalidationQueue.body.items).toHaveLength(1);
    expect(revalidationQueue.body.items[0].impediments).toContain('PROPOSED_START_DATE_PASSED');

    const deniedRequest = requests.find((item) => item.decisionState === ResourceRequestDecisionState.Denied)!;
    const deniedHistory = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/requests/${deniedRequest.id}/history`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(deniedHistory.body.latestDenial).toMatchObject({ action: 'DENIED' });

    const allocationsRes = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/allocations')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(allocationsRes.body.items).toHaveLength(4);

    const todayRows = await dataSource!.query(
      "SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today",
    ) as Array<{ today: string }>;
    const loadRes = await request(app!.getHttpServer())
      .get(`/api/resource-allocation/v1/allocation-load?date=${todayRows[0].today}`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200);
    expect(loadRes.body.items.length).toBeGreaterThanOrEqual(2);

    const notificationsRes = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(notificationsRes.body.items.length).toBeGreaterThanOrEqual(3);

    // Works without prior First Admin and leaves Admin slot open for prepareFirstAdmin.
    await dataSource!.query(`
      TRUNCATE TABLE
        resource_allocation_notifications,
        resource_allocation_history,
        resource_allocations,
        resource_request_audits,
        resource_request_history,
        resource_requests,
        resource_submission_entries,
        resource_submission_lines,
        resource_submissions,
        resource_allocation_operation_receipts,
        resource_profiles,
        resource_initiatives,
        resource_groups,
        resource_people
      RESTART IDENTITY CASCADE
    `);
    await prepareDemoData(dataSource!);
    expect(await dataSource!.getRepository(ResourcePerson).count({ where: { role: ResourceAllocationRole.Admin } })).toBe(0);
    const firstAdminAfterDemo = await prepareFirstAdmin(dataSource!, {
      localUserId: 'local-developer',
      displayName: 'Local Developer',
      email: 'local-developer@example.test',
    });
    expect(firstAdminAfterDemo.created).toBe(true);
  });

  it('is idempotent under repeated and concurrent runs and preserves manual edits and workflow transitions on demo data', async () => {
    await prepareFirstAdmin(dataSource!, {
      localUserId: 'local-developer',
      displayName: 'Local Developer',
      email: 'local-developer@example.test',
    });
    const minimal = await prepareMinimalRecords(dataSource!);
    const first = await prepareDemoData(dataSource!);
    expect(first.requestsCreated).toBe(12);

    const [second, concurrent] = await Promise.all([
      prepareDemoData(dataSource!),
      prepareDemoData(dataSource!),
    ]);
    for (const repeat of [second, concurrent]) {
      expect(repeat).toEqual({
        initiativesCreated: 0,
        submissionsCreated: 0,
        requestsCreated: 0,
        allocationsCreated: 0,
        failedLinesCreated: 0,
      });
    }

    const requestHistoryBefore = await dataSource!.getRepository(ResourceRequestHistory).count();
    const allocationHistoryBefore = await dataSource!.getRepository(ResourceAllocationHistory).count();
    const notificationsBefore = await dataSource!.getRepository(ResourceAllocationNotification).count();
    expect(requestHistoryBefore).toBeGreaterThanOrEqual(12);
    expect(allocationHistoryBefore).toBe(4);
    expect(notificationsBefore).toBeGreaterThan(0);

    // Edit & withdraw the waiting request via HTTP API.
    const waitingRequest = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({
      decisionState: ResourceRequestDecisionState.WaitingForPresentation,
    });
    const patchedWaiting = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/requests/${waitingRequest.id}`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .set('If-Match', `"${waitingRequest.version}"`)
      .set('X-Correlation-ID', randomUUID())
      .set('Content-Type', 'application/merge-patch+json')
      .send({ weeklyHours: 28, comment: 'Edited before withdrawal' })
      .expect(200);

    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${waitingRequest.id}/withdrawals`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .set('If-Match', `"${patchedWaiting.body.version}"`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', randomUUID())
      .send({ reason: 'No longer required after scope review.' })
      .expect(200);

    // Accept the changed proposal via HTTP API (creates a 5th allocation).
    const changedProposal = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({
      decisionState: ResourceRequestDecisionState.ApprovedWithChanges,
    });
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/requests/${changedProposal.id}/acceptances`)
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .set('If-Match', `"${changedProposal.version}"`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', randomUUID())
      .send({})
      .expect(200);

    // Suspend the In Progress allocation via HTTP API.
    const inProgressAllocation = await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({
      state: 'IN_PROGRESS',
    });
    await request(app!.getHttpServer())
      .post(`/api/resource-allocation/v1/allocations/${inProgressAllocation.id}/suspensions`)
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .set('If-Match', `"${inProgressAllocation.version}"`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Correlation-ID', randomUUID())
      .send({ reason: 'Manually suspended during demo exploration.' })
      .expect(200);

    // Mark all contributor notifications read.
    await request(app!.getHttpServer())
      .post('/api/resource-allocation/v1/notification-readings')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .set('Idempotency-Key', randomUUID())
      .expect(200);

    // Edit unused demo initiative & minimal group via Admin API.
    const secondaryDemoInitiative = await dataSource!.getRepository(ResourceInitiative).findOneByOrFail({
      code: 'ITDM-DEMO-002',
    });
    const editedSecondaryInitiative = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/initiatives/${secondaryDemoInitiative.id}`)
      .set('X-PMO-Local-User-ID', 'local-developer')
      .set('If-Match', `"${secondaryDemoInitiative.version}"`)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ code: 'ITDM-DEMO-RENAMED', name: 'Edited Demo Initiative', active: false })
      .expect(200);

    const editedGroup = await request(app!.getHttpServer())
      .patch(`/api/resource-allocation/v1/admin/groups/${minimal.group.id}`)
      .set('X-PMO-Local-User-ID', 'local-developer')
      .set('If-Match', `"${minimal.group.version}"`)
      .set('Content-Type', 'application/merge-patch+json')
      .send({ name: 'Platform Engineering Demo Edited' })
      .expect(200);

    const expectedCountsAfterEdits = {
      groups: await dataSource!.getRepository(ResourceGroup).count(),
      profiles: await dataSource!.getRepository(ResourceProfile).count(),
      initiatives: await dataSource!.getRepository(ResourceInitiative).count(),
      people: await dataSource!.getRepository(ResourcePerson).count(),
      submissions: await dataSource!.getRepository(ResourceSubmission).count(),
      lines: await dataSource!.getRepository(ResourceSubmissionLine).count(),
      requests: await dataSource!.getRepository(ResourceRequest).count(),
      audits: await dataSource!.getRepository(ResourceRequestAudit).count(),
      allocations: await dataSource!.getRepository(ResourceAllocation).count(),
      requestHistory: await dataSource!.getRepository(ResourceRequestHistory).count(),
      allocationHistory: await dataSource!.getRepository(ResourceAllocationHistory).count(),
      notifications: await dataSource!.getRepository(ResourceAllocationNotification).count(),
    };

    // Re-run both demo and minimal preparations after workflow mutations and admin edits.
    const repeatDemo = await prepareDemoData(dataSource!);
    expect(repeatDemo).toEqual({
      initiativesCreated: 0,
      submissionsCreated: 0,
      requestsCreated: 0,
      allocationsCreated: 0,
      failedLinesCreated: 0,
    });
    const repeatMinimal = await prepareMinimalRecords(dataSource!);
    expect(repeatMinimal.groupCreated).toBe(false);
    expect(repeatMinimal.profilesCreated).toBe(0);
    expect(repeatMinimal.initiativeCreated).toBe(false);
    expect(repeatMinimal.peopleCreated).toBe(0);

    expect({
      groups: await dataSource!.getRepository(ResourceGroup).count(),
      profiles: await dataSource!.getRepository(ResourceProfile).count(),
      initiatives: await dataSource!.getRepository(ResourceInitiative).count(),
      people: await dataSource!.getRepository(ResourcePerson).count(),
      submissions: await dataSource!.getRepository(ResourceSubmission).count(),
      lines: await dataSource!.getRepository(ResourceSubmissionLine).count(),
      requests: await dataSource!.getRepository(ResourceRequest).count(),
      audits: await dataSource!.getRepository(ResourceRequestAudit).count(),
      allocations: await dataSource!.getRepository(ResourceAllocation).count(),
      requestHistory: await dataSource!.getRepository(ResourceRequestHistory).count(),
      allocationHistory: await dataSource!.getRepository(ResourceAllocationHistory).count(),
      notifications: await dataSource!.getRepository(ResourceAllocationNotification).count(),
    }).toEqual(expectedCountsAfterEdits);

    const reloadedWithdrawn = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: waitingRequest.id });
    expect(reloadedWithdrawn.removedAt).not.toBeNull();
    expect(reloadedWithdrawn.requestedConditions).toMatchObject({
      weeklyHours: 28,
      comment: 'Edited before withdrawal',
    });

    const reloadedAccepted = await dataSource!.getRepository(ResourceRequest).findOneByOrFail({ id: changedProposal.id });
    expect(reloadedAccepted.decisionState).toBe(ResourceRequestDecisionState.Approved);

    const reloadedAllocation = await dataSource!.getRepository(ResourceAllocation).findOneByOrFail({
      id: inProgressAllocation.id,
    });
    expect(reloadedAllocation.state).toBe('SUSPENDED');

    const unreadContributorNotifications = await request(app!.getHttpServer())
      .get('/api/resource-allocation/v1/notifications?read=false')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);
    expect(unreadContributorNotifications.body.items).toHaveLength(0);

    const reloadedSecondary = await dataSource!.getRepository(ResourceInitiative).findOneByOrFail({
      id: secondaryDemoInitiative.id,
    });
    expect(reloadedSecondary).toMatchObject({
      code: 'ITDM-DEMO-RENAMED',
      name: 'Edited Demo Initiative',
      active: false,
      version: editedSecondaryInitiative.body.version,
    });

    const reloadedGroup = await dataSource!.getRepository(ResourceGroup).findOneByOrFail({ id: minimal.group.id });
    expect(reloadedGroup).toMatchObject({
      name: 'Platform Engineering Demo Edited',
      version: editedGroup.body.version,
    });
  });

  it('executes npm run prepare:minimal and npm run prepare:demo repeatably via CLI and fails cleanly when database URL is missing', async () => {
    const cliEnv = {
      ...process.env,
      RESOURCE_ALLOCATION_DATABASE_URL: container!.getConnectionUri(),
    };

    await prepareFirstAdmin(dataSource!, {
      localUserId: 'local-developer',
      displayName: 'Local Developer',
      email: 'local-developer@example.test',
    });

    const minimalFirst = await runNpmScript('prepare:minimal', cliEnv);
    expect(minimalFirst.stdout).toContain('Prepared minimal Tech Resource Allocation records');
    expect(await dataSource!.getRepository(ResourceRequest).count()).toBe(0);

    const minimalSecond = await runNpmScript('prepare:minimal', cliEnv);
    expect(minimalSecond.stdout).toContain('already exist; no records were changed');
    expect(await dataSource!.getRepository(ResourceRequest).count()).toBe(0);

    const demoFirst = await runNpmScript('prepare:demo', cliEnv);
    expect(demoFirst.stdout).toContain('Prepared optional Tech Resource Allocation demo dataset');
    expect(await dataSource!.getRepository(ResourceRequest).count()).toBe(12);

    const demoSecond = await runNpmScript('prepare:demo', cliEnv);
    expect(demoSecond.stdout).toContain('already exists; no records were changed');
    expect(await dataSource!.getRepository(ResourceRequest).count()).toBe(12);

    const missingDbEnv = { ...process.env };
    delete missingDbEnv.RESOURCE_ALLOCATION_DATABASE_URL;
    await expect(
      execFileAsync('node', ['dist/database/prepare-minimal-records.js'], {
        cwd: serviceRoot,
        env: missingDbEnv,
        timeout: 30_000,
        windowsHide: true,
      }),
    ).rejects.toThrow(/RESOURCE_ALLOCATION_DATABASE_URL/);
    await expect(
      execFileAsync('node', ['dist/database/prepare-demo-data.js'], {
        cwd: serviceRoot,
        env: missingDbEnv,
        timeout: 30_000,
        windowsHide: true,
      }),
    ).rejects.toThrow(/RESOURCE_ALLOCATION_DATABASE_URL/);
  });
});
