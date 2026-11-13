import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, getHealth, LESSONS_LEARNED_HEALTH_PATH, LESSONS_LEARNED_API_TIMEOUT_MS } from '../src/api';

describe('lessons learned HTTP client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests the health endpoint with the configured timeout and returns the contract response', async () => {
    const adapter = vi.fn().mockResolvedValue({
      data: { status: 'ok' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
    api.defaults.adapter = adapter;

    await expect(getHealth()).resolves.toEqual({ status: 'ok' });

    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      url: LESSONS_LEARNED_HEALTH_PATH,
      method: 'get',
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
    }));
  });

  it('treats a non-ok response body as unavailable', async () => {
    api.defaults.adapter = vi.fn().mockResolvedValue({
      data: { status: 'degraded' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });

    await expect(getHealth()).rejects.toThrow('The Lessons Learned API is unavailable.');
  });
});
