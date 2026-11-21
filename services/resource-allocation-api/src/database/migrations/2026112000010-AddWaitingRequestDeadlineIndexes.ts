import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWaitingRequestDeadlineIndexes2026112000010 implements MigrationInterface {
  name = 'AddWaitingRequestDeadlineIndexes2026112000010';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX resource_requests_waiting_received_idx
      ON resource_requests (received_at, id)
      WHERE decision_state = 'WAITING_FOR_PRESENTATION' AND removed_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX resource_requests_waiting_expiration_idx
      ON resource_requests (expiration_due_at, id)
      WHERE decision_state = 'WAITING_FOR_PRESENTATION' AND removed_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX resource_allocation_notifications_request_event_idx
      ON resource_allocation_notifications (source_request_id, event_code)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX resource_allocation_notifications_request_event_idx');
    await queryRunner.query('DROP INDEX resource_requests_waiting_expiration_idx');
    await queryRunner.query('DROP INDEX resource_requests_waiting_received_idx');
  }
}
