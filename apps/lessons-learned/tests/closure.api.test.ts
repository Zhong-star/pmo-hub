import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  closeLesson,
  LESSONS_LEARNED_API_TIMEOUT_MS,
  LESSONS_LEARNED_CLOSE_PATH,
} from '../src/api';

describe('lessons learned closure client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts the displayed lesson version using the selected PMO profile', async () => {
    const closed = {
      id: 92,
      status: 'Closed',
      version: 7,
      approvedAt: '2026-11-14T15:30:00.000Z',
    };
    const adapter = vi.fn().mockResolvedValue({
      data: closed,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
    api.defaults.adapter = adapter;

    await expect(closeLesson('local-pmo', 92, { version: 6 })).resolves.toEqual(closed);

    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      url: LESSONS_LEARNED_CLOSE_PATH.replace('{id}', '92'),
      method: 'post',
      data: JSON.stringify({ version: 6 }),
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-pmo' }),
    }));
  });
});
