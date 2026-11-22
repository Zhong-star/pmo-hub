import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateResourceAllocations2026112000008 implements MigrationInterface {
  name = 'CreateResourceAllocations2026112000008';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE resource_requests ADD COLUMN approved_conditions JSONB');
    await queryRunner.query(`
      CREATE TABLE resource_allocations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_request_id UUID NOT NULL REFERENCES resource_requests(id) ON DELETE RESTRICT,
        person_id UUID NOT NULL REFERENCES resource_people(id) ON DELETE RESTRICT,
        person_snapshot JSONB NOT NULL,
        group_id UUID NOT NULL REFERENCES resource_groups(id) ON DELETE RESTRICT,
        group_snapshot JSONB NOT NULL,
        initiative_id UUID NOT NULL REFERENCES resource_initiatives(id) ON DELETE RESTRICT,
        initiative_snapshot JSONB NOT NULL,
        resource_profile_id UUID NOT NULL REFERENCES resource_profiles(id) ON DELETE RESTRICT,
        resource_profile_snapshot JSONB NOT NULL,
        approved_start_date DATE NOT NULL,
        approved_end_date DATE NOT NULL,
        effective_start_date DATE NOT NULL,
        effective_end_date DATE NOT NULL,
        weekly_hours NUMERIC(3,1) NOT NULL CHECK (weekly_hours > 0 AND weekly_hours <= 40),
        state VARCHAR(40) NOT NULL CHECK (state IN (
          'NOT_STARTED', 'IN_PROGRESS', 'SUSPENDED', 'ALLOCATED_WITHOUT_ACTION', 'DONE', 'CANCELED'
        )),
        state_entered_at TIMESTAMPTZ NOT NULL,
        approved_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        CONSTRAINT resource_allocations_source_request_uq UNIQUE (source_request_id),
        CONSTRAINT resource_allocations_approved_period_ck CHECK (approved_start_date <= approved_end_date),
        CONSTRAINT resource_allocations_effective_period_ck CHECK (effective_start_date <= effective_end_date)
      )
    `);
    await queryRunner.query('CREATE INDEX resource_allocations_person_state_idx ON resource_allocations (person_id, state, approved_start_date, id)');
    await queryRunner.query('CREATE INDEX resource_allocations_group_period_idx ON resource_allocations (group_id, approved_start_date, id)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE resource_allocations');
    await queryRunner.query('ALTER TABLE resource_requests DROP COLUMN approved_conditions');
  }
}
