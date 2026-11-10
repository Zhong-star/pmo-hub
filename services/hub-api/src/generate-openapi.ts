import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { createOpenApiDocument } from './openapi-document';
import { LocalUsersService } from './local-users.service';

async function generateOpenApi(): Promise<void> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LocalUsersService)
    .useValue({ list: () => [], findById: () => undefined })
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  try {
    app.setGlobalPrefix('api/hub/v1');
    await app.init();
    const document = createOpenApiDocument(app);
    const outputPath = resolve(process.cwd(), 'openapi/hub-v1.json');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

void generateOpenApi();
