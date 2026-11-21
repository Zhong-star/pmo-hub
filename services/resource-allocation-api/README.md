# Tech Resource Allocation API

NestJS access API and PostgreSQL-owned persistence for Tech Resource Allocation. The first API contract resolves the Hub's selected local profile against the module's own person record. A Hub selection alone never grants module access.

The API listens on `127.0.0.1:3003` by default. It reads `X-PMO-Local-User-ID` as an opaque Hub profile ID and returns the module person, role, and covered group IDs only when that person is active. Missing profile IDs return `401`; unknown or inactive profiles return `403` with active Admin names and emails. Responses use `application/problem+json` for errors and `Cache-Control: no-store`.

Local profile selection is simulated identity, not production authentication. It is enabled by default outside `NODE_ENV=production`. Set `RESOURCE_ALLOCATION_LOCAL_AUTH_ENABLED=true` only for an isolated local ingress or container deployment, including the local Kubernetes gateway. Leave it unset or set it to `false` in production; the production default is disabled.

## Local PostgreSQL

Copy `.env.example` to `.env`, then start the dedicated database:

```powershell
Copy-Item services/resource-allocation-api/.env.example services/resource-allocation-api/.env
docker compose --env-file services/resource-allocation-api/.env -f services/resource-allocation-api/compose.yaml up -d --wait
$env:RESOURCE_ALLOCATION_DATABASE_URL = 'postgresql://resource_allocation:resource_allocation_dev@127.0.0.1:5434/resource_allocation'
npm run migration:run --workspace @pmo-hub/resource-allocation-api
```

Migrations are explicit. API startup does not synchronize the schema or apply migrations. `/health/startup` returns `503` until the database is reachable and every configured migration is already recorded; the check reads the migration ledger without creating it.

## Prepare the first Admin

Use the Hub profile ID, display name, and email for the first local Admin. This command is repeatable: it inserts one active Admin when none exists, does nothing if an active Admin already exists, and never updates an existing person.

```powershell
$env:RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID = 'local-developer'
$env:RESOURCE_ALLOCATION_FIRST_ADMIN_DISPLAY_NAME = 'Local Developer'
$env:RESOURCE_ALLOCATION_FIRST_ADMIN_EMAIL = 'local-developer@example.test'
npm run prepare:first-admin --workspace @pmo-hub/resource-allocation-api
```

If that Hub profile is already recorded without an active Admin and no other active Admin exists, preparation stops with an error rather than changing the person. Resolve the existing record through the module's administrative workflow before retrying.

## Commands

- `npm run build --workspace @pmo-hub/resource-allocation-api` builds the API.
- `npm run openapi:generate --workspace @pmo-hub/resource-allocation-api` generates `openapi/resource-allocation-v1.json` from Nest Swagger decorators and response DTOs.
- `npm run migration:run --workspace @pmo-hub/resource-allocation-api` applies pending TypeORM migrations explicitly.
- `npm run prepare:first-admin --workspace @pmo-hub/resource-allocation-api` safely prepares the first Admin after migration.
- `npm run worker --workspace @pmo-hub/resource-allocation-api` runs the submission processor in the background; it polls durable rows every ten seconds and recovers claims abandoned for at least a minute.
- `npm run worker:once --workspace @pmo-hub/resource-allocation-api` processes one batch and exits. The workspace alias `npm run resource-allocation:worker` starts the background worker from the monorepo root.
- `npm run test --workspace @pmo-hub/resource-allocation-api` validates the generated contract.
- `npm run test:integration --workspace @pmo-hub/resource-allocation-api` runs Supertest against PostgreSQL 17 in Testcontainers; Docker is required.

Health routes are `GET /health/live`, `/health/ready`, and `/health/startup`. Swagger UI is available at `/api/resource-allocation/v1/docs`.
