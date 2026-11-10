import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

export function createOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('PMO Hub API')
    .setDescription('Local entry and profile endpoints for the PMO Hub.')
    .setVersion('1.0.0')
    .build();

  return SwaggerModule.createDocument(app, config);
}
