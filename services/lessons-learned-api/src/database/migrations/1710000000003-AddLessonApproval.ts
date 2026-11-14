import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLessonApproval1710000000003 implements MigrationInterface {
  name = 'AddLessonApproval1710000000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE lessons ADD COLUMN approved_at TIMESTAMPTZ');
    await queryRunner.query(`
      UPDATE lessons
      SET approved_at = updated_at
      WHERE status IN ('Approved', 'Closed') AND approved_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX lessons_published_approved_at_idx
      ON lessons (approved_at DESC, id DESC)
      WHERE status IN ('Approved', 'Closed') AND approved_at IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX lessons_published_approved_at_idx');
    await queryRunner.query('ALTER TABLE lessons DROP COLUMN approved_at');
  }
}
