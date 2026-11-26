import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ResourceAllocationAccessService } from '../src/access/resource-allocation-access.service';
import { ResourceAllocationService } from '../src/allocations/resource-allocation.service';
import { AppModule } from '../src/app.module';
import { ResourceAllocationProposalResponseService } from '../src/approvals/resource-allocation-proposal-response.service';
import { configureApp } from '../src/configure-app';
import { RESOURCE_ALLOCATION_DATA_SOURCE } from '../src/database/database.module';
import {
  normalizeVolumeDataOptions,
  prepareVolumeData,
  readVolumeDataOptionsFromEnv,
  VolumeDataAlreadyPreparedError,
} from '../src/database/prepare-volume-data';
import { ResourceAllocationDeadlineWorker } from '../src/deadlines/resource-allocation-deadline.worker';
import { ResourceAllocationTeamDecisionService } from '../src/decisions/resource-allocation-team-decision.service';
import { ResourceAllocationSubmissionWorker } from '../src/submissions/resource-allocation-submission.worker';

const execFileAsync = promisify(execFile);
const serviceRoot = resolve(__dirname, '..');
const api = '/api/resource-allocation/v1';
const reducedVolume = { people: 60, groups: 4, months: 3, seed: 'integration-volume' };

function runNpmScript(scriptName: string, env: NodeJS.ProcessEnv) {
  return process.platform === 'win32'
    ? execFileAsync('cmd.exe', ['/d', '/c', 'npm', 'run', scriptName], { cwd: serviceRoot, env, timeout: 180_000, windowsHide: true })
    : execFileAsync('npm', ['run', scriptName], { cwd: serviceRoot, env, timeout: 180_000, windowsHide: true });
}

