import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateResourceAllocationCapacity2026112300098 implements MigrationInterface {
  name = 'CreateResourceAllocationCapacity2026112300098';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE resource_profiles
      ADD CONSTRAINT resource_profiles_id_group_uq UNIQUE (id, group_id)
    `);
    await queryRunner.query(`
      CREATE TABLE resource_capacities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id UUID NOT NULL REFERENCES resource_groups(id) ON DELETE RESTRICT,
        resource_profile_id UUID NOT NULL REFERENCES resource_profiles(id) ON DELETE RESTRICT,
        classification VARCHAR(20) NOT NULL CHECK (classification IN ('INTERNAL', 'THIRD_PARTY')),
        effective_date DATE NOT NULL,
        fte NUMERIC NOT NULL CHECK (fte >= 0 AND fte = round(fte, 1)),
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        CONSTRAINT resource_capacities_profile_group_fk
          FOREIGN KEY (resource_profile_id, group_id)
          REFERENCES resource_profiles (id, group_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX resource_capacities_effective_key_uq
      ON resource_capacities (group_id, resource_profile_id, classification, effective_date)
      WHERE deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE TABLE resource_capacity_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        capacity_id UUID NOT NULL REFERENCES resource_capacities(id) ON DELETE RESTRICT,
        action VARCHAR(20) NOT NULL CHECK (action IN ('CREATED', 'UPDATED', 'REMOVED')),
        actor_id UUID NOT NULL REFERENCES resource_people(id) ON DELETE RESTRICT,
        actor_snapshot JSONB NOT NULL,
        reason TEXT NOT NULL CHECK (char_length(btrim(reason)) > 0),
        before_snapshot JSONB,
        after_snapshot JSONB,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX resource_capacity_history_order_idx
      ON resource_capacity_history (capacity_id, occurred_at, id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE resource_capacity_history');
    await queryRunner.query('DROP TABLE resource_capacities');
    await queryRunner.query('ALTER TABLE resource_profiles DROP CONSTRAINT resource_profiles_id_group_uq');
  }
}
