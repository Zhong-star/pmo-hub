import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, getSchemaPath, SwaggerModule } from '@nestjs/swagger';
import { LessonProblem } from './lessons/lesson-http-contract';
import { localProfileHeader, localProfileScheme } from './local-access-problem';

export function createOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Lessons Learned API')
    .setDescription('Local access, Home, and draft registration endpoints for the Lessons Learned module.')
    .setVersion('1.0.0')
    .addApiKey({
      type: 'apiKey', in: 'header', name: localProfileHeader,
      description: 'Simulated local Hub profile ID. The API resolves the module role.',
    }, localProfileScheme)
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const problemCollections = [
    '/api/lessons-learned/v1/lessons',
    '/api/lessons-learned/v1/pmo',
  ];
  for (const [path, routes] of Object.entries(document.paths)) {
    if (!problemCollections.some((collection) => path === collection || path.startsWith(`${collection}/`))) continue;
    for (const operation of [routes.get, routes.patch, routes.post, routes.put, routes.delete]) {
      if (!operation) continue;
      for (const [code, response] of Object.entries(operation.responses)) {
        if (!response || '$ref' in response) continue;
        if (Number(code) >= 400) {
          if (code !== '401' && !response.content?.['application/json'] && !response.content?.['application/problem+json']) {
            response.content = { 'application/json': { schema: { type: 'object', properties: {
              statusCode: { type: 'integer' }, code: { type: 'string' },
              message: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
            } } } };
          }
          response.content = {
            ...response.content,
            'application/problem+json': { schema: { $ref: getSchemaPath(LessonProblem) } },
          };
        } else if (path.includes('/{id}') || code === '201') {
          response.headers = {
            ...response.headers,
            ETag: { description: 'ETag for the returned lesson version.', schema: { type: 'string' } },
          };
        }
      }
    }
  }
  return document;
}
