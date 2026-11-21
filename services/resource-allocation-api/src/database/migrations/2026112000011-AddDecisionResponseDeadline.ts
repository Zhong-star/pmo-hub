import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDecisionResponseDeadline2026112000011 implements MigrationInterface {
  name = 'AddDecisionResponseDeadline2026112000011';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE resource_requests ADD COLUMN decision_response_due_at TIMESTAMPTZ');
    await queryRunner.query(`
      ALTER TABLE resource_requests
      ADD CONSTRAINT resource_requests_decision_response_due_state_ck
      CHECK ((decision_state = 'APPROVED_WITH_CHANGES') = (decision_response_due_at IS NOT NULL))
    `);
    await queryRunner.query(`
      CREATE INDEX resource_requests_response_due_idx
      ON resource_requests (decision_response_due_at, id)
      WHERE decision_state = 'APPROVED_WITH_CHANGES' AND removed_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX resource_requests_response_due_idx');
    await queryRunner.query('ALTER TABLE resource_requests DROP CONSTRAINT resource_requests_decision_response_due_state_ck');
    await queryRunner.query('ALTER TABLE resource_requests DROP COLUMN decision_response_due_at');
  }
}
