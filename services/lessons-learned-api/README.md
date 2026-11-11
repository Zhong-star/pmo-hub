# Lessons Learned API

NestJS API for the local Lessons Learned module. Start the service from this directory so its versioned OpenAPI artifact is written to the module-owned `openapi/` directory.

The API listens on `127.0.0.1:3002` by default. Set `HOST` or `PORT` to override those local development defaults.

## Commands

- `npm run build` builds the service with TypeScript.
- `npm run start` starts the built API.
- `npm run openapi:generate` builds the NestJS Swagger document and writes `openapi/lessons-learned-v1.json`.
- `npm test` runs the Supertest health endpoint and published contract test.
- `npm run typecheck` checks source and test types.
- `npm run lint` lints source and test files.
- `npm run migration:run` builds the service and applies pending TypeORM migrations to the configured database.
- `npm run test:integration` runs PostgreSQL integration tests in a disposable Testcontainers database; Docker is required.

## Local PostgreSQL

The API connects to PostgreSQL only when `LESSONS_LEARNED_DATABASE_URL` is set. Without it, the API and health endpoint work without opening a database connection. TypeORM schema synchronization and migration-on-startup are disabled; migrations run only through the explicit command above.

From this directory, copy `.env.example` to `.env`, then start the module-owned development database and apply migrations:

```powershell
Copy-Item .env.example .env
docker compose up -d --wait
$env:LESSONS_LEARNED_DATABASE_URL = 'postgresql://lessons_learned:lessons_learned_dev@127.0.0.1:5433/lessons_learned'
npm run migration:run
npm run start
```

Compose reads `.env` for its container settings; set `LESSONS_LEARNED_DATABASE_URL` in the shell separately for the API and migration command. Update the connection URL if you change the Compose database credentials or port. The Compose service publishes PostgreSQL on `127.0.0.1:5433` and keeps its data in a dedicated Docker volume. The initial migrations directory is intentionally empty; the migration command should complete successfully until a business flow needs its first table. Use `docker compose down` to stop the database. Use `docker compose down --volumes` only when you also want to delete its local data.

The health endpoint is `GET /api/lessons-learned/v1/health` and returns `{ "status": "ok" }`. Swagger UI is served at `/api/lessons-learned/v1/docs`.
