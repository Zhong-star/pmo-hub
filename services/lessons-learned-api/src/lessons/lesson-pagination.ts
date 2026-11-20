import { BadRequestException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import type { SelectQueryBuilder } from 'typeorm';
import type { Lesson } from './lesson.entity';
import { LessonDraftResponse, LessonLibraryResponse, LessonPageInfo } from './lesson-response.dto';
import { LessonProjectResponse } from './project-response.dto';

export class LessonPage<T = LessonDraftResponse> {
  @ApiProperty({ type: [LessonDraftResponse] })
  items!: T[];

  @ApiProperty({ type: LessonPageInfo })
  page!: LessonPageInfo;
}

export class LessonLibraryPage extends LessonPage<LessonLibraryResponse> {
  @ApiProperty({ type: [LessonLibraryResponse] })
  declare items: LessonLibraryResponse[];
}

export class LessonProjectPage {
  @ApiProperty({ type: [LessonProjectResponse] })
  items!: LessonProjectResponse[];

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

export function collectionCursorScope(...context: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

export function encodeCollectionCursor(scope: string, keys: string[]): string {
  return Buffer.from(JSON.stringify({ scope, keys })).toString('base64url');
}

export function readCollectionCursor(cursor: string, scope: string, keyCount: number): string[] {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw new Error();
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (decoded.scope !== scope || !Array.isArray(decoded.keys) || decoded.keys.length !== keyCount
      || !decoded.keys.every((key: unknown) => typeof key === 'string' && key.length <= 500 && !key.includes('\0'))) {
      throw new Error();
    }
    return decoded.keys;
  } catch {
    throw new BadRequestException('Invalid cursor for this collection.');
  }
}

export interface LessonSortKey {
  expression: string;
  type: 'bigint' | 'text';
  direction: 'ASC' | 'DESC';
}

export function lessonLabelSort(sort: 'title' | 'project' | 'type' | 'status'): LessonSortKey[] {
  if (sort === 'title' || sort === 'status') {
    return [{ expression: sort === 'title' ? 'LOWER(lesson.title)' : 'lesson.status', type: 'text', direction: 'ASC' }];
  }
  const byProject = sort === 'project';
  const field = byProject ? 'lesson.project_name' : 'lesson.lesson_type';
  return [
    { expression: `CASE WHEN ${byProject ? 'lesson.project_id' : field} IS NULL THEN 1 ELSE 0 END`, type: 'bigint', direction: 'ASC' },
    { expression: `LOWER(COALESCE(${field}, ''))`, type: 'text', direction: 'ASC' },
  ];
}

export async function paginateLessonCollection<Raw extends object>(
  query: SelectQueryBuilder<Lesson>,
  request: LessonPageRequest,
  scope: string,
  sort: LessonSortKey[],
) {
  const aliases = sort.map((_, index) => `collection_key_${index}`);
  if (request.cursor !== undefined) {
    const keys = readCollectionCursor(request.cursor, scope, sort.length);
    const parameters: Record<string, string> = {};
    const comparisons = sort.map(({ expression, type, direction }, index) => {
      const key = keys[index];
      if (type === 'bigint' && (!/^-?\d{1,19}$/.test(key) || BigInt(key) > 9223372036854775807n
        || BigInt(key) < -9223372036854775808n)) {
        throw new BadRequestException('Invalid numeric key in collection cursor.');
      }
      parameters[aliases[index]] = key;
      return { expression, parameter: `CAST(:${aliases[index]} AS ${type})`, op: direction === 'ASC' ? '>' : '<' };
    });
    const branches = comparisons.map(({ expression, parameter, op }, index) => {
      const equalKeys = comparisons.slice(0, index).map((key) => `${key.expression} = ${key.parameter}`);
      return `(${[...equalKeys, `${expression} ${op} ${parameter}`].join(' AND ')})`;
    });
    query.andWhere(`(${branches.join(' OR ')})`, parameters);
  }

  sort.forEach(({ expression, direction }, index) => {
    query.addSelect(`CAST(${expression} AS text)`, aliases[index]).addOrderBy(expression, direction);
  });
  const { entities, raw } = await query.limit(request.limit + 1).getRawAndEntities<Raw & Record<string, string>>();
  const last = raw[request.limit - 1];
  return {
    entities: entities.slice(0, request.limit),
    raw: raw.slice(0, request.limit),
    page: {
      limit: request.limit,
      nextCursor: entities.length > request.limit
        ? encodeCollectionCursor(scope, aliases.map((alias) => last[alias]))
        : null,
    },
  };
}

const projectCursorPrefix = 'evaluation-projects:';

export function readProjectCursor(cursor: string): string {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const id = decoded.slice(projectCursorPrefix.length);
    if (!decoded.startsWith(projectCursorPrefix) || !id || id.includes('\0') || [...id].length > 128) {
      throw new Error();
    }
    return id;
  } catch {
    throw new BadRequestException('Invalid cursor for evaluation projects.');
  }
}

export function encodeProjectCursor(id: string): string {
  return Buffer.from(projectCursorPrefix + id).toString('base64url');
}

function decodeCursor(cursor: string, scope: string): { key: string; id: number } {
  try {
    // Legacy cursors embed both filters, including escaped characters.
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw new Error();
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const scopeHash = createHash('sha256').update(scope).digest('hex');
    if ((decoded.scope !== scope && decoded.scope !== scopeHash) || typeof decoded.key !== 'string' || !/^-?[0-9]{1,19}$/.test(decoded.key) ||
      BigInt(decoded.key) > 9223372036854775807n || BigInt(decoded.key) < -9223372036854775808n ||
      !Number.isInteger(decoded.id) || decoded.id < 1 || decoded.id > 2147483647) throw new Error();
    return decoded;
  } catch {
    throw new BadRequestException('Invalid cursor for this lesson query.');
  }
}

export async function paginateLessons<T extends LessonDraftResponse = LessonDraftResponse>(
  query: SelectQueryBuilder<Lesson>,
  request: LessonPageRequest,
  scope: string,
  timestamp: string,
  direction: 'ASC' | 'DESC',
  toResponse: (lesson: Lesson) => T,
  representationTokens: boolean,
): Promise<LessonPage<T>> {
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
    ? Buffer.from(JSON.stringify({
      scope: representationTokens ? createHash('sha256').update(scope).digest('hex') : scope,
      key: raw[last].cursor_key,
      id: entities[last].id,
    })).toString('base64url')
    : null;
  return { items: entities.slice(0, request.limit).map(toResponse), page: { limit: request.limit, nextCursor } };
}

interface LibrarySortCursor {
  scope: string;
  rank: number;
  value: string;
  approvedAt: string;
  id: number;
}

function decodeLibrarySortCursor(
  cursor: string,
  scope: string,
): LibrarySortCursor {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw new Error();
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const scopeHash = createHash('sha256').update(scope).digest('hex');
    if (
      (decoded.scope !== scope && decoded.scope !== scopeHash) ||
      !Number.isInteger(decoded.rank) || (decoded.rank !== 0 && decoded.rank !== 1) ||
      typeof decoded.value !== 'string' || [...decoded.value].length > 200 || decoded.value.includes('\0') ||
      typeof decoded.approvedAt !== 'string' || !/^-?[0-9]{1,19}$/.test(decoded.approvedAt) ||
      BigInt(decoded.approvedAt) > 9223372036854775807n || BigInt(decoded.approvedAt) < -9223372036854775808n ||
      !Number.isInteger(decoded.id) || decoded.id < 1 || decoded.id > 2147483647
    ) throw new Error();
    return decoded as LibrarySortCursor;
  } catch {
    throw new BadRequestException('Invalid cursor for this lesson query.');
  }
}

