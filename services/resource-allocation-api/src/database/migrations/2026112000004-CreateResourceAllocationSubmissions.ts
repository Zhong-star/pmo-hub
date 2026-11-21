import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateResourceAllocationSubmissions2026112000004 implements MigrationInterface {
  name = 'CreateResourceAllocationSubmissions2026112000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE resource_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        requester_id UUID NOT NULL REFERENCES resource_people(id) ON DELETE RESTRICT,
        category VARCHAR(40) NOT NULL CHECK (category IN (
          'DEMAND_ANALYSIS', 'POC_BBP', 'EXECUTION_PROJECT', 'EXECUTION_FAST_TRACK', 'EXECUTION_ENHANCEMENT'
        )),
        line_count INTEGER NOT NULL CHECK (line_count BETWEEN 1 AND 100),
        correlation_id UUID NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE resource_submission_lines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        submission_id UUID NOT NULL REFERENCES resource_submissions(id) ON DELETE RESTRICT,
        requester_id UUID NOT NULL REFERENCES resource_people(id) ON DELETE RESTRICT,
        attempt_key UUID NOT NULL,
        attempt_payload_hash CHAR(64) NOT NULL CHECK (attempt_payload_hash ~ '^[0-9a-f]{64}$'),
        line_number INTEGER NOT NULL CHECK (line_number BETWEEN 0 AND 99),
        submitted_conditions JSONB NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED'
          CHECK (status IN ('RECEIVED', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
        request_id UUID,
        problem JSONB,
        request_outcome JSONB,
        claim_token UUID,
        claimed_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        completed_at TIMESTAMPTZ,
        CONSTRAINT resource_submission_lines_requester_attempt_uq UNIQUE (requester_id, attempt_key),
        CONSTRAINT resource_submission_lines_submission_number_uq UNIQUE (submission_id, line_number),
        CONSTRAINT resource_submission_lines_result_shape CHECK (
          (status = 'SUCCEEDED' AND request_id IS NOT NULL AND completed_at IS NOT NULL AND problem IS NULL)
          OR (status = 'FAILED' AND request_id IS NULL AND completed_at IS NOT NULL AND problem IS NOT NULL)
          OR (status IN ('RECEIVED', 'PROCESSING') AND request_id IS NULL AND completed_at IS NULL AND problem IS NULL)
        )
      )
    `);
    await queryRunner.query('CREATE INDEX resource_submission_lines_work_idx ON resource_submission_lines (received_at, id) WHERE status IN (\'RECEIVED\', \'PROCESSING\')');
    await queryRunner.query('CREATE INDEX resource_submission_lines_requester_received_idx ON resource_submission_lines (requester_id, received_at DESC, id DESC)');
    await queryRunner.query('CREATE INDEX resource_submissions_requester_received_idx ON resource_submissions (requester_id, received_at DESC, id DESC)');
    await queryRunner.query(`
      CREATE TABLE resource_submission_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        submission_id UUID NOT NULL REFERENCES resource_submissions(id) ON DELETE RESTRICT,
        line_id UUID NOT NULL REFERENCES resource_submission_lines(id) ON DELETE RESTRICT,
        line_number INTEGER NOT NULL CHECK (line_number BETWEEN 0 AND 99),
        CONSTRAINT resource_submission_entries_submission_number_uq UNIQUE (submission_id, line_number),
        CONSTRAINT resource_submission_entries_submission_line_uq UNIQUE (submission_id, line_id)
      )
    `);
    await queryRunner.query('CREATE INDEX resource_submission_entries_line_idx ON resource_submission_entries (line_id)');
    await queryRunner.query(`
      CREATE TABLE resource_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        submission_line_id UUID NOT NULL UNIQUE REFERENCES resource_submission_lines(id) ON DELETE RESTRICT,
        requester_id UUID NOT NULL REFERENCES resource_people(id) ON DELETE RESTRICT,
        requester_snapshot JSONB NOT NULL,
        requested_conditions JSONB NOT NULL,
        decision_state VARCHAR(40) NOT NULL CHECK (decision_state IN (
          'WAITING_FOR_PRESENTATION', 'PENDING_TEAM_DECISION', 'APPROVED_WITH_CHANGES', 'APPROVED',
          'DENIED', 'PRE_N3', 'ESCALATION', 'REQUIRES_REVALIDATION', 'CANCELLED'
        )),
        received_at TIMESTAMPTZ NOT NULL,
        stage_entered_at TIMESTAMPTZ NOT NULL,
        expiration_due_at TIMESTAMPTZ NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE resource_submission_lines
      ADD CONSTRAINT resource_submission_lines_request_fk
      FOREIGN KEY (request_id) REFERENCES resource_requests(id) ON DELETE RESTRICT
    `);
    await queryRunner.query('CREATE INDEX resource_requests_requester_received_idx ON resource_requests (requester_id, received_at DESC, id DESC)');
    await queryRunner.query(`
      CREATE TABLE resource_request_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID NOT NULL REFERENCES resource_requests(id) ON DELETE RESTRICT,
        actor_snapshot JSONB NOT NULL,
        action VARCHAR(80) NOT NULL,
        after_snapshot JSONB NOT NULL,
        correlation_id UUID NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await queryRunner.query('CREATE INDEX resource_request_history_order_idx ON resource_request_history (request_id, occurred_at, id)');
    await queryRunner.query(`
      CREATE TABLE resource_allocation_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_id UUID NOT NULL REFERENCES resource_people(id) ON DELETE RESTRICT,
        source_request_id UUID NOT NULL REFERENCES resource_requests(id) ON DELETE RESTRICT,
        event_code VARCHAR(80) NOT NULL,
        title VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT resource_allocation_notifications_recipient_event_request_uq
          UNIQUE (recipient_id, event_code, source_request_id)
      )
    `);
    await queryRunner.query('CREATE INDEX resource_allocation_notifications_recipient_created_idx ON resource_allocation_notifications (recipient_id, created_at DESC, id DESC)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE resource_allocation_notifications');
    await queryRunner.query('DROP TABLE resource_request_history');
    await queryRunner.query('ALTER TABLE resource_submission_lines DROP CONSTRAINT resource_submission_lines_request_fk');
    await queryRunner.query('DROP TABLE resource_requests');
    await queryRunner.query('DROP TABLE resource_submission_entries');
    await queryRunner.query('DROP TABLE resource_submission_lines');
    await queryRunner.query('DROP TABLE resource_submissions');
  }
}
