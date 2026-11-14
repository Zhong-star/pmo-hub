import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  cancelLesson,
  getHealth,
  getHome,
  getMyOpenDrafts,
  getMySubmissions,
  getPmoDrafts,
  getLessonDetails,
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
  LESSONS_LEARNED_CANCEL_PATH,
  LESSONS_LEARNED_SUBMISSIONS_PATH,
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

  it('retrieves own Open and Archived submissions and posts an explicit cancellation', async () => {
    const archived = {
      id: 7,
      title: 'Improve release handover',
      authorId: 'local-contributor',
      updatedBy: 'local-contributor',
      status: 'Archived' as const,
      version: 2,
      projectId: null,
      projectName: null,
      projectCategory: null,
      projectPhase: null,
      situationObserved: null,
      rootCause: null,
      lessonType: null,
      impact: null,
      recommendation: null,
      applicability: null,
      createdAt: '2026-11-13T12:00:00.000Z',
      updatedAt: '2026-11-13T12:05:00.000Z',
    };
    const body = { version: 1, reason: 'The project scope changed.' };
    const adapter = vi.fn()
      .mockResolvedValueOnce({ data: [archived], status: 200, statusText: 'OK', headers: {}, config: {} })
      .mockResolvedValueOnce({ data: archived, status: 200, statusText: 'OK', headers: {}, config: {} });
    api.defaults.adapter = adapter;

    await expect(getMySubmissions('local-contributor')).resolves.toEqual([archived]);
    await expect(cancelLesson('local-contributor', 7, body)).resolves.toEqual(archived);

    expect(adapter).toHaveBeenNthCalledWith(1, expect.objectContaining({
      url: LESSONS_LEARNED_SUBMISSIONS_PATH,
      method: 'get',
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
    expect(adapter).toHaveBeenNthCalledWith(2, expect.objectContaining({
      url: LESSONS_LEARNED_CANCEL_PATH.replace('{id}', '7'),
      method: 'post',
      data: JSON.stringify(body),
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
  });

  it('serializes combined My Submissions filters and retrieves detail history through the protected lesson route', async () => {
    const filters = {
      search: 'Improve',
      projectId: 'none',
      lessonType: 'Communication' as const,
      status: 'Archived' as const,
    };
    const details = {
      id: 9,
      title: 'Improve release handover',
      authorId: 'local-contributor',
      updatedBy: 'local-contributor',
      status: 'Archived' as const,
      version: 2,
      projectId: null,
      projectName: null,
      projectCategory: 'Technology' as const,
      projectPhase: 'Execution' as const,
      situationObserved: 'The release handover lacked the latest runbook.',
      rootCause: null,
      lessonType: 'Communication' as const,
      impact: 'Operators repeated verification work.',
      recommendation: 'Share the runbook before release.',
      applicability: 'Use for releases with an operations handover.',
      createdAt: '2026-11-13T12:00:00.000Z',
      updatedAt: '2026-11-13T12:05:00.000Z',
      history: [{
        id: 1,
        actorId: 'local-contributor',
        eventType: 'Cancelled' as const,
        previousStatus: 'Open' as const,
        newStatus: 'Archived' as const,
        reason: 'The project scope changed.',
        occurredAt: '2026-11-13T12:05:00.000Z',
      }],
    };
    const adapter = vi.fn()
      .mockResolvedValueOnce({ data: [details], status: 200, statusText: 'OK', headers: {}, config: {} })
      .mockResolvedValueOnce({ data: details, status: 200, statusText: 'OK', headers: {}, config: {} });
    api.defaults.adapter = adapter;

    await expect(getMySubmissions('local-contributor', filters)).resolves.toEqual([details]);
    await expect(getLessonDetails('local-contributor', 9)).resolves.toEqual(details);

    expect(adapter).toHaveBeenNthCalledWith(1, expect.objectContaining({
      url: LESSONS_LEARNED_SUBMISSIONS_PATH,
      method: 'get',
      params: filters,
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
    expect(adapter).toHaveBeenNthCalledWith(2, expect.objectContaining({
      url: LESSONS_LEARNED_DRAFT_PATH.replace('{id}', '9'),
      method: 'get',
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-contributor' }),
    }));
  });

  it('requests PMO Drafts with its combined filters and moderator profile', async () => {
    const filters = {
      search: 'Deploy',
      authorId: 'local-contributor',
      projectId: 'LOCAL-PROJECT-001',
      lessonType: 'Communication' as const,
      status: 'Open' as const,
    };
    const adapter = vi.fn().mockResolvedValue({
      data: [],
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
    api.defaults.adapter = adapter;

    await expect(getPmoDrafts('local-pmo', filters)).resolves.toEqual([]);

    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      url: '/api/lessons-learned/v1/lessons/pmo-drafts',
      method: 'get',
      params: filters,
      headers: expect.objectContaining({ 'X-PMO-Local-User-ID': 'local-pmo' }),
    }));
  });
});
