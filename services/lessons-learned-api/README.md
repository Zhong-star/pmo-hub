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

The health endpoint is `GET /api/lessons-learned/v1/health` and returns `{ "status": "ok" }`. Swagger UI is served at `/api/lessons-learned/v1/docs`.
