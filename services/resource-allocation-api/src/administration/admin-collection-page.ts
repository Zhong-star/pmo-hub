import { ResourceAllocationException } from '../access/resource-allocation-problem';

export interface AdminCollectionQuery {
  limit: number;
  active?: boolean;
  afterId?: string;
  filters?: Record<string, string>;
}

interface CursorPayload {
  version: 1;
  collection: string;
  active?: boolean;
  filters?: Record<string, string>;
  lastId: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAdminCollectionQuery(
  collection: string,
  query: { limit?: string; cursor?: string; active?: string; groupId?: string },
): AdminCollectionQuery {
  const requestedLimit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'limit must be a positive integer.');
  }
  const limit = Math.min(requestedLimit, 100);
  const filters: Record<string, string> = {};
  if (query.groupId !== undefined) {
    if (!uuidPattern.test(query.groupId)) {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'groupId must be a UUID.');
    }
    filters.groupId = query.groupId;
  }
  let active: boolean | undefined;
  if (query.active !== undefined) {
    if (query.active !== 'true' && query.active !== 'false') {
      throw new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'active must be true or false.');
    }
    active = query.active === 'true';
  }

  let afterId: string | undefined;
  if (query.cursor) {
    let payload: CursorPayload;
    try {
      payload = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as CursorPayload;
    } catch {
      throw invalidCursor();
    }
    if (
      payload.version !== 1 ||
      payload.collection !== collection ||
      payload.active !== active ||
      JSON.stringify(payload.filters ?? {}) !== JSON.stringify(filters) ||
      typeof payload.lastId !== 'string' ||
      !uuidPattern.test(payload.lastId)
    ) {
      throw invalidCursor();
    }
    afterId = payload.lastId;
  }

  return {
    limit,
    ...(active === undefined ? {} : { active }),
    ...(afterId ? { afterId } : {}),
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  };
}

export function nextAdminCollectionCursor(
  collection: string,
  active: boolean | undefined,
  lastId: string,
  filters?: Record<string, string>,
): string {
  const payload: CursorPayload = {
    version: 1,
    collection,
    ...(active === undefined ? {} : { active }),
    ...(filters && Object.keys(filters).length > 0 ? { filters } : {}),
    lastId,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function invalidCursor(): ResourceAllocationException {
  return new ResourceAllocationException('VALIDATION_ERROR', 'Request validation failed', 400, 'The cursor is invalid for this collection or filter.');
}
