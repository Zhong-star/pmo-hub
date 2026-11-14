import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

  return SwaggerModule.createDocument(app, config);
}
