import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateResourceAllocationInitiatives2026112000001 implements MigrationInterface {
  name = 'CreateResourceAllocationInitiatives2026112000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE resource_initiatives (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(100) NOT NULL,
        name VARCHAR(200) NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        code_used BOOLEAN NOT NULL DEFAULT FALSE,
        version INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT resource_initiatives_code_length CHECK (char_length(btrim(code)) BETWEEN 1 AND 100),
        CONSTRAINT resource_initiatives_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 200)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX resource_initiatives_normalized_code_unique
      ON resource_initiatives (lower(btrim(code)))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE resource_initiatives');
  }
}
