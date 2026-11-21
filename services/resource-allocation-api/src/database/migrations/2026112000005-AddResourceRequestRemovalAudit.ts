import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResourceRequestRemovalAudit2026112000005 implements MigrationInterface {
  name = 'AddResourceRequestRemovalAudit2026112000005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE resource_requests ADD COLUMN removed_at TIMESTAMPTZ');
    await queryRunner.query('CREATE INDEX resource_requests_requester_active_idx ON resource_requests (requester_id, received_at DESC, id DESC) WHERE removed_at IS NULL');
    await queryRunner.query(`
      CREATE TABLE resource_request_audits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID NOT NULL UNIQUE REFERENCES resource_requests(id) ON DELETE RESTRICT,
        action VARCHAR(40) NOT NULL CHECK (action IN ('WITHDRAWN', 'ADMIN_REMOVED', 'EXPIRED')),
        requester_snapshot JSONB NOT NULL,
        actor_snapshot JSONB NOT NULL,
        request_snapshot JSONB NOT NULL,
        reason VARCHAR(2000) NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
        correlation_id UUID NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await queryRunner.query('CREATE INDEX resource_request_audits_order_idx ON resource_request_audits (request_id, occurred_at, id)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE resource_request_audits');
    await queryRunner.query('DROP INDEX resource_requests_requester_active_idx');
    await queryRunner.query('ALTER TABLE resource_requests DROP COLUMN removed_at');
  }
}
