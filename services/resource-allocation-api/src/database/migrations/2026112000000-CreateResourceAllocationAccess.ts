import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateResourceAllocationAccess2026112000000 implements MigrationInterface {
  name = 'CreateResourceAllocationAccess2026112000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE resource_people (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        local_user_id VARCHAR(200) NOT NULL UNIQUE,
        display_name VARCHAR(200) NOT NULL,
        email VARCHAR(320) NOT NULL,
        role VARCHAR(40) NOT NULL CHECK (role IN (
          'ALLOCATION_USER',
          'ALLOCATION_MODERATOR',
          'ALLOCATION_SUPERVISOR',
          'ALLOCATION_MANAGER',
          'ALLOCATION_ADMIN'
        )),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        covered_group_ids UUID[] NOT NULL DEFAULT '{}'
      )
    `);
    await queryRunner.query(`
      CREATE INDEX resource_people_active_admins_idx
      ON resource_people (display_name, id)
      WHERE active = TRUE AND role = 'ALLOCATION_ADMIN'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE resource_people');
  }
}
