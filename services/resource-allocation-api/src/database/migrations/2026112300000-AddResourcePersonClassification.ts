import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResourcePersonClassification2026112300000 implements MigrationInterface {
  name = 'AddResourcePersonClassification2026112300000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE resource_people
      ADD COLUMN classification VARCHAR(20),
      ADD CONSTRAINT resource_people_classification_check
        CHECK (classification IS NULL OR classification IN ('INTERNAL', 'THIRD_PARTY'))
    `);
    await queryRunner.query(`
      CREATE TABLE resource_person_classification_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sequence BIGSERIAL NOT NULL UNIQUE,
        person_id UUID NOT NULL REFERENCES resource_people(id) ON DELETE RESTRICT,
        actor_id UUID NOT NULL REFERENCES resource_people(id) ON DELETE RESTRICT,
        actor_snapshot JSONB NOT NULL,
        previous_classification VARCHAR(20),
        next_classification VARCHAR(20),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT resource_person_classification_history_previous_check
          CHECK (previous_classification IS NULL OR previous_classification IN ('INTERNAL', 'THIRD_PARTY')),
        CONSTRAINT resource_person_classification_history_next_check
          CHECK (next_classification IS NULL OR next_classification IN ('INTERNAL', 'THIRD_PARTY')),
        CONSTRAINT resource_person_classification_history_change_check
          CHECK (previous_classification IS DISTINCT FROM next_classification)
      )
    `);
    await queryRunner.query('CREATE INDEX resource_person_classification_history_order_idx ON resource_person_classification_history (person_id, sequence)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX resource_person_classification_history_order_idx');
    await queryRunner.query('DROP TABLE resource_person_classification_history');
    await queryRunner.query('ALTER TABLE resource_people DROP CONSTRAINT resource_people_classification_check, DROP COLUMN classification');
  }
}
