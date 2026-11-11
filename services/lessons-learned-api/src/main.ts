import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createOpenApiDocument } from './openapi-document';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/lessons-learned/v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const openApiDocument = createOpenApiDocument(app);
  SwaggerModule.setup('api/lessons-learned/v1/docs', app, openApiDocument);

  const port = Number(process.env.PORT ?? 3002);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
}

void bootstrap();
