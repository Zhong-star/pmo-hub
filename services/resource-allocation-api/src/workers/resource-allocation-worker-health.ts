import type { DataSource } from 'typeorm';

export const RESOURCE_ALLOCATION_WORKER_STALE_AFTER_MS = 60_000;
export const RESOURCE_ALLOCATION_WORKER_OPERATIONS = [
  'submission',
  'waiting deadline',
  'denied response deadline',
  'changed proposal deadline',
  'allocation lifecycle',
] as const;

export type ResourceAllocationWorkerOperation = typeof RESOURCE_ALLOCATION_WORKER_OPERATIONS[number];
export type ResourceAllocationWorkerOperationStatus = 'healthy' | 'late' | 'error' | 'unknown';

interface WorkerOperationStatusRow {
  operation_name: ResourceAllocationWorkerOperation;
  last_started_at: Date | string | null;
  last_successful_cycle_at: Date | string | null;
  last_error_at: Date | string | null;
  error_count: number | string;
  consecutive_error_count: number | string;
  last_error_code: string | null;
  is_running: boolean;
  due_count: number | string;
  oldest_due_at: Date | string | null;
  retry_count: number | string;
  checked_at: Date | string;
}

export interface ResourceAllocationWorkerOperationStatusSummary {
  name: ResourceAllocationWorkerOperation;
  status: ResourceAllocationWorkerOperationStatus;
  lastSuccessfulCycleAt: string | null;
  lastStartedAt: string | null;
  lastErrorAt: string | null;
  errorCount: number;
  lastError: string | null;
  dueCount: number;
  oldestDueAt: string | null;
  oldestDueAgeSeconds: number | null;
  retryCount: number;
}

export interface ResourceAllocationWorkerStatus {
  service: 'resource-allocation-worker';
  status: Exclude<ResourceAllocationWorkerOperationStatus, 'unknown'> | 'unknown';
  checkedAt: string;
  staleAfterSeconds: 60;
  operations: ResourceAllocationWorkerOperationStatusSummary[];
}

export class ResourceAllocationWorkerOperationMonitor {
  constructor(private readonly dataSource: DataSource) {}

  async onStarted(jobName: string): Promise<void> {
    await this.dataSource.query(`
      INSERT INTO resource_allocation_worker_operations (operation_name, last_started_at, is_running)
      VALUES ($1, clock_timestamp(), TRUE)
      ON CONFLICT (operation_name) DO UPDATE
      SET last_started_at = clock_timestamp(), is_running = TRUE, updated_at = clock_timestamp()
    `, [jobName]);
  }

  async onSucceeded(jobName: string, processedCount: number): Promise<void> {
    await this.dataSource.query(`
      UPDATE resource_allocation_worker_operations
      SET last_successful_cycle_at = clock_timestamp(),
          successful_cycle_count = successful_cycle_count + 1,
          last_processed_count = $2,
          consecutive_error_count = 0,
          is_running = FALSE,
          updated_at = clock_timestamp()
      WHERE operation_name = $1
    `, [jobName, Math.max(0, Math.trunc(processedCount))]);
  }

  async onFailed(jobName: string, error: unknown): Promise<void> {
    await this.dataSource.query(`
      UPDATE resource_allocation_worker_operations
      SET error_count = error_count + 1,
          consecutive_error_count = consecutive_error_count + 1,
          last_error_at = clock_timestamp(),
          last_error_code = $2,
          is_running = FALSE,
          updated_at = clock_timestamp()
      WHERE operation_name = $1
    `, [jobName, safeWorkerErrorCode(error)]);
  }
}

export async function readResourceAllocationWorkerStatus(dataSource: DataSource): Promise<ResourceAllocationWorkerStatus> {
  const rows = await dataSource.query(WORKER_OPERATION_STATUS_SQL) as WorkerOperationStatusRow[];
  const operations = rows.map(toOperationStatus);
  const status = aggregateWorkerOperationStatus(operations.map((operation) => operation.status));
  const checkedAt = asIso(rows[0]?.checked_at ?? new Date());
  return {
    service: 'resource-allocation-worker',
    status,
    checkedAt,
    staleAfterSeconds: 60,
    operations,
  };
}

export function safeWorkerErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'UnknownError';
}

