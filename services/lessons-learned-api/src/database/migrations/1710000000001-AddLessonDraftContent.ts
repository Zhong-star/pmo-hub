import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLessonDraftContent1710000000001 implements MigrationInterface {
  name = 'AddLessonDraftContent1710000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE lessons
        ADD COLUMN updated_by VARCHAR(128),
        ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN project_id VARCHAR(128),
        ADD COLUMN project_name VARCHAR(200),
        ADD COLUMN project_category VARCHAR(32),
        ADD COLUMN project_phase VARCHAR(32),
        ADD COLUMN situation_observed VARCHAR(4000),
        ADD COLUMN root_cause VARCHAR(4000),
        ADD COLUMN lesson_type VARCHAR(32),
        ADD COLUMN impact VARCHAR(4000),
        ADD COLUMN recommendation VARCHAR(4000),
        ADD COLUMN applicability VARCHAR(4000)
    `);
    await queryRunner.query('UPDATE lessons SET updated_by = author_id WHERE updated_by IS NULL');
    await queryRunner.query('ALTER TABLE lessons ALTER COLUMN updated_by SET NOT NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE lessons
        DROP COLUMN applicability,
        DROP COLUMN recommendation,
        DROP COLUMN impact,
        DROP COLUMN lesson_type,
        DROP COLUMN root_cause,
        DROP COLUMN situation_observed,
        DROP COLUMN project_phase,
        DROP COLUMN project_category,
        DROP COLUMN project_name,
        DROP COLUMN project_id,
        DROP COLUMN version,
        DROP COLUMN updated_by
    `);
  }
}