export async function paginateLibraryLessonsByTextKey<T extends LessonDraftResponse = LessonDraftResponse>(
  query: SelectQueryBuilder<Lesson>,
  request: LessonPageRequest,
  scope: string,
  sort: 'title' | 'project' | 'type',
  toResponse: (lesson: Lesson) => T,
  representationTokens: boolean,
): Promise<LessonPage<T>> {
  const rankExpression = sort === 'project'
    ? 'CASE WHEN lesson.projectId IS NULL THEN 1 ELSE 0 END'
    : sort === 'type' ? 'CASE WHEN lesson.lessonType IS NULL THEN 1 ELSE 0 END' : '0::integer';
  const valueExpression = sort === 'title'
    ? 'LOWER(lesson.title)'
    : sort === 'project' ? "LOWER(COALESCE(lesson.projectName, ''))" : "LOWER(COALESCE(lesson.lessonType, ''))";
  const approvalExpression = 'COALESCE((EXTRACT(EPOCH FROM lesson.approvedAt) * 1000000)::bigint, 9223372036854775807::bigint)';

  if (request.cursor !== undefined) {
    const cursor = decodeLibrarySortCursor(request.cursor, scope);
    query.andWhere(`(
      ${rankExpression} > :sortRank OR
      (${rankExpression} = :sortRank AND ${valueExpression} > :sortValue) OR
      (${rankExpression} = :sortRank AND ${valueExpression} = :sortValue AND ${approvalExpression} < CAST(:approvedAt AS bigint)) OR
      (${rankExpression} = :sortRank AND ${valueExpression} = :sortValue AND ${approvalExpression} = CAST(:approvedAt AS bigint) AND lesson.id < :sortId)
    )`, {
      sortRank: cursor.rank,
      sortValue: cursor.value,
      approvedAt: cursor.approvedAt,
      sortId: cursor.id,
    });
  }

  const { raw, entities } = await query
    .addSelect(rankExpression, 'library_sort_rank')
    .addSelect(valueExpression, 'library_sort_value')
    .addSelect(approvalExpression, 'library_sort_approved_at')
    .orderBy('library_sort_rank', 'ASC')
    .addOrderBy('library_sort_value', 'ASC')
    .addOrderBy('library_sort_approved_at', 'DESC')
    .addOrderBy('lesson.id', 'DESC')
    .limit(request.limit + 1)
    .getRawAndEntities<{
      library_sort_rank: string | number;
      library_sort_value: string;
      library_sort_approved_at: string;
    }>();

  const last = request.limit - 1;
  const nextCursor = entities.length > request.limit
    ? Buffer.from(JSON.stringify({
      scope: representationTokens ? createHash('sha256').update(scope).digest('hex') : scope,
      rank: Number(raw[last].library_sort_rank),
      value: raw[last].library_sort_value,
      approvedAt: raw[last].library_sort_approved_at,
      id: entities[last].id,
    })).toString('base64url')
    : null;
  return { items: entities.slice(0, request.limit).map(toResponse), page: { limit: request.limit, nextCursor } };
}

