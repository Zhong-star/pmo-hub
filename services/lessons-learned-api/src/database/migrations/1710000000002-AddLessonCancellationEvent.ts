import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLessonCancellationEvent1710000000002 implements MigrationInterface {
  name = 'AddLessonCancellationEvent1710000000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE lesson_history ADD COLUMN reason VARCHAR(1000)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE lesson_history DROP COLUMN reason');
  }
}
