import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  getHealth,
  getHome,
  LESSONS_LEARNED_HEALTH_PATH,
  LESSONS_LEARNED_HOME_PATH,
  LESSONS_LEARNED_API_TIMEOUT_MS,
} from '../src/api';

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

  it('requests protected Home using the selected local profile ID', async () => {
    const response = {
      profile: { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' as const },
      navigation: [{ id: 'home' as const, label: 'Home' as const, current: true as const }],
    };
    const adapter = vi.fn().mockResolvedValue({
      data: response,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
    api.defaults.adapter = adapter;

    await expect(getHome('local-contributor')).resolves.toEqual(response);

    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      url: LESSONS_LEARNED_HOME_PATH,
      method: 'get',
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
  });
});