describe('Tech Resource Allocation volume dataset (#105)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplication | undefined;
  let dataSource: DataSource | undefined;

  async function countRows(sql: string, parameters: unknown[] = []): Promise<number> {
    const rows = await dataSource!.query(sql, parameters) as Array<{ count: number }>;
    return Number(rows[0].count);
  }

  /** Digest of every volume record, including ids and timestamps, to compare two runs. */
  async function volumeFingerprint(): Promise<string> {
    const rows = await dataSource!.query(`
      WITH volume_groups AS (SELECT id FROM resource_groups WHERE name LIKE 'Volume Group %')
      SELECT md5(string_agg(row_text, '|' ORDER BY row_text)) AS digest FROM (
        SELECT concat_ws('~', 'person', id, local_user_id, display_name, role, classification, group_id, covered_group_ids::text) AS row_text
          FROM resource_people WHERE local_user_id LIKE 'volume-%'
        UNION ALL SELECT concat_ws('~', 'group', id, name, supervisor_id, manager_id) FROM resource_groups WHERE id IN (SELECT id FROM volume_groups)
        UNION ALL SELECT concat_ws('~', 'profile', id, name, group_id) FROM resource_profiles WHERE group_id IN (SELECT id FROM volume_groups)
        UNION ALL SELECT concat_ws('~', 'initiative', id, code, name, code_used) FROM resource_initiatives WHERE code LIKE 'ITDM-VOL-%'
        UNION ALL SELECT concat_ws('~', 'capacity', id, group_id, resource_profile_id, classification, effective_date, fte, created_at) FROM resource_capacities
        UNION ALL SELECT concat_ws('~', 'request', id, requester_id, decision_state, requested_conditions::text, approved_conditions::text,
            received_at, stage_entered_at, expiration_due_at, decision_response_due_at, version) FROM resource_requests
        UNION ALL SELECT concat_ws('~', 'request-history', id, request_id, action, occurred_at) FROM resource_request_history
        UNION ALL SELECT concat_ws('~', 'allocation', id, source_request_id, origin, category, person_id, group_id, resource_profile_id,
            initiative_id, classification, approved_start_date, approved_end_date, effective_end_date, weekly_hours, state, state_entered_at,
            approved_at, created_at, version) FROM resource_allocations
        UNION ALL SELECT concat_ws('~', 'allocation-history', id, allocation_id, action, occurred_at) FROM resource_allocation_history
        UNION ALL SELECT concat_ws('~', 'notification', id, recipient_id, event_code, source_request_id, source_allocation_id, created_at, read_at)
          FROM resource_allocation_notifications
      ) AS volume_rows
    `) as Array<{ digest: string }>;
    return rows[0].digest;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_volume_test')
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
    const tables = await dataSource!.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'",
    ) as Array<{ tablename: string }>;
    await dataSource!.query(`TRUNCATE TABLE ${tables.map(({ tablename }) => `"${tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  });

  it('validates parameters and reads them from the environment with the documented defaults', () => {
    expect(normalizeVolumeDataOptions()).toEqual({ people: 336, groups: 30, months: 12, seed: 'pmo-hub-volume' });
    expect(readVolumeDataOptionsFromEnv({
      RESOURCE_ALLOCATION_VOLUME_PEOPLE: '120',
      RESOURCE_ALLOCATION_VOLUME_GROUPS: '8',
      RESOURCE_ALLOCATION_VOLUME_MONTHS: '6',
      RESOURCE_ALLOCATION_VOLUME_SEED: 'another-seed',
    })).toEqual({ people: 120, groups: 8, months: 6, seed: 'another-seed' });
    expect(() => readVolumeDataOptionsFromEnv({ RESOURCE_ALLOCATION_VOLUME_PEOPLE: '12.5' })).toThrow('whole number');
    expect(() => normalizeVolumeDataOptions({ groups: 30, people: 69 })).toThrow('Volume people count');
    expect(() => normalizeVolumeDataOptions({ months: 0 })).toThrow('Volume month count');
  });

  it('generates the requested volume on the minimal baseline with domain-valid records readable through the API', async () => {
    const result = await prepareVolumeData(dataSource!, reducedVolume);
    const today = result.businessDate;

    expect(result.counts).toMatchObject({ people: 60, groups: 4, profiles: 12, initiatives: 8 });
    expect(result.peopleByRole).toEqual({
      ALLOCATION_ADMIN: 1,
      ALLOCATION_MANAGER: 1,
      ALLOCATION_MODERATOR: 4,
      ALLOCATION_SUPERVISOR: 1,
      ALLOCATION_USER: 53,
    });
    expect(result.requestsByState).toMatchObject({
      WAITING_FOR_PRESENTATION: 12,
      PENDING_TEAM_DECISION: 12,
      APPROVED_WITH_CHANGES: 2,
      DENIED: 2,
      PRE_N3: 2,
      ESCALATION: 1,
      REQUIRES_REVALIDATION: 1,
      CANCELLED: 12,
    });
    expect(result.requestsByState.APPROVED).toBeGreaterThan(100);
    expect(Object.keys(result.allocationsByState)).toEqual(expect.arrayContaining(['DONE', 'IN_PROGRESS', 'NOT_STARTED']));
    expect(Object.keys(result.allocationsByOrigin).sort()).toEqual(['DIRECT', 'REQUEST', 'SELF']);
    expect(result.identities).toMatchObject({
      adminLocalUserId: 'volume-admin',
      leadershipLocalUserId: 'volume-manager-01',
      leadershipGroupNames: ['Volume Group 01', 'Volume Group 02', 'Volume Group 03', 'Volume Group 04'],
      moderatorLocalUserId: 'volume-moderator-01',
      userLocalUserId: 'volume-user-0001',
      userGroupName: 'Volume Group 01',
    });
    expect(result.presentationApprovable).toBe(12);
    expect(result.leadershipTeamDecisionApprovable).toBe(12);

    // The minimal baseline is present alongside the volume dataset.
    expect(await countRows("SELECT COUNT(*)::int AS count FROM resource_people WHERE local_user_id IN ('local-contributor', 'local-moderator', 'local-supervisor', 'local-pmo')")).toBe(4);
    expect(await countRows("SELECT COUNT(*)::int AS count FROM resource_initiatives WHERE code = 'ITDM-LOCAL-001'")).toBe(1);

    // Reported counts match independent reads.
    expect(await countRows("SELECT COUNT(*)::int AS count FROM resource_people WHERE local_user_id LIKE 'volume-%'")).toBe(result.counts.people);
    expect(await countRows('SELECT COUNT(*)::int AS count FROM resource_allocations')).toBe(result.counts.allocations);
    expect(await countRows('SELECT COUNT(*)::int AS count FROM resource_requests')).toBe(result.counts.requests);
    expect(await countRows('SELECT COUNT(*)::int AS count FROM resource_capacities')).toBe(result.counts.capacities);
    expect(await countRows('SELECT COUNT(*)::int AS count FROM resource_allocation_notifications')).toBe(result.counts.notifications);
    expect(await countRows("SELECT COUNT(*)::int AS count FROM resource_submission_lines WHERE status <> 'SUCCEEDED'")).toBe(0);

    // Leadership covers every group and members belong to exactly one active group.
    expect(await countRows(`
      SELECT COUNT(*)::int AS count FROM resource_groups AS team
      JOIN resource_people AS supervisor ON supervisor.id = team.supervisor_id
      JOIN resource_people AS manager ON manager.id = team.manager_id
      WHERE team.name LIKE 'Volume Group %' AND team.active
        AND supervisor.role = 'ALLOCATION_SUPERVISOR' AND team.id = ANY(supervisor.covered_group_ids)
        AND manager.role = 'ALLOCATION_MANAGER' AND team.id = ANY(manager.covered_group_ids)
    `)).toBe(4);
    expect(await countRows(`
      SELECT COUNT(*)::int AS count FROM resource_people
      WHERE local_user_id LIKE 'volume-%' AND (
        (role IN ('ALLOCATION_USER', 'ALLOCATION_MODERATOR') AND group_id IS NULL)
        OR (role NOT IN ('ALLOCATION_USER', 'ALLOCATION_MODERATOR') AND group_id IS NOT NULL)
        OR NOT active
      )
    `)).toBe(0);

    // Allocation rules: hours, Vacation shape, people and profiles active in the allocation group, dates and states.
    expect(await countRows(`
      SELECT COUNT(*)::int AS count FROM resource_allocations
      WHERE weekly_hours <= 0 OR weekly_hours > 40 OR weekly_hours <> round(weekly_hours, 1)
    `)).toBe(0);
    expect(await countRows(`
      SELECT COUNT(*)::int AS count FROM resource_allocations
      WHERE category = 'VACATION' AND (weekly_hours <> 40 OR resource_profile_id IS NOT NULL OR initiative_id IS NOT NULL OR comment IS NOT NULL)
    `)).toBe(0);
    expect(await countRows("SELECT COUNT(*)::int AS count FROM resource_allocations WHERE category = 'VACATION'")).toBeGreaterThan(0);
    expect(await countRows(`
      SELECT COUNT(*)::int AS count FROM resource_allocations AS allocation
      JOIN resource_people AS person ON person.id = allocation.person_id
      LEFT JOIN resource_profiles AS profile ON profile.id = allocation.resource_profile_id
      WHERE person.group_id IS DISTINCT FROM allocation.group_id OR NOT person.active
        OR person.role NOT IN ('ALLOCATION_USER', 'ALLOCATION_MODERATOR')
        OR person.classification IS DISTINCT FROM allocation.classification
        OR (allocation.resource_profile_id IS NOT NULL AND (profile.group_id <> allocation.group_id OR NOT profile.active))
    `)).toBe(0);
    expect(await countRows(`
      SELECT COUNT(*)::int AS count FROM resource_allocations
      WHERE (state = 'NOT_STARTED' AND effective_start_date <= $1::date)
         OR (state IN ('NOT_STARTED', 'IN_PROGRESS', 'SUSPENDED', 'ALLOCATED_WITHOUT_ACTION') AND effective_end_date < $1::date)
         OR (state = 'IN_PROGRESS' AND effective_start_date > $1::date)
         OR (state = 'DONE' AND effective_end_date >= $1::date)
         OR state_entered_at > clock_timestamp() OR approved_at > clock_timestamp()
    `, [today])).toBe(0);
    expect(await countRows(`
      SELECT COUNT(*)::int AS count FROM resource_allocations AS allocation
      JOIN resource_requests AS source ON source.id = allocation.source_request_id
      WHERE source.decision_state <> 'APPROVED'
        OR (source.approved_conditions->>'startDate')::date <> allocation.approved_start_date
        OR allocation.approved_start_date < (source.stage_entered_at AT TIME ZONE 'America/Sao_Paulo')::date
    `)).toBe(0);
    expect(await countRows(`
      SELECT COUNT(*)::int AS count FROM resource_requests
      WHERE received_at > clock_timestamp() OR stage_entered_at > clock_timestamp()
        OR (requested_conditions->>'startDate')::date < (received_at AT TIME ZONE 'America/Sao_Paulo')::date
    `)).toBe(0);

    // Capacity: every group, profile and internal classification has an entry in force today.
    expect(await countRows(`
      SELECT COUNT(*)::int AS count FROM resource_profiles AS profile
      JOIN resource_groups AS team ON team.id = profile.group_id AND team.name LIKE 'Volume Group %'
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_capacities AS capacity
        WHERE capacity.resource_profile_id = profile.id AND capacity.group_id = team.id
          AND capacity.classification = 'INTERNAL' AND capacity.effective_date <= $1::date AND capacity.deleted_at IS NULL
      )
    `, [today])).toBe(0);

    // The workers find nothing due: states and deadlines are coherent with the dates.
    const allocationWorker = new ResourceAllocationService(dataSource!, new ResourceAllocationAccessService(dataSource!, true));
    expect(await allocationWorker.processScheduledBatch()).toBe(0);
    expect(await new ResourceAllocationDeadlineWorker(dataSource!).processBatch()).toBe(0);
    expect(await new ResourceAllocationTeamDecisionService(dataSource!, true).expireDeniedRequests()).toBe(0);
    expect(await new ResourceAllocationProposalResponseService(dataSource!, true).processProposalDeadlineBatch()).toBe(0);
    expect(await new ResourceAllocationSubmissionWorker(dataSource!).processBatch()).toBe(0);

    const server = app!.getHttpServer();
    const presentation = await request(server)
      .get(`${api}/request-queues/presentation`)
      .set('X-PMO-Local-User-ID', 'volume-admin')
      .expect(200);
    expect(presentation.body.items).toHaveLength(12);
    expect(presentation.body.items.every((item: { availableActions: string[] }) => item.availableActions.includes('APPROVE'))).toBe(true);

    const teamDecision = await request(server)
      .get(`${api}/request-queues/team-decision`)
      .set('X-PMO-Local-User-ID', 'volume-manager-01')
      .expect(200);
    expect(teamDecision.body.items).toHaveLength(12);
    expect(teamDecision.body.items.every((item: { availableActions: string[] }) => item.availableActions.includes('APPROVE'))).toBe(true);

    const exceptions = await request(server)
      .get(`${api}/request-queues/exceptions`)
      .set('X-PMO-Local-User-ID', 'volume-admin')
      .expect(200);
    expect(exceptions.body.items).toHaveLength(3);

    const myAllocations = await request(server)
      .get(`${api}/allocations`)
      .set('X-PMO-Local-User-ID', 'volume-user-0001')
      .expect(200);
    const userId = (await dataSource!.query("SELECT id FROM resource_people WHERE local_user_id = 'volume-user-0001'"))[0].id as string;
    expect(myAllocations.body.items.length).toBeGreaterThan(0);
    expect(myAllocations.body.items.every((item: { person: { personId: string } }) => item.person.personId === userId)).toBe(true);

    const comparison = await request(server)
      .get(`${api}/capacity-comparison`)
      .set('X-PMO-Local-User-ID', 'volume-manager-01')
      .expect(200);
    const currentWeek = comparison.body.weeks[0];
    expect(comparison.body.vacationIncluded).toBe(true);
    expect(currentWeek.groups).toHaveLength(4);
    expect(currentWeek.total.plannedHours).toBeGreaterThan(0);
    expect(currentWeek.total.capacityHours).toBeGreaterThan(0);
    expect(currentWeek.groups.reduce((sum: number, group: { vacationHours: number }) => sum + group.vacationHours, 0)).toBeGreaterThan(0);

    // A measurement runner can approve from both queues with the printed identities.
    const approveFirst = async (localUserId: string, item: { id: string; version: number; requestedConditions: { groupId: string } }) => {
      const candidate = (await dataSource!.query(
        "SELECT id FROM resource_people WHERE group_id = $1::uuid AND role = 'ALLOCATION_USER' ORDER BY local_user_id LIMIT 1",
        [item.requestedConditions.groupId],
      ))[0].id as string;
      return request(server)
        .post(`${api}/requests/${item.id}/approvals`)
        .set({
          'X-PMO-Local-User-ID': localUserId,
          'If-Match': `"${item.version}"`,
          'Idempotency-Key': randomUUID(),
          'X-Correlation-ID': randomUUID(),
        })
        .send({ personId: candidate })
        .expect(200);
    };
    const adminApproval = await approveFirst('volume-admin', presentation.body.items[0]);
    expect(adminApproval.body).toMatchObject({ decisionState: 'APPROVED', allocation: { state: 'NOT_STARTED' } });
    const leadershipApproval = await approveFirst('volume-manager-01', teamDecision.body.items[0]);
    expect(leadershipApproval.body).toMatchObject({ decisionState: 'APPROVED', allocation: { state: 'NOT_STARTED' } });
  });

  it('is deterministic for a seed and changes with another seed', async () => {
    const first = await prepareVolumeData(dataSource!, reducedVolume);
    const firstFingerprint = await volumeFingerprint();

    await dataSource!.query("TRUNCATE TABLE resource_capacity_history, resource_capacities, resource_allocation_notifications, resource_allocation_history, resource_allocations, resource_request_history, resource_requests, resource_submission_entries, resource_submission_lines, resource_submissions, resource_profiles, resource_initiatives, resource_groups, resource_people RESTART IDENTITY CASCADE");
    const second = await prepareVolumeData(dataSource!, reducedVolume);
    expect(await volumeFingerprint()).toBe(firstFingerprint);
    expect(second.counts).toEqual(first.counts);
    expect(second.requestsByState).toEqual(first.requestsByState);
    expect(second.allocationsByState).toEqual(first.allocationsByState);

    await dataSource!.query("TRUNCATE TABLE resource_capacity_history, resource_capacities, resource_allocation_notifications, resource_allocation_history, resource_allocations, resource_request_history, resource_requests, resource_submission_entries, resource_submission_lines, resource_submissions, resource_profiles, resource_initiatives, resource_groups, resource_people RESTART IDENTITY CASCADE");
    await prepareVolumeData(dataSource!, { ...reducedVolume, seed: 'another-volume' });
    expect(await volumeFingerprint()).not.toBe(firstFingerprint);
  });

  it('refuses to run again over an existing volume dataset without duplicating records', async () => {
    const [left, right] = await Promise.allSettled([
      prepareVolumeData(dataSource!, reducedVolume),
      prepareVolumeData(dataSource!, reducedVolume),
    ]);
    const outcomes = [left, right];
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(VolumeDataAlreadyPreparedError);

    const fingerprint = await volumeFingerprint();
    await expect(prepareVolumeData(dataSource!, { ...reducedVolume, seed: 'different-seed' })).rejects.toBeInstanceOf(VolumeDataAlreadyPreparedError);
    expect(await volumeFingerprint()).toBe(fingerprint);
  });

  it('prints the generated counts and identities from the command and exits with an error on a second run', async () => {
    const cliEnv = {
      ...process.env,
      RESOURCE_ALLOCATION_DATABASE_URL: container!.getConnectionUri(),
      RESOURCE_ALLOCATION_VOLUME_PEOPLE: '30',
      RESOURCE_ALLOCATION_VOLUME_GROUPS: '2',
      RESOURCE_ALLOCATION_VOLUME_MONTHS: '2',
      RESOURCE_ALLOCATION_VOLUME_SEED: 'cli-volume',
    };
    const first = await runNpmScript('prepare:volume', cliEnv);
    expect(first.stdout).toContain('Prepared Tech Resource Allocation volume dataset (seed: cli-volume, people: 30, groups: 2, months: 2');
    expect(first.stdout).toMatch(/Records: people 30, groups 2, profiles 6, initiatives 4, capacities \d+, submissions \d+, requests \d+/);
    expect(first.stdout).toContain('Measurement identities: Admin volume-admin (6 requests in the presentation queue); leadership volume-manager-01');
    const summaryLine = first.stdout.split('\n').find((line) => line.startsWith('VOLUME_DATASET_SUMMARY '));
    const summary = JSON.parse(summaryLine!.slice('VOLUME_DATASET_SUMMARY '.length));
    expect(summary.counts.people).toBe(30);
    expect(await countRows('SELECT COUNT(*)::int AS count FROM resource_allocations')).toBe(summary.counts.allocations);

    await expect(runNpmScript('prepare:volume', cliEnv)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('volume dataset already exists'),
    });
    expect(await countRows('SELECT COUNT(*)::int AS count FROM resource_allocations')).toBe(summary.counts.allocations);
  });
});
