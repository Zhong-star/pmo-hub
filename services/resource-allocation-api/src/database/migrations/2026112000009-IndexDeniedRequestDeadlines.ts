import type { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexDeniedRequestDeadlines2026112000009 implements MigrationInterface {
  name = 'IndexDeniedRequestDeadlines2026112000009';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX resource_requests_denied_deadline_idx
      ON resource_requests (expiration_due_at, id)
      WHERE decision_state = 'DENIED' AND removed_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX resource_requests_denied_deadline_idx');
  }
}
