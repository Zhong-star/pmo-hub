import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

function sortOperationParameters(document: OpenAPIObject): OpenAPIObject {
  for (const path of Object.values(document.paths)) {
    for (const operation of [path.get, path.post, path.patch]) {
      operation?.parameters?.sort((left, right) => {
        const parameterKey = (parameter: typeof left) => '$ref' in parameter
          ? parameter.$ref
          : `${parameter.in}:${parameter.name}`;
        return parameterKey(left).localeCompare(parameterKey(right));
      });
    }
  }
  return document;
}

type OpenApiOperationContract = {
  security?: Record<string, string[]>[];
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, {
    headers?: Record<string, unknown>;
    content?: Record<string, { schema?: { $ref?: string; type?: string; items?: { $ref?: string } } }>;
  }>;
};

type OpenApiContract = {
  paths: Record<
    string,
    {
      get?: OpenApiOperationContract;
      post?: OpenApiOperationContract;
      patch?: OpenApiOperationContract;
      put?: OpenApiOperationContract;
      delete?: OpenApiOperationContract;
    }
  >;
  components?: {
    schemas?: Record<string, {
      required?: string[];
      properties?: Record<string, {
        enum?: string[];
        maxLength?: number;
        minimum?: number;
        type?: string;
      }>;
    }>;
  };
};

