import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  getHealth,
  getHome,
  getMyOpenDrafts,
  createLessonDraft,
  getLessonProjects,
  updateLessonDraft,
  submitLesson,
  LESSONS_LEARNED_LESSONS_PATH,
  LESSONS_LEARNED_HEALTH_PATH,
  LESSONS_LEARNED_HOME_PATH,
  LESSONS_LEARNED_PROJECTS_PATH,
  LESSONS_LEARNED_DRAFT_PATH,
  LESSONS_LEARNED_SUBMIT_PATH,
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

  it('creates a title-only draft and retrieves the current profile’s open drafts', async () => {
    const draft = {
      id: 7,
      title: 'Improve release handover',
      authorId: 'local-contributor',
      status: 'Open' as const,
      createdAt: '2026-11-13T12:00:00.000Z',
      updatedAt: '2026-11-13T12:00:00.000Z',
    };
    const adapter = vi.fn()
      .mockResolvedValueOnce({ data: draft, status: 201, statusText: 'Created', headers: {}, config: {} })
      .mockResolvedValueOnce({ data: [draft], status: 200, statusText: 'OK', headers: {}, config: {} });
    api.defaults.adapter = adapter;

    await expect(createLessonDraft('local-contributor', 'Improve release handover')).resolves.toEqual(draft);
    await expect(getMyOpenDrafts('local-contributor')).resolves.toEqual([draft]);

    expect(adapter).toHaveBeenNthCalledWith(1, expect.objectContaining({
      url: LESSONS_LEARNED_LESSONS_PATH,
      method: 'post',
      data: JSON.stringify({ title: 'Improve release handover' }),
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
    expect(adapter).toHaveBeenNthCalledWith(2, expect.objectContaining({
      url: LESSONS_LEARNED_LESSONS_PATH,
      method: 'get',
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
  });

  it('loads the local project catalog and updates an Open draft with its expected version', async () => {
    const project = { id: 'LOCAL-PROJECT-001', name: 'Fictional Atlas Modernization' };
    const updated = {
      id: 7,
      title: 'Improve release handover',
      authorId: 'local-contributor',
      updatedBy: 'local-contributor',
      status: 'Open' as const,
      version: 2,
      projectId: project.id,
      projectName: project.name,
      projectCategory: 'Technology' as const,
      projectPhase: 'Execution' as const,
      situationObserved: 'The deployment handover lacked the current runbook.',
      rootCause: null,
      lessonType: null,
      impact: null,
      recommendation: null,
      applicability: null,
      createdAt: '2026-11-13T12:00:00.000Z',
      updatedAt: '2026-11-13T12:05:00.000Z',
    };
    const body = {
      version: 1,
      title: updated.title,
      projectId: project.id,
      projectName: project.name,
      projectCategory: 'Technology' as const,
      projectPhase: 'Execution' as const,
      situationObserved: updated.situationObserved,
    };
    const adapter = vi.fn()
      .mockResolvedValueOnce({ data: [project], status: 200, statusText: 'OK', headers: {}, config: {} })
      .mockResolvedValueOnce({ data: updated, status: 200, statusText: 'OK', headers: {}, config: {} });
    api.defaults.adapter = adapter;

    await expect(getLessonProjects('local-contributor')).resolves.toEqual([project]);
    await expect(updateLessonDraft('local-contributor', 7, body)).resolves.toEqual(updated);

    expect(adapter).toHaveBeenNthCalledWith(1, expect.objectContaining({
      url: LESSONS_LEARNED_PROJECTS_PATH,
      method: 'get',
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
    expect(adapter).toHaveBeenNthCalledWith(2, expect.objectContaining({
      url: LESSONS_LEARNED_DRAFT_PATH.replace('{id}', '7'),
      method: 'patch',
      data: JSON.stringify(body),
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
  });

  it('submits a complete lesson for the selected author profile', async () => {
    const submitted = {
      id: 7,
      title: 'Improve release handover',
      authorId: 'local-contributor',
      updatedBy: 'local-contributor',
      status: 'PMOEvaluation' as const,
      version: 4,
      projectId: null,
      projectName: null,
      projectCategory: 'Technology' as const,
      projectPhase: 'Execution' as const,
      situationObserved: 'The handover omitted the current runbook.',
      rootCause: null,
      lessonType: 'Communication' as const,
      impact: 'Operations followed an outdated procedure.',
      recommendation: 'Share the current runbook before release.',
      applicability: 'Use for releases with an operations handover.',
      createdAt: '2026-11-13T12:00:00.000Z',
      updatedAt: '2026-11-13T12:05:00.000Z',
    };
    const body = {
      version: 3,
      title: submitted.title,
      projectId: null,
      projectName: null,
      projectCategory: 'Technology' as const,
      projectPhase: 'Execution' as const,
      situationObserved: submitted.situationObserved,
      rootCause: null,
      lessonType: 'Communication' as const,
      impact: submitted.impact,
      recommendation: submitted.recommendation,
      applicability: submitted.applicability,
    };
    const adapter = vi.fn().mockResolvedValue({ data: submitted, status: 200, statusText: 'OK', headers: {}, config: {} });
    api.defaults.adapter = adapter;

    await expect(submitLesson('local-contributor', 7, body)).resolves.toEqual(submitted);

    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      url: LESSONS_LEARNED_SUBMIT_PATH.replace('{id}', '7'),
      method: 'post',
      data: JSON.stringify(body),
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
  });
});
