import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResourceAllocationWorkerOperations2026112100001 implements MigrationInterface {
  name = 'AddResourceAllocationWorkerOperations2026112100001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE resource_submission_lines
      ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0,
      ADD CONSTRAINT resource_submission_lines_processing_attempts_ck CHECK (processing_attempts >= 0)
    `);
    await queryRunner.query(`
      CREATE TABLE resource_allocation_worker_operations (
        operation_name VARCHAR(60) PRIMARY KEY,
        last_started_at TIMESTAMPTZ,
        last_successful_cycle_at TIMESTAMPTZ,
        last_error_at TIMESTAMPTZ,
        error_count INTEGER NOT NULL DEFAULT 0,
        consecutive_error_count INTEGER NOT NULL DEFAULT 0,
        successful_cycle_count INTEGER NOT NULL DEFAULT 0,
        last_processed_count INTEGER NOT NULL DEFAULT 0,
        last_error_code VARCHAR(64),
        is_running BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT resource_allocation_worker_operations_name_ck CHECK (
          operation_name IN ('submission', 'waiting deadline', 'denied response deadline', 'changed proposal deadline', 'allocation lifecycle')
        ),
        CONSTRAINT resource_allocation_worker_operations_counts_ck CHECK (
          error_count >= 0 AND consecutive_error_count >= 0 AND successful_cycle_count >= 0 AND last_processed_count >= 0
        )
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE resource_allocation_worker_operations');
    await queryRunner.query('ALTER TABLE resource_submission_lines DROP CONSTRAINT resource_submission_lines_processing_attempts_ck');
    await queryRunner.query('ALTER TABLE resource_submission_lines DROP COLUMN processing_attempts');
  }
}
