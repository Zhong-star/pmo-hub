import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createResourceAllocationDataSourceOptions } from '../src/database/database-options';
import {
  ResourceAllocationWorkerOperationMonitor,
  readResourceAllocationWorkerStatus,
} from '../src/workers/resource-allocation-worker-health';

describe('Resource Allocation worker operational status (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('resource_allocation_worker_status_test')
      .withUsername('resource_allocation_test')
      .withPassword('test_only_password')
      .start();
    dataSource = new DataSource(createResourceAllocationDataSourceOptions(container.getConnectionUri()));
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 120_000);

  afterAll(async () => {
    try {
      if (dataSource?.isInitialized) await dataSource.destroy();
    } finally {
      await container?.stop();
    }
  }, 120_000);

  beforeEach(async () => {
    await dataSource!.query('TRUNCATE TABLE resource_people RESTART IDENTITY CASCADE');
  });

  it('persists safe operation errors and reports the real due submission backlog and retries', async () => {
    const people = await dataSource!.query(`
      INSERT INTO resource_people (local_user_id, display_name, email, role)
      VALUES ('worker-status-admin', 'Worker Status Admin', 'worker-status@example.test', 'ALLOCATION_ADMIN')
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    const requesterId = people[0].id;
    const submissionId = randomUUID();
    await dataSource!.query(`
      INSERT INTO resource_submissions (id, requester_id, category, line_count, correlation_id)
      VALUES ($1, $2, 'EXECUTION_PROJECT', 1, $3)
    `, [submissionId, requesterId, randomUUID()]);
    await dataSource!.query(`
      INSERT INTO resource_submission_lines (
        submission_id, requester_id, attempt_key, attempt_payload_hash, line_number,
        submitted_conditions, status, received_at, processing_attempts
      ) VALUES ($1, $2, $3, repeat('a', 64), 0, '{}'::jsonb, 'RECEIVED', clock_timestamp() - INTERVAL '90 seconds', 2)
    `, [submissionId, requesterId, randomUUID()]);

    const monitor = new ResourceAllocationWorkerOperationMonitor(dataSource!);
    await monitor.onStarted('submission');
    await monitor.onSucceeded('submission', 1);
    await monitor.onStarted('waiting deadline');
    const unsafeFailure = Object.assign(new Error('password=must-not-be-stored'), { name: 'DatabaseTimeout' });
    await monitor.onFailed('waiting deadline', unsafeFailure);

    const status = await readResourceAllocationWorkerStatus(dataSource!);
    const submission = status.operations.find(({ name }) => name === 'submission');
    const waiting = status.operations.find(({ name }) => name === 'waiting deadline');

    expect(status.status).toBe('error');
    expect(submission).toMatchObject({ status: 'late', errorCount: 0, dueCount: 1, retryCount: 1 });
    expect(submission?.lastSuccessfulCycleAt).toBeTruthy();
    expect(submission?.oldestDueAgeSeconds).toBeGreaterThanOrEqual(90);
    expect(waiting).toMatchObject({ status: 'error', errorCount: 1, lastError: 'DatabaseTimeout' });
    const storedError = await dataSource!.query(`
      SELECT last_error_code FROM resource_allocation_worker_operations WHERE operation_name = 'waiting deadline'
    `) as Array<{ last_error_code: string }>;
    expect(storedError[0].last_error_code).toBe('DatabaseTimeout');
    expect(JSON.stringify(status)).not.toContain('password');

    await dataSource!.query(`
      UPDATE resource_allocation_worker_operations
      SET last_successful_cycle_at = clock_timestamp() - INTERVAL '61 seconds'
      WHERE operation_name = 'submission'
    `);
    await dataSource!.query(`
      UPDATE resource_allocation_worker_operations
      SET consecutive_error_count = 0
      WHERE operation_name = 'waiting deadline'
    `);
    const staleStatus = await readResourceAllocationWorkerStatus(dataSource!);
    expect(staleStatus.operations.find(({ name }) => name === 'submission')?.status).toBe('late');
  });

  it('uses the current Waiting, Denied, proposal reminder, and São Paulo lifecycle work predicates', async () => {
    const people = await dataSource!.query(`
      INSERT INTO resource_people (local_user_id, display_name, email, role)
      VALUES ('worker-predicate-admin', 'Worker Predicate Admin', 'worker-predicate@example.test', 'ALLOCATION_ADMIN')
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    const requesterId = people[0].id;

    async function createRequest(decisionState: string, receivedAge: string, expirationOffset: string, responseOffset?: string) {
      const submissionId = randomUUID();
      await dataSource!.query(`
        INSERT INTO resource_submissions (id, requester_id, category, line_count, correlation_id)
        VALUES ($1, $2, 'EXECUTION_PROJECT', 1, $3)
      `, [submissionId, requesterId, randomUUID()]);
      const lineRows = await dataSource!.query(`
        INSERT INTO resource_submission_lines (
          submission_id, requester_id, attempt_key, attempt_payload_hash, line_number, submitted_conditions
        ) VALUES ($1, $2, $3, repeat('b', 64), 0, '{}'::jsonb)
        RETURNING id::text AS id
      `, [submissionId, requesterId, randomUUID()]) as Array<{ id: string }>;
      const requestRows = await dataSource!.query(`
        INSERT INTO resource_requests (
          submission_line_id, requester_id, requester_snapshot, requested_conditions,
          decision_state, received_at, stage_entered_at, expiration_due_at, decision_response_due_at
        ) VALUES (
          $1, $2, '{}'::jsonb, '{}'::jsonb, $3,
          clock_timestamp() - $4::interval, clock_timestamp() - $4::interval,
          clock_timestamp() + $5::interval,
          clock_timestamp() + $6::interval
        ) RETURNING id::text AS id
      `, [lineRows[0].id, requesterId, decisionState, receivedAge, expirationOffset, responseOffset ?? null]) as Array<{ id: string }>;
      await dataSource!.query(`
        UPDATE resource_submission_lines
        SET status = 'SUCCEEDED', request_id = $2, request_outcome = '{}'::jsonb, completed_at = clock_timestamp()
        WHERE id = $1
      `, [lineRows[0].id, requestRows[0].id]);
      return requestRows[0].id;
    }

    await createRequest('WAITING_FOR_PRESENTATION', '8 days', '13 days');
    await createRequest('DENIED', '15 days', '-5 minutes');
    const approvedRequestId = await createRequest('APPROVED', '1 day', '20 days');
    await createRequest('APPROVED_WITH_CHANGES', '2 days', '20 days', '12 hours');

    const groups = await dataSource!.query(`
      INSERT INTO resource_groups (name, supervisor_id, manager_id)
      VALUES ('Worker Status Group', $1, $1)
      RETURNING id::text AS id
    `, [requesterId]) as Array<{ id: string }>;
    const groupId = groups[0].id;
    const profiles = await dataSource!.query(`
      INSERT INTO resource_profiles (name, group_id) VALUES ('Worker Status Profile', $1)
      RETURNING id::text AS id
    `, [groupId]) as Array<{ id: string }>;
    const initiatives = await dataSource!.query(`
      INSERT INTO resource_initiatives (code, name) VALUES ('ITDM-WORKER', 'Worker Status Initiative')
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    await dataSource!.query(`
      WITH operation_clock AS (
        SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS today
      )
      INSERT INTO resource_allocations (
        source_request_id, person_id, person_snapshot, group_id, group_snapshot,
        initiative_id, initiative_snapshot, resource_profile_id, resource_profile_snapshot,
        approved_start_date, approved_end_date, effective_start_date, effective_end_date,
        weekly_hours, state, state_entered_at, approved_at
      )
      SELECT $1, $2, '{}'::jsonb, $3, '{}'::jsonb, $4, '{}'::jsonb, $5, '{}'::jsonb,
        operation_clock.today, operation_clock.today + 7, operation_clock.today, operation_clock.today + 7,
        4, 'NOT_STARTED', clock_timestamp(), clock_timestamp()
      FROM operation_clock
    `, [approvedRequestId, requesterId, groupId, initiatives[0].id, profiles[0].id]);

    const status = await readResourceAllocationWorkerStatus(dataSource!);
    expect(status.operations.find(({ name }) => name === 'waiting deadline')).toMatchObject({ dueCount: 1, retryCount: 1 });
    expect(status.operations.find(({ name }) => name === 'denied response deadline')).toMatchObject({ dueCount: 1, retryCount: 1 });
    expect(status.operations.find(({ name }) => name === 'changed proposal deadline')).toMatchObject({ dueCount: 1, retryCount: 1 });
    expect(status.operations.find(({ name }) => name === 'allocation lifecycle')).toMatchObject({ dueCount: 1, retryCount: 1 });
  });
});
