import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateResourceAllocationAdministration2026112000002 implements MigrationInterface {
  name = 'CreateResourceAllocationAdministration2026112000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE resource_people
      ADD COLUMN group_id UUID,
      ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      CREATE TABLE resource_groups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL CHECK (char_length(btrim(name)) > 0),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        supervisor_id UUID REFERENCES resource_people(id) ON DELETE RESTRICT,
        manager_id UUID REFERENCES resource_people(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT resource_groups_active_responsibles CHECK (
          NOT active OR (supervisor_id IS NOT NULL AND manager_id IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      ALTER TABLE resource_people
      ADD CONSTRAINT resource_people_group_fk
      FOREIGN KEY (group_id) REFERENCES resource_groups(id) ON DELETE SET NULL
    `);
    await queryRunner.query('CREATE INDEX resource_groups_active_idx ON resource_groups (id) WHERE active = TRUE');
    await queryRunner.query(`
      CREATE TABLE resource_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL CHECK (char_length(btrim(name)) > 0),
        group_id UUID NOT NULL REFERENCES resource_groups(id) ON DELETE RESTRICT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        version INTEGER NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query('CREATE INDEX resource_profiles_group_active_idx ON resource_profiles (group_id, id) WHERE active = TRUE');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE resource_profiles');
    await queryRunner.query('DROP TABLE resource_groups');
    await queryRunner.query('ALTER TABLE resource_people DROP COLUMN group_id, DROP COLUMN version');
  }
}
