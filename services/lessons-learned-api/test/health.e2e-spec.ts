import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
        responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
      };
    }
  >;
  components?: {
    schemas?: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
  };
};

describe('Lessons Learned health API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
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

    await request(app.getHttpServer())
      .get('/api/lessons-learned/v1/health')
      .expect(200)
      .expect({ status: 'ok' });
  });
});