function toOperationStatus(row: WorkerOperationStatusRow): ResourceAllocationWorkerOperationStatusSummary {
  const checkedAt = new Date(row.checked_at).getTime();
  const lastSuccess = row.last_successful_cycle_at ? new Date(row.last_successful_cycle_at).getTime() : null;
  const lastStarted = row.last_started_at ? new Date(row.last_started_at).getTime() : null;
  const consecutiveErrors = Number(row.consecutive_error_count);
  const dueCount = Number(row.due_count);
  const oldestDueAt = row.oldest_due_at ? asIso(row.oldest_due_at) : null;
  const oldestDueAgeSeconds = oldestDueAt === null
    ? null
    : Math.max(0, Math.floor((checkedAt - new Date(oldestDueAt).getTime()) / 1000));
  let status: ResourceAllocationWorkerOperationStatus;
  if (consecutiveErrors > 0) status = 'error';
  else if (lastSuccess === null) status = 'unknown';
  else if (
    checkedAt - lastSuccess > RESOURCE_ALLOCATION_WORKER_STALE_AFTER_MS ||
    (oldestDueAgeSeconds !== null && oldestDueAgeSeconds > RESOURCE_ALLOCATION_WORKER_STALE_AFTER_MS / 1000) ||
    (row.is_running === true && lastStarted !== null && checkedAt - lastStarted > RESOURCE_ALLOCATION_WORKER_STALE_AFTER_MS)
  ) status = 'late';
  else status = 'healthy';

  return {
    name: row.operation_name,
    status,
    lastSuccessfulCycleAt: row.last_successful_cycle_at ? asIso(row.last_successful_cycle_at) : null,
    lastStartedAt: row.last_started_at ? asIso(row.last_started_at) : null,
    lastErrorAt: row.last_error_at ? asIso(row.last_error_at) : null,
    errorCount: Number(row.error_count),
    lastError: row.last_error_code,
    dueCount,
    oldestDueAt,
    oldestDueAgeSeconds,
    retryCount: Number(row.retry_count),
  };
}

function aggregateWorkerOperationStatus(statuses: ResourceAllocationWorkerOperationStatus[]): ResourceAllocationWorkerStatus['status'] {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('late')) return 'late';
  if (statuses.includes('unknown')) return 'unknown';
  return 'healthy';
}

function asIso(value: Date | string): string {
  return new Date(value).toISOString();
}

