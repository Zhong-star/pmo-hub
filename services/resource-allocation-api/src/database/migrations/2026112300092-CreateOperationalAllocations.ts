import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOperationalAllocations2026112300092 implements MigrationInterface {
  name = 'CreateOperationalAllocations2026112300092';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE resource_allocations ALTER COLUMN source_request_id DROP NOT NULL');
    await queryRunner.query('ALTER TABLE resource_allocations ALTER COLUMN initiative_id DROP NOT NULL');
    await queryRunner.query('ALTER TABLE resource_allocations ALTER COLUMN initiative_snapshot DROP NOT NULL');
    await queryRunner.query('ALTER TABLE resource_allocations ALTER COLUMN resource_profile_id DROP NOT NULL');
    await queryRunner.query('ALTER TABLE resource_allocations ALTER COLUMN resource_profile_snapshot DROP NOT NULL');
    await queryRunner.query("ALTER TABLE resource_allocations ADD COLUMN origin VARCHAR(16) NOT NULL DEFAULT 'REQUEST' CHECK (origin IN ('REQUEST', 'SELF', 'DIRECT'))");
    await queryRunner.query('ALTER TABLE resource_allocations ADD COLUMN category VARCHAR(40)');
    await queryRunner.query('ALTER TABLE resource_allocations ADD COLUMN comment TEXT');
    await queryRunner.query("ALTER TABLE resource_allocations ADD COLUMN classification VARCHAR(20) CHECK (classification IS NULL OR classification IN ('INTERNAL', 'THIRD_PARTY'))");
    await queryRunner.query('ALTER TABLE resource_allocations ADD COLUMN created_by_person_id UUID REFERENCES resource_people(id) ON DELETE RESTRICT');
    await queryRunner.query(`
      UPDATE resource_allocations AS allocation
      SET category = COALESCE(request.requested_conditions->>'category', request.approved_conditions->>'category')
      FROM resource_requests AS request
      WHERE request.id = allocation.source_request_id
    `);
    await queryRunner.query(`
      ALTER TABLE resource_allocations
      ADD CONSTRAINT resource_allocations_origin_request_ck CHECK (
        (origin = 'REQUEST' AND source_request_id IS NOT NULL)
        OR (origin IN ('SELF', 'DIRECT') AND source_request_id IS NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE resource_allocations
      ADD CONSTRAINT resource_allocations_category_shape_ck CHECK (
        CASE
          WHEN category = 'VACATION' THEN origin <> 'REQUEST' AND initiative_id IS NULL AND resource_profile_id IS NULL AND weekly_hours = 40.0
          WHEN category IN ('ROUTINE_SUPPORT', 'TRAINING', 'INTERNAL_ACTIVITIES') THEN origin <> 'REQUEST' AND initiative_id IS NULL AND resource_profile_id IS NOT NULL AND comment IS NOT NULL
          ELSE initiative_id IS NOT NULL AND initiative_snapshot IS NOT NULL AND resource_profile_id IS NOT NULL AND resource_profile_snapshot IS NOT NULL
        END
      )
    `);
    await queryRunner.query(`
      ALTER TABLE resource_allocations
      ADD CONSTRAINT resource_allocations_author_ck CHECK (origin = 'REQUEST' OR created_by_person_id IS NOT NULL)
    `);

    await queryRunner.query('ALTER TABLE resource_allocation_notifications ALTER COLUMN source_request_id DROP NOT NULL');
    await queryRunner.query('ALTER TABLE resource_allocation_notifications ADD COLUMN source_allocation_id UUID REFERENCES resource_allocations(id) ON DELETE RESTRICT');
    await queryRunner.query(`
      ALTER TABLE resource_allocation_notifications
      ADD CONSTRAINT resource_allocation_notifications_one_source_ck CHECK (
        num_nonnulls(source_request_id, source_allocation_id) = 1
      )
    `);
    // NULL request ids never collide, so the existing request uniqueness stays as is.
    await queryRunner.query(`
      ALTER TABLE resource_allocation_notifications
      ADD CONSTRAINT resource_allocation_notifications_recipient_event_allocation_uq
      UNIQUE (recipient_id, event_code, source_allocation_id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows = await queryRunner.query(`
      SELECT COUNT(*)::int AS count
      FROM resource_allocations
      WHERE origin <> 'REQUEST'
    `) as Array<{ count: number }>;
    if (Number(rows[0]?.count ?? 0) > 0) {
      throw new Error('Cannot roll back operational allocations while self or direct allocations exist.');
    }
    const notices = await queryRunner.query(`
      SELECT COUNT(*)::int AS count
      FROM resource_allocation_notifications
      WHERE source_allocation_id IS NOT NULL
    `) as Array<{ count: number }>;
    if (Number(notices[0]?.count ?? 0) > 0) {
      throw new Error('Cannot roll back allocation notifications while allocation-targeted notices exist.');
    }

    await queryRunner.query('ALTER TABLE resource_allocation_notifications DROP CONSTRAINT resource_allocation_notifications_recipient_event_allocation_uq');
    await queryRunner.query('ALTER TABLE resource_allocation_notifications DROP CONSTRAINT resource_allocation_notifications_one_source_ck');
    await queryRunner.query('ALTER TABLE resource_allocation_notifications DROP COLUMN source_allocation_id');
    await queryRunner.query('ALTER TABLE resource_allocation_notifications ALTER COLUMN source_request_id SET NOT NULL');
    await queryRunner.query('ALTER TABLE resource_allocations DROP CONSTRAINT resource_allocations_author_ck');
    await queryRunner.query('ALTER TABLE resource_allocations DROP CONSTRAINT resource_allocations_category_shape_ck');
    await queryRunner.query('ALTER TABLE resource_allocations DROP CONSTRAINT resource_allocations_origin_request_ck');
    await queryRunner.query('ALTER TABLE resource_allocations DROP COLUMN created_by_person_id');
    await queryRunner.query('ALTER TABLE resource_allocations DROP COLUMN classification');
    await queryRunner.query('ALTER TABLE resource_allocations DROP COLUMN comment');
    await queryRunner.query('ALTER TABLE resource_allocations DROP COLUMN category');
    await queryRunner.query('ALTER TABLE resource_allocations DROP COLUMN origin');
    await queryRunner.query('ALTER TABLE resource_allocations ALTER COLUMN resource_profile_snapshot SET NOT NULL');
    await queryRunner.query('ALTER TABLE resource_allocations ALTER COLUMN resource_profile_id SET NOT NULL');
    await queryRunner.query('ALTER TABLE resource_allocations ALTER COLUMN initiative_snapshot SET NOT NULL');
    await queryRunner.query('ALTER TABLE resource_allocations ALTER COLUMN initiative_id SET NOT NULL');
    await queryRunner.query('ALTER TABLE resource_allocations ALTER COLUMN source_request_id SET NOT NULL');
  }
}
