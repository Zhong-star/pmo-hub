import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

describe('Hub entry API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports that the Hub API is available', async () => {
    await request(app.getHttpServer())
      .get('/api/hub/v1/status')
      .expect(200)
      .expect({ status: 'available' });
  });

  it('lists only public fields for configured local profiles', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/hub/v1/local-users')
      .expect(200);

    expect(response.body).toEqual([{ id: 'local-developer', displayName: 'Local Developer' }]);
  });

  it('validates an existing local profile by id', async () => {
    await request(app.getHttpServer())
      .get('/api/hub/v1/local-users/local-developer')
      .expect(200)
      .expect({ id: 'local-developer', displayName: 'Local Developer' });
  });

  it('returns not found for a removed or unknown local profile', async () => {
    await request(app.getHttpServer())
      .get('/api/hub/v1/local-users/unknown')
      .expect(404);
  });
});