const WORKER_OPERATION_STATUS_SQL = `
  WITH operation_clock AS MATERIALIZED (
    SELECT source.now,
      (source.now AT TIME ZONE 'America/Sao_Paulo')::date AS business_date
    FROM (SELECT clock_timestamp() AS now) AS source
  ),
  operation_names(operation_name) AS (
    VALUES ('submission'), ('waiting deadline'), ('denied response deadline'),
      ('changed proposal deadline'), ('allocation lifecycle')
  ),
  due_work AS (
    SELECT 'submission'::varchar AS operation_name,
      line.id,
      CASE WHEN line.status = 'PROCESSING' THEN line.claimed_at + INTERVAL '1 minute' ELSE line.received_at END AS due_at,
      CASE WHEN line.processing_attempts > 1 THEN 1 ELSE 0 END AS retry_count
    FROM resource_submission_lines AS line CROSS JOIN operation_clock AS clock
    WHERE line.status = 'RECEIVED'
      OR (line.status = 'PROCESSING' AND line.claimed_at < clock.now - INTERVAL '1 minute')

    UNION ALL

    SELECT 'waiting deadline', request.id, due.due_at,
      CASE WHEN due.due_at <= clock.now - INTERVAL '10 seconds' THEN 1 ELSE 0 END
    FROM resource_requests AS request CROSS JOIN operation_clock AS clock
    CROSS JOIN LATERAL (
      SELECT CASE WHEN request.expiration_due_at < clock.now THEN request.expiration_due_at
        WHEN request.received_at <= clock.now - INTERVAL '336 hours' THEN request.received_at + INTERVAL '336 hours'
        ELSE request.received_at + INTERVAL '168 hours'
      END AS due_at
    ) AS due
    WHERE request.decision_state = 'WAITING_FOR_PRESENTATION' AND request.removed_at IS NULL
      AND (
        request.expiration_due_at < clock.now
        OR (request.received_at <= clock.now - INTERVAL '336 hours' AND NOT EXISTS (
          SELECT 1 FROM resource_allocation_notifications AS notice WHERE notice.source_request_id = request.id AND notice.event_code = 'REQUEST_WAITING_REMINDER_14D'
        ))
        OR (
          request.received_at > clock.now - INTERVAL '336 hours'
          AND request.received_at <= clock.now - INTERVAL '168 hours'
          AND NOT EXISTS (
            SELECT 1 FROM resource_allocation_notifications AS notice WHERE notice.source_request_id = request.id AND notice.event_code = 'REQUEST_WAITING_REMINDER_7D'
          )
        )
      )

    UNION ALL

    SELECT 'denied response deadline', request.id, request.expiration_due_at,
      CASE WHEN request.expiration_due_at <= clock.now - INTERVAL '10 seconds' THEN 1 ELSE 0 END
    FROM resource_requests AS request CROSS JOIN operation_clock AS clock
    WHERE request.decision_state = 'DENIED' AND request.removed_at IS NULL AND request.expiration_due_at < clock.now

    UNION ALL

    SELECT 'changed proposal deadline', request.id,
      CASE WHEN request.decision_response_due_at <= clock.now THEN request.decision_response_due_at
        ELSE request.decision_response_due_at - INTERVAL '24 hours' END,
      CASE WHEN (CASE WHEN request.decision_response_due_at <= clock.now THEN request.decision_response_due_at
        ELSE request.decision_response_due_at - INTERVAL '24 hours' END) <= clock.now - INTERVAL '10 seconds'
        THEN 1 ELSE 0 END
    FROM resource_requests AS request CROSS JOIN operation_clock AS clock
    WHERE request.decision_state = 'APPROVED_WITH_CHANGES' AND request.removed_at IS NULL
      AND request.decision_response_due_at IS NOT NULL
      AND (
        request.decision_response_due_at <= clock.now
        OR (request.decision_response_due_at <= clock.now + INTERVAL '24 hours' AND NOT EXISTS (
          SELECT 1 FROM resource_allocation_notifications AS notice
          WHERE notice.source_request_id = request.id AND notice.event_code = 'REQUEST_CHANGES_REMINDER_48H_' || request.version::text
        ))
      )

    UNION ALL

    SELECT 'allocation lifecycle', allocation.id,
      CASE WHEN allocation.state = 'NOT_STARTED' AND allocation.effective_start_date <= clock.business_date
        THEN allocation.effective_start_date::timestamp AT TIME ZONE 'America/Sao_Paulo'
        ELSE (allocation.effective_end_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo' END,
      CASE WHEN (
        CASE WHEN allocation.state = 'NOT_STARTED' AND allocation.effective_start_date <= clock.business_date
          THEN allocation.effective_start_date::timestamp AT TIME ZONE 'America/Sao_Paulo'
          ELSE (allocation.effective_end_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
        END
      ) <= clock.now - INTERVAL '10 seconds' THEN 1 ELSE 0 END
    FROM resource_allocations AS allocation CROSS JOIN operation_clock AS clock
    WHERE allocation.state NOT IN ('DONE', 'CANCELED')
      AND (
        (allocation.state = 'NOT_STARTED' AND allocation.effective_start_date <= clock.business_date)
        OR allocation.effective_end_date < clock.business_date
      )
  ),
  due_summary AS (
    SELECT operation_name, COUNT(*)::int AS due_count, MIN(due_at) AS oldest_due_at, SUM(retry_count)::int AS retry_count
    FROM due_work GROUP BY operation_name
  )
  SELECT names.operation_name,
    operations.last_started_at,
    operations.last_successful_cycle_at,
    operations.last_error_at,
    COALESCE(operations.error_count, 0)::int AS error_count,
    COALESCE(operations.consecutive_error_count, 0)::int AS consecutive_error_count,
    operations.last_error_code,
    COALESCE(operations.is_running, FALSE) AS is_running,
    COALESCE(operations.last_processed_count, 0)::int AS last_processed_count,
    COALESCE(due_summary.due_count, 0)::int AS due_count,
    due_summary.oldest_due_at,
    COALESCE(due_summary.retry_count, 0)::int AS retry_count,
    clock.now AS checked_at
  FROM operation_names AS names
  CROSS JOIN operation_clock AS clock
  LEFT JOIN resource_allocation_worker_operations AS operations ON operations.operation_name = names.operation_name
  LEFT JOIN due_summary ON due_summary.operation_name = names.operation_name
  ORDER BY names.operation_name
`;