describe('Lessons Learned health API', () => {
  let app: INestApplication;
  let localProfilesPath: string;
  let temporaryDirectory: string;
  const previousProfilesFile = process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
  const previousLocalAuthEnabled = process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;

  const defaultProfiles = [
    { id: 'local-contributor', displayName: 'Local Contributor', role: 'LESSONS_USER' },
    { id: 'local-pmo', displayName: 'Local PMO', role: 'LESSONS_MODERATOR' },
  ];

  function writeProfiles(profiles: unknown) {
    writeFileSync(localProfilesPath, JSON.stringify(profiles), 'utf8');
  }

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pmo-hub-lessons-learned-'));
    localProfilesPath = join(temporaryDirectory, 'local-users.json');
    writeProfiles(defaultProfiles);
    process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = localProfilesPath;
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (previousProfilesFile === undefined) delete process.env.LESSONS_LEARNED_LOCAL_USERS_FILE;
    else process.env.LESSONS_LEARNED_LOCAL_USERS_FILE = previousProfilesFile;
    if (previousLocalAuthEnabled === undefined) delete process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED;
    else process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = previousLocalAuthEnabled;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('reports the API health using the published response contract', async () => {
    const contract = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/lessons-learned-v1.json'), 'utf8'),
    ) as OpenApiContract;
    const published = await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/docs-json')
      .expect(200)
      .expect('Content-Type', /application\/json/);
    expect(sortOperationParameters(published.body)).toEqual(
      sortOperationParameters(contract as unknown as OpenAPIObject),
    );

    const responseSchemaRef =
      contract.paths['/api/lessons-learned/v1/health']?.get?.responses?.['200']?.content?.[
        'application/json'
      ]?.schema?.$ref;

    expect(responseSchemaRef).toBe('#/components/schemas/HealthResponse');
    expect(contract.components?.schemas?.HealthResponse?.properties?.status?.enum).toEqual(['ok']);
    const home = contract.paths['/api/lessons-learned/v1/home']?.get;
    expect(home?.security).toEqual([{ localProfile: [] }]);
    expect(home?.responses?.['401']?.content?.['application/problem+json']?.schema?.$ref)
      .toBe('#/components/schemas/LocalAccessProblem');

    const lessons = contract.paths['/api/lessons-learned/v1/lessons'];
    expect(lessons?.get?.security).toEqual([{ localProfile: [] }]);
    expect(lessons?.get?.responses?.['200']?.content?.['application/json']?.schema)
      .toMatchObject({ type: 'array', items: { $ref: '#/components/schemas/LessonDraftResponse' } });
    expect(lessons?.post?.security).toEqual([{ localProfile: [] }]);
    expect(lessons?.post?.requestBody?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/CreateLessonRequest');
    expect(lessons?.post?.responses?.['201']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/LessonDraftResponse');

    const projects = contract.paths['/api/lessons-learned/v1/lessons/projects']?.get;
    expect(projects?.security).toEqual([{ localProfile: [] }]);
    expect(projects?.responses?.['200']?.content?.['application/json']?.schema)
      .toMatchObject({ type: 'array', items: { $ref: '#/components/schemas/LessonProjectResponse' } });

    const updateDraft = contract.paths['/api/lessons-learned/v1/lessons/{id}']?.patch;
    expect(updateDraft?.security).toEqual([{ localProfile: [] }]);
    expect(updateDraft?.requestBody?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/UpdateLessonDraftRequest');
    expect(updateDraft?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/LessonDraftResponse');
    expect(updateDraft?.responses?.['409']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/LessonConflictResponse');
    expect(contract.components?.schemas?.LessonConflictResponse?.required).toEqual(['code', 'message']);
    expect(contract.components?.schemas?.LessonConflictResponse?.properties?.code?.enum)
      .toEqual(expect.arrayContaining(['STALE_LESSON_VERSION', 'LESSON_NOT_OPEN', 'LESSON_NOT_AWAITING_EVALUATION']));
    expect(contract.components?.schemas?.LessonConflictResponse?.properties?.message?.type).toBe('string');
    expect(contract.components?.schemas?.UpdateLessonDraftRequest?.properties?.situationObserved?.maxLength)
      .toBe(4000);
    expect(contract.components?.schemas?.UpdateLessonDraftRequest?.properties?.projectCategory?.enum)
      .toEqual(['Technology', 'Business', 'Infrastructure', 'Data']);
    expect(contract.components?.schemas?.LessonDraftResponse?.properties?.version?.minimum).toBe(1);

    expect(lessons?.post?.responses?.['201']?.headers?.ETag).toBeDefined();
    expect(contract.paths['/api/lessons-learned/v1/lessons/{id}']?.get?.responses?.['200']?.headers?.ETag).toBeDefined();
    expect(contract.paths['/api/lessons-learned/v1/lessons/library/{id}']?.get?.responses?.['200']?.headers?.ETag).toBeDefined();
    expect(updateDraft?.responses?.['200']?.headers?.ETag).toBeDefined();
    expect(contract.paths['/api/lessons-learned/v1/lessons/{id}/vote']?.put?.responses?.['200']?.headers?.ETag).toBeUndefined();
    expect(contract.paths['/api/lessons-learned/v1/lessons/{id}/vote']?.delete?.responses?.['200']?.headers?.ETag).toBeUndefined();
    expect(contract.paths['/api/lessons-learned/v1/lessons/{id}/comments']?.get?.responses?.['200']?.headers?.ETag).toBeUndefined();
    expect(contract.paths['/api/lessons-learned/v1/lessons/{id}/comments']?.post?.responses?.['201']?.headers?.ETag).toBeUndefined();
    expect(contract.paths['/api/lessons-learned/v1/lessons/{id}/comments/{commentId}/replies']?.post?.responses?.['201']?.headers?.ETag).toBeUndefined();
    expect(contract.paths['/api/lessons-learned/v1/lessons/{id}/comments/{commentId}/hide']?.post?.responses?.['200']?.headers?.ETag).toBeUndefined();
    expect(contract.paths['/api/lessons-learned/v1/lessons/library/{id}/views']?.post?.responses?.['200']?.headers?.ETag).toBeUndefined();

    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('authorizes a Contributor and returns the role-aware Home payload', async () => {
    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect(({ body }) => {
        expect(body.profile).toEqual({
          id: 'local-contributor',
          displayName: 'Local Contributor',
          role: 'LESSONS_USER',
        });
        expect(body.navigation).toEqual([{ id: 'home', label: 'Home', current: true }]);
        expect(body.notifications).toEqual({ unreadCount: 0, items: [] });
        expect(body.recentWork).toEqual([]);
        expect(body.primaryAction).toMatchObject({ kind: 'create-lesson', targetPage: 'create-lesson', lessonId: null });
        expect((body.shortcuts as { id: string }[]).map((s) => s.id)).toEqual([
          'create-lesson',
          'my-submissions',
          'library',
          'profiles',
        ]);
      });
  });

  it('resolves PMO role from the API configuration', async () => {
    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(200)
      .expect(({ body }) => {
        expect(body.profile).toEqual({
          id: 'local-pmo',
          displayName: 'Local PMO',
          role: 'LESSONS_MODERATOR',
        });
        expect(body.navigation).toEqual([{ id: 'home', label: 'Home', current: true }]);
      });
  });

  it('denies missing identities and Hub profiles without a Lessons Learned role', async () => {
    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-Correlation-ID', '8bbab621-f989-4fd5-9350-2eb1ac41d760')
      .expect(401)
      .expect('WWW-Authenticate', 'LocalProfile realm="Lessons Learned"')
      .expect('X-Correlation-ID', '8bbab621-f989-4fd5-9350-2eb1ac41d760')
      .expect('Content-Type', /application\/problem\+json/)
      .expect({
        type: 'https://pmo-hub.example/problems/authentication-required',
        title: 'Local profile required',
        status: 401,
        detail: 'Select a local Hub profile.',
        instance: '/api/lessons-learned/v1/home',
        code: 'AUTHENTICATION_REQUIRED',
        correlationId: '8bbab621-f989-4fd5-9350-2eb1ac41d760',
      });

    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-no-access')
      .expect(403)
      .expect('Content-Type', /application\/problem\+json/)
      .expect(({ body }) => expect(body).toMatchObject({ status: 403, code: 'ACCESS_DENIED' }));
  });

  it('blocks only an ID with duplicate module profiles and reports a configuration error', async () => {
    writeProfiles([
      ...defaultProfiles,
      { id: 'local-pmo', displayName: 'Duplicate PMO', role: 'LESSONS_USER' },
    ]);

    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-pmo')
      .expect(500)
      .expect(({ body }) => expect(body).toMatchObject({
        status: 500,
        code: 'ACCESS_CONFIGURATION_ERROR',
        detail: 'Lessons Learned access configuration is invalid.',
      }));
  });

  it('revalidates the selected profile on every protected Home request', async () => {
    writeProfiles(defaultProfiles);
    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(200);

    writeProfiles([defaultProfiles[1]]);
    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ status: 403, code: 'ACCESS_DENIED' }));
  });

  it('rejects simulated identity when the runtime explicitly disables local access', async () => {
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'false';
    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect(503)
      .expect(({ body }) => expect(body).toMatchObject({
        status: 503,
        code: 'LOCAL_AUTH_DISABLED',
        detail: 'Local simulated access is not enabled for this runtime.',
      }));
    process.env.LESSONS_LEARNED_LOCAL_AUTH_ENABLED = 'true';
  });
});
