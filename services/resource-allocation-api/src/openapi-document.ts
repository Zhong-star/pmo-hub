import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

const accessPath = '/api/resource-allocation/v1/access';
const localProfileHeader = 'X-PMO-Local-User-ID';
const localProfileChallenge = 'LocalProfile realm="Tech Resource Allocation"';

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
    if (!path.startsWith('/api/resource-allocation/v1/admin/') &&
      !path.startsWith('/api/resource-allocation/v1/submissions') &&
      !path.startsWith('/api/resource-allocation/v1/requests') &&
      !path.startsWith('/api/resource-allocation/v1/request-audits') &&
      !path.startsWith('/api/resource-allocation/v1/operation-results/') &&
      !['/api/resource-allocation/v1/people', '/api/resource-allocation/v1/groups',
        '/api/resource-allocation/v1/resource-profiles', '/api/resource-allocation/v1/initiatives'].includes(path)) continue;
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
