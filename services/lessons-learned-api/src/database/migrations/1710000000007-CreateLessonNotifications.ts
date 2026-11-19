import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLessonNotifications1710000000007 implements MigrationInterface {
  name = 'CreateLessonNotifications1710000000007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE lesson_notifications (
        id SERIAL PRIMARY KEY,
        recipient_user_id VARCHAR(128) NOT NULL,
        actor_user_id VARCHAR(128) NOT NULL,
        actor_display_name VARCHAR(200) NOT NULL,
        event_type VARCHAR(40) NOT NULL CHECK (
          event_type IN (
            'LESSON_RETURNED',
            'LESSON_APPROVED',
            'LESSON_REJECTED',
            'COMMENT_ADDED',
            'REPLY_ADDED'
          )
        ),
        lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
        lesson_title_snapshot VARCHAR(200) NOT NULL,
        summary VARCHAR(500) NOT NULL,
        source_event_key VARCHAR(128) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        read_at TIMESTAMPTZ NULL,
        CONSTRAINT lesson_notifications_dedup_unique UNIQUE (recipient_user_id, event_type, source_event_key)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX lesson_notifications_recipient_created_idx
      ON lesson_notifications (recipient_user_id, created_at DESC, id DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX lesson_notifications_recipient_unread_idx
      ON lesson_notifications (recipient_user_id)
      WHERE read_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE lesson_notifications');
  }
}
