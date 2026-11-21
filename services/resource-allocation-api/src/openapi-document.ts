import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { localProfileChallenge, localProfileHeader } from './access/resource-allocation-problem';

const apiPrefix = '/api/resource-allocation/v1/';
const accessPath = `${apiPrefix}access`;

export function createOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Tech Resource Allocation API')
    .setDescription('Local access and initial API contract for Tech Resource Allocation.')
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: localProfileHeader }, 'localProfile')
    .addTag('Tech Resource Allocation access')
    .addTag('Tech Resource Allocation health')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const accessOperation = document.paths[accessPath]?.get;
  if (accessOperation) {
    for (const parameter of accessOperation.parameters ?? []) {
      if ('name' in parameter && parameter.name === localProfileHeader) parameter.required = false;
    }
    accessOperation.security = [{ localProfile: [] }, {}];
  }

  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!path.startsWith(apiPrefix)) continue;
    for (const operation of Object.values(pathItem)) {
      if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;
      const responses = operation.responses as Record<string, {
        description?: string;
        headers?: Record<string, unknown>;
        content?: Record<string, unknown>;
      }>;
      for (const [status, response] of Object.entries(responses)) {
        const statusCode = Number(status);
        if (statusCode < 400 || statusCode > 599) continue;
        response.content = {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/ResourceAllocationProblemDto' },
          },
        };
        if (statusCode === 401) {
          response.headers = {
            ...response.headers,
            'WWW-Authenticate': { schema: { type: 'string', example: localProfileChallenge } },
          };
        }
      }
    }
  }
  return document;
}
