import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function generateOpenApi(): Promise<void> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  try {
    const document = configureApp(app);
    const outputPath = resolve(process.cwd(), 'openapi/lessons-learned-v1.json');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

void generateOpenApi();
