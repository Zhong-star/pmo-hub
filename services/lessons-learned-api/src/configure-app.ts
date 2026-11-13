import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { createOpenApiDocument } from './openapi-document';

export function configureApp(app: INestApplication) {
  const prefix = 'api/lessons-learned/v1';
  app.enableShutdownHooks();
  app.setGlobalPrefix(prefix);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const document = createOpenApiDocument(app);
  SwaggerModule.setup(`${prefix}/docs`, app, document);
  return document;
}
