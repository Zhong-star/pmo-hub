import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLessonsAndHistory1710000000000 implements MigrationInterface {
  name = 'CreateLessonsAndHistory1710000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE lessons (
        id SERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        author_id VARCHAR(128) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'Open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX lessons_author_status_updated_idx ON lessons (author_id, status, updated_at DESC)`);
    await queryRunner.query(`
      CREATE TABLE lesson_history (
        id SERIAL PRIMARY KEY,
        lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
        actor_id VARCHAR(128) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        previous_status VARCHAR(32),
        new_status VARCHAR(32) NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX lesson_history_lesson_id_id_idx ON lesson_history (lesson_id, id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE lesson_history');
    await queryRunner.query('DROP TABLE lessons');
  }
}
