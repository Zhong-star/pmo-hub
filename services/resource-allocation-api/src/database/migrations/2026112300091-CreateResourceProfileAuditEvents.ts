import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateResourceProfileAuditEvents2026112300091 implements MigrationInterface {
  name = 'CreateResourceProfileAuditEvents2026112300091';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE resource_profile_audit_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id UUID NOT NULL REFERENCES resource_profiles(id) ON DELETE RESTRICT,
        actor_id UUID NOT NULL REFERENCES resource_people(id) ON DELETE RESTRICT,
        action VARCHAR(80) NOT NULL,
        before_snapshot JSONB,
        after_snapshot JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await queryRunner.query('CREATE INDEX resource_profile_audit_events_order_idx ON resource_profile_audit_events (profile_id, occurred_at, id)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX resource_profile_audit_events_order_idx');
    await queryRunner.query('DROP TABLE resource_profile_audit_events');
  }
}
