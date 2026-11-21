import { RequestMethod, ValidationPipe, type INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createOpenApiDocument } from './openapi-document';
import { ResourceAllocationProblemFilter } from './access/resource-allocation-problem';

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

type Next = () => void;

const correlationIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function configureApp(app: INestApplication) {
  const prefix = 'api/resource-allocation/v1';
  app.enableShutdownHooks();
  const expressApp = app as NestExpressApplication;
  expressApp.set('etag', false);
  expressApp.useBodyParser('json', { type: ['application/json', 'application/merge-patch+json'] });
  app.setGlobalPrefix(prefix, {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      { path: 'health/startup', method: RequestMethod.GET },
    ],
  });
  app.use((request: RequestWithHeaders, response: ResponseWithHeaders, next: Next) => {
    const suppliedId = request.headers['x-correlation-id'];
    const correlationId = typeof suppliedId === 'string' && correlationIdPattern.test(suppliedId)
      ? suppliedId : randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    response.setHeader('X-Correlation-ID', correlationId);
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new ResourceAllocationProblemFilter());

  const document = createOpenApiDocument(app);
  SwaggerModule.setup(`${prefix}/docs`, app, document);
  return document;
}
