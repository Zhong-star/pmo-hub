import { BadRequestException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import type { SelectQueryBuilder } from 'typeorm';
import type { Lesson } from './lesson.entity';
import { LessonDraftResponse } from './lesson-response.dto';

class LessonPageInfo {
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;

  @ApiProperty({ type: Number, minimum: 1, maximum: 100 })
  limit!: number;
}

export class LessonPage {
  @ApiProperty({ type: [LessonDraftResponse] })
  items!: LessonDraftResponse[];

  @ApiProperty({ type: LessonPageInfo })
  page!: LessonPageInfo;
}

export function readPageRequest(paged?: string, cursor?: string, limit?: string) {
  if (paged === undefined && cursor === undefined && limit === undefined) return undefined;
  if (paged !== undefined && paged !== 'true') throw new BadRequestException('Set paged to true.');
  if (limit !== undefined && (typeof limit !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(limit))) {
    throw new BadRequestException('Page limit must be an integer between 1 and 100.');
  }
  return { cursor, limit: limit === undefined ? 50 : Number(limit) };
}

export type LessonPageRequest = NonNullable<ReturnType<typeof readPageRequest>>;

function decodeCursor(cursor: string, scope: string): { key: string; id: number } {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (decoded.scope !== scope || typeof decoded.key !== 'string' || !/^-?[0-9]{1,19}$/.test(decoded.key) ||
      BigInt(decoded.key) > 9223372036854775807n || BigInt(decoded.key) < -9223372036854775808n ||
      !Number.isInteger(decoded.id) || decoded.id < 1 || decoded.id > 2147483647) throw new Error();
    return decoded;
  } catch {
    throw new BadRequestException('Invalid cursor for this lesson query.');
  }
}

export async function paginateLessons(
  query: SelectQueryBuilder<Lesson>,
  request: LessonPageRequest,
  scope: string,
  timestamp: string,
  direction: 'ASC' | 'DESC',
  toResponse: (lesson: Lesson) => LessonDraftResponse,
): Promise<LessonPage> {
  // Keep PostgreSQL microsecond precision in the cursor instead of rounding through a JavaScript Date.
  const key = `COALESCE((EXTRACT(EPOCH FROM ${timestamp}) * 1000000)::bigint, 9223372036854775807::bigint)`;
  if (request.cursor !== undefined) {
    const cursor = decodeCursor(request.cursor, scope);
    const compare = direction === 'ASC' ? '>' : '<';
    query.andWhere(`(${key}, lesson.id) ${compare} (CAST(:pageKey AS bigint), :pageId)`, {
      pageKey: cursor.key, pageId: cursor.id,
    });
  }
  const { raw, entities } = await query.addSelect(key, 'cursor_key')
    .orderBy('cursor_key', direction).addOrderBy('lesson.id', direction)
    .limit(request.limit + 1).getRawAndEntities<{ cursor_key: string }>();
  const last = request.limit - 1;
  const nextCursor = entities.length > request.limit
    ? Buffer.from(JSON.stringify({ scope, key: raw[last].cursor_key, id: entities[last].id })).toString('base64url')
    : null;
  return { items: entities.slice(0, request.limit).map(toResponse), page: { limit: request.limit, nextCursor } };
}
