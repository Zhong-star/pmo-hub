import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

const accessPath = '/api/resource-allocation/v1/access';
const localProfileHeader = 'X-PMO-Local-User-ID';

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
  return document;
}
