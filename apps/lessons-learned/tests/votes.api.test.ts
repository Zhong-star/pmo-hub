import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  castLessonVote,
  removeLessonVote,
  LESSONS_LEARNED_API_TIMEOUT_MS,
  LESSONS_LEARNED_VOTE_PATH,
} from '../src/api';

describe('lessons learned votes client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends PUT to cast a vote using the selected local profile', async () => {
    const response = { lessonId: 42, votesCount: 3, hasVoted: true };
    const adapter = vi.fn().mockResolvedValue({
      data: response,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
    api.defaults.adapter = adapter;

    await expect(castLessonVote('local-contributor', 42)).resolves.toEqual(response);

    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      url: LESSONS_LEARNED_VOTE_PATH.replace('{id}', '42'),
      method: 'put',
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
  });

  it('sends DELETE to remove a vote using the selected local profile', async () => {
    const response = { lessonId: 42, votesCount: 2, hasVoted: false };
    const adapter = vi.fn().mockResolvedValue({
      data: response,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
    api.defaults.adapter = adapter;

    await expect(removeLessonVote('local-pmo', 42)).resolves.toEqual(response);

    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      url: LESSONS_LEARNED_VOTE_PATH.replace('{id}', '42'),
      method: 'delete',
      timeout: LESSONS_LEARNED_API_TIMEOUT_MS,
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-pmo' }),
    }));
  });
});
