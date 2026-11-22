import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateResourceAllocationOperationReceipts2026112000003 implements MigrationInterface {
  name = 'CreateResourceAllocationOperationReceipts2026112000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE resource_allocation_operation_receipts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id UUID NOT NULL REFERENCES resource_people(id) ON DELETE RESTRICT,
        operation VARCHAR(200) NOT NULL CHECK (char_length(btrim(operation)) > 0),
        idempotency_key UUID NOT NULL,
        payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        response_body JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT resource_allocation_operation_receipts_scope_key_uq
          UNIQUE (actor_id, operation, idempotency_key)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE resource_allocation_operation_receipts');
  }
}
