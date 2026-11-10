import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createOpenApiDocument } from './openapi-document';

async function generateOpenApi(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    app.setGlobalPrefix('api/hub/v1');
    const document = createOpenApiDocument(app);
    const outputPath = resolve(process.cwd(), 'openapi/hub-v1.json');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

void generateOpenApi();
