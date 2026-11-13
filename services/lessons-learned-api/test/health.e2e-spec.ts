import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

type OpenApiContract = {
  paths: Record<
    string,
    {
      get?: {
        security?: Record<string, string[]>[];
        responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
      };
      post?: {
        security?: Record<string, string[]>[];
        requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
        responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string; type?: string; items?: { $ref?: string } } }> }>;
      };
    }
  >;
  components?: {
    schemas?: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
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
    expect(published.body).toEqual(contract);

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

    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('authorizes a Contributor and returns only the Home destination', async () => {
    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/home')
      .set('X-PMO-Local-User-ID', 'local-contributor')
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect({
        profile: {
          id: 'local-contributor',
          displayName: 'Local Contributor',
          role: 'LESSONS_USER',
        },
        navigation: [{ id: 'home', label: 'Home', current: true }],
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