interface LibraryVotesCursor {
  scope: string;
  votes: number;
  approvedAt: string;
  id: number;
}

function decodeLibraryVotesCursor(
  cursor: string,
  scope: string,
): LibraryVotesCursor {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw new Error();
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const scopeHash = createHash('sha256').update(scope).digest('hex');
    if (
      (decoded.scope !== scope && decoded.scope !== scopeHash) ||
      !Number.isInteger(decoded.votes) || decoded.votes < 0 || decoded.votes > 2147483647 ||
      typeof decoded.approvedAt !== 'string' || !/^-?[0-9]{1,19}$/.test(decoded.approvedAt) ||
      BigInt(decoded.approvedAt) > 9223372036854775807n || BigInt(decoded.approvedAt) < -9223372036854775808n ||
      !Number.isInteger(decoded.id) || decoded.id < 1 || decoded.id > 2147483647
    ) throw new Error();
    return decoded as LibraryVotesCursor;
  } catch {
    throw new BadRequestException('Invalid cursor for this lesson query.');
  }
}

export async function paginateLibraryLessonsByVotes<T extends LessonDraftResponse = LessonDraftResponse>(
  query: SelectQueryBuilder<Lesson>,
  request: LessonPageRequest,
  scope: string,
  toResponse: (lesson: Lesson) => T,
  representationTokens: boolean,
): Promise<LessonPage<T>> {
  const votesExpression = '(SELECT COUNT(*)::integer FROM lesson_votes lv WHERE lv.lesson_id = lesson.id)';
  const approvalExpression = 'COALESCE((EXTRACT(EPOCH FROM lesson.approvedAt) * 1000000)::bigint, 9223372036854775807::bigint)';

  if (request.cursor !== undefined) {
    const cursor = decodeLibraryVotesCursor(request.cursor, scope);
    query.andWhere(`(
      ${votesExpression} < :sortVotes OR
      (${votesExpression} = :sortVotes AND ${approvalExpression} < CAST(:approvedAt AS bigint)) OR
      (${votesExpression} = :sortVotes AND ${approvalExpression} = CAST(:approvedAt AS bigint) AND lesson.id > :sortId)
    )`, {
      sortVotes: cursor.votes,
      approvedAt: cursor.approvedAt,
      sortId: cursor.id,
    });
  }

  const { raw, entities } = await query
    .addSelect(votesExpression, 'library_sort_votes')
    .addSelect(approvalExpression, 'library_sort_approved_at')
    .orderBy('library_sort_votes', 'DESC')
    .addOrderBy('library_sort_approved_at', 'DESC')
    .addOrderBy('lesson.id', 'ASC')
    .limit(request.limit + 1)
    .getRawAndEntities<{
      library_sort_votes: string | number;
      library_sort_approved_at: string;
    }>();

  const last = request.limit - 1;
  const nextCursor = entities.length > request.limit
    ? Buffer.from(JSON.stringify({
      scope: representationTokens ? createHash('sha256').update(scope).digest('hex') : scope,
      votes: Number(raw[last].library_sort_votes),
      approvedAt: raw[last].library_sort_approved_at,
      id: entities[last].id,
    })).toString('base64url')
    : null;
  return { items: entities.slice(0, request.limit).map(toResponse), page: { limit: request.limit, nextCursor } };
}
