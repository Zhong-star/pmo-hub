import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestRevalidationOrigin2026112100000 implements MigrationInterface {
  name = 'AddRequestRevalidationOrigin2026112100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE resource_requests
      ADD COLUMN revalidation_origin_state VARCHAR(40)
    `);
    await queryRunner.query(`
      ALTER TABLE resource_requests
      ADD COLUMN revalidation_decision_stage VARCHAR(40)
    `);
    await queryRunner.query(`
      UPDATE resource_requests
      SET revalidation_origin_state = 'APPROVED_WITH_CHANGES'
      WHERE decision_state = 'REQUIRES_REVALIDATION'
    `);
    await queryRunner.query(`
      UPDATE resource_requests AS request
      SET revalidation_decision_stage = (
        SELECT history.after_snapshot->'before'->>'decisionState'
        FROM resource_request_history AS history
        WHERE history.request_id = request.id
          AND history.action = 'APPROVAL_CHANGES_PROPOSED'
        ORDER BY history.occurred_at DESC, history.id DESC
        LIMIT 1
      )
      WHERE request.decision_state = 'APPROVED_WITH_CHANGES'
         OR request.revalidation_origin_state = 'APPROVED_WITH_CHANGES'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE resource_requests DROP COLUMN revalidation_decision_stage');
    await queryRunner.query('ALTER TABLE resource_requests DROP COLUMN revalidation_origin_state');
  }
}
