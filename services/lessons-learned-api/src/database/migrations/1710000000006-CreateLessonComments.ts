import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLessonComments1710000000006 implements MigrationInterface {
  name = 'CreateLessonComments1710000000006';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE lesson_comments (
        id SERIAL PRIMARY KEY,
        lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
        parent_comment_id INTEGER NULL REFERENCES lesson_comments(id) ON DELETE CASCADE,
        author_user_id VARCHAR(128) NOT NULL,
        author_display_name VARCHAR(200) NOT NULL,
        body VARCHAR(2000) NOT NULL CHECK (char_length(btrim(body)) >= 1 AND char_length(body) <= 2000),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        hidden_at TIMESTAMPTZ NULL,
        hidden_by_user_id VARCHAR(128) NULL,
        hidden_by_display_name VARCHAR(200) NULL,
        hidden_reason VARCHAR(1000) NULL CHECK (hidden_reason IS NULL OR (char_length(btrim(hidden_reason)) >= 1 AND char_length(hidden_reason) <= 1000))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX lesson_comments_lesson_root_created_idx
      ON lesson_comments (lesson_id, created_at DESC, id DESC)
      WHERE parent_comment_id IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX lesson_comments_parent_created_idx
      ON lesson_comments (parent_comment_id, created_at ASC, id ASC)
      WHERE parent_comment_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX lesson_comments_lesson_visible_idx
      ON lesson_comments (lesson_id)
      WHERE hidden_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE lesson_comments');
  }
}
