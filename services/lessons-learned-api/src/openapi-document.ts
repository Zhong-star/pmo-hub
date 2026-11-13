import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function createOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Lessons Learned API')
    .setDescription('Local access and Home endpoints for the Lessons Learned module.')
    .setVersion('1.0.0')
    .build();

  return SwaggerModule.createDocument(app, config);
}
