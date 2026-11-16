import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLessonLibraryViews1710000000004 implements MigrationInterface {
  name = 'AddLessonLibraryViews1710000000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE lessons ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0)');
    await queryRunner.query(`
      CREATE TABLE lesson_library_views (
        lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
        opening_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (lesson_id, opening_id)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE lesson_library_views');
    await queryRunner.query('ALTER TABLE lessons DROP COLUMN view_count');
  }
}
