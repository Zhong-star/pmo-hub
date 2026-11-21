import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationReadState2026112000007 implements MigrationInterface {
  name = 'AddNotificationReadState2026112000007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE resource_allocation_notifications ADD COLUMN read_at TIMESTAMPTZ');
    await queryRunner.query(`
      CREATE INDEX resource_allocation_notifications_recipient_read_created_idx
      ON resource_allocation_notifications (recipient_id, read_at, created_at DESC, id DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX resource_allocation_notifications_recipient_read_created_idx');
    await queryRunner.query('ALTER TABLE resource_allocation_notifications DROP COLUMN read_at');
  }
}
