import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateResourceAllocationHistory2026112000012 implements MigrationInterface {
  name = 'CreateResourceAllocationHistory2026112000012';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE resource_allocation_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        allocation_id UUID NOT NULL REFERENCES resource_allocations(id) ON DELETE RESTRICT,
        actor_snapshot JSONB NOT NULL,
        action VARCHAR(80) NOT NULL,
        reason TEXT,
        before_snapshot JSONB NOT NULL,
        after_snapshot JSONB NOT NULL,
        correlation_id UUID NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await queryRunner.query('CREATE INDEX resource_allocation_history_order_idx ON resource_allocation_history (allocation_id, occurred_at, id)');
    await queryRunner.query("CREATE INDEX resource_allocations_active_end_idx ON resource_allocations (effective_end_date, id) WHERE state NOT IN ('DONE', 'CANCELED')");
    await queryRunner.query("CREATE INDEX resource_allocations_not_started_start_idx ON resource_allocations (effective_start_date, id) WHERE state = 'NOT_STARTED'");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX resource_allocations_not_started_start_idx');
    await queryRunner.query('DROP INDEX resource_allocations_active_end_idx');
    await queryRunner.query('DROP INDEX resource_allocation_history_order_idx');
    await queryRunner.query('DROP TABLE resource_allocation_history');
  }
}
