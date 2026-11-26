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

The worker-operation migration (`2026112100001`) must be applied before starting the worker or its status check. It records each job's latest start and successful cycle, sanitized error class/count, and processed count. Submission claim attempts are also durable so abandoned claims can be identified as retries.

## Prepare the first Admin

Use the Hub profile ID, display name, and email for the first local Admin. This command is repeatable: it inserts one active Admin when none exists, does nothing if an active Admin already exists, and never updates an existing person.

```powershell
$env:RESOURCE_ALLOCATION_FIRST_ADMIN_LOCAL_USER_ID = 'local-developer'
$env:RESOURCE_ALLOCATION_FIRST_ADMIN_DISPLAY_NAME = 'Local Developer'
$env:RESOURCE_ALLOCATION_FIRST_ADMIN_EMAIL = 'local-developer@example.test'
npm run prepare:first-admin --workspace @pmo-hub/resource-allocation-api
```

If that Hub profile is already recorded without an active Admin and no other active Admin exists, preparation stops with an error rather than changing the person. Resolve the existing record through the module's administrative workflow before retrying.

## Prepare minimal operational records

After preparing the first Admin, run the minimal operational baseline command to provision one active group with active Supervisor and Manager coverage, initial resource profiles in that group, one active **ITDM** initiative, and baseline local non-Admin people (`local-supervisor`, `local-pmo` as `ALLOCATION_MANAGER`, `local-moderator` as `ALLOCATION_MODERATOR`, and `local-contributor` as `ALLOCATION_USER`). `local-no-access` is intentionally left unprovisioned, and this command never creates an Admin or demo requests/allocations.

```powershell
npm run prepare:minimal --workspace @pmo-hub/resource-allocation-api
```

This command uses a PostgreSQL advisory lock and lookup-before-insert so repeating it never duplicates records and never overwrites existing or manually edited records. You can customize defaults with optional environment variables before running:

- `RESOURCE_ALLOCATION_MINIMAL_GROUP_NAME` (default: `Platform Engineering`)
- `RESOURCE_ALLOCATION_MINIMAL_PROFILE_NAMES` (comma-separated, default: `Software Engineer,Solutions Architect`)
- `RESOURCE_ALLOCATION_MINIMAL_INITIATIVE_CODE` (default: `ITDM-LOCAL-001`)
- `RESOURCE_ALLOCATION_MINIMAL_INITIATIVE_NAME` (default: `Local Operational Baseline`)
- `RESOURCE_ALLOCATION_MINIMAL_SUPERVISOR_LOCAL_USER_ID`, `RESOURCE_ALLOCATION_MINIMAL_SUPERVISOR_DISPLAY_NAME`, `RESOURCE_ALLOCATION_MINIMAL_SUPERVISOR_EMAIL` (defaults: `local-supervisor`, `Local Group Supervisor`, `local-supervisor@example.test`)
- `RESOURCE_ALLOCATION_MINIMAL_MANAGER_LOCAL_USER_ID`, `RESOURCE_ALLOCATION_MINIMAL_MANAGER_DISPLAY_NAME`, `RESOURCE_ALLOCATION_MINIMAL_MANAGER_EMAIL` (defaults: `local-pmo`, `Local PMO`, `local-pmo@example.test`)
- `RESOURCE_ALLOCATION_MINIMAL_MODERATOR_LOCAL_USER_ID`, `RESOURCE_ALLOCATION_MINIMAL_MODERATOR_DISPLAY_NAME`, `RESOURCE_ALLOCATION_MINIMAL_MODERATOR_EMAIL` (defaults: `local-moderator`, `Local Group Moderator`, `local-moderator@example.test`)
- `RESOURCE_ALLOCATION_MINIMAL_USER_LOCAL_USER_ID`, `RESOURCE_ALLOCATION_MINIMAL_USER_DISPLAY_NAME`, `RESOURCE_ALLOCATION_MINIMAL_USER_EMAIL` (defaults: `local-contributor`, `Local Contributor`, `local-contributor@example.test`)

If the configured Supervisor or Manager Hub profile is already recorded with an incompatible role or inactive status and no other active record exists for that role, preparation stops with an error while leaving the existing record untouched.

## Prepare optional demo data

To explore populated request queues, submission recovery, decisions, allocations, and notifications locally, run the separate optional demo preparation command:

```powershell
npm run prepare:demo --workspace @pmo-hub/resource-allocation-api
```

Demo data is strictly isolated from minimal preparation and is never executed during migrations, API startup, `prepare:first-admin`, or `prepare:minimal`. When invoked, it seeds demo ITDM initiatives (`ITDM-DEMO-001`, `ITDM-DEMO-002`), illustrative submissions (including a failed line for recovery), requests across `WAITING_FOR_PRESENTATION`, `PENDING_TEAM_DECISION`, `APPROVED_WITH_CHANGES`, `APPROVED`, `DENIED`, `PRE_N3`, `ESCALATION`, `REQUIRES_REVALIDATION`, and `CANCELLED`, allocations in `IN_PROGRESS`, `NOT_STARTED`, `SUSPENDED`, and `DONE`, request/allocation history events, and notifications. Like `prepare:minimal`, it uses a PostgreSQL advisory lock and lookup-before-insert so re-running never duplicates records or overwrites manual edits or workflow transitions.

Optional environment variables:

- `RESOURCE_ALLOCATION_DEMO_INITIATIVE_PRIMARY_CODE`, `RESOURCE_ALLOCATION_DEMO_INITIATIVE_PRIMARY_NAME` (defaults: `ITDM-DEMO-001`, `Demo Cloud Modernization`)
- `RESOURCE_ALLOCATION_DEMO_INITIATIVE_SECONDARY_CODE`, `RESOURCE_ALLOCATION_DEMO_INITIATIVE_SECONDARY_NAME` (defaults: `ITDM-DEMO-002`, `Demo Platform Reliability`)

## Prepare volume data for performance measurement

`prepare:volume` fills a migrated database with a realistic, domain-valid volume for performance measurement. It writes directly to the module database in one transaction, on top of the minimal baseline (it prepares the baseline when missing, like `prepare:demo`), and holds the administrative write lock while it runs. It never runs during migrations, API startup, or the other preparation commands.

```powershell
npm run prepare:volume --workspace @pmo-hub/resource-allocation-api
```

Optional environment variables:

- `RESOURCE_ALLOCATION_VOLUME_PEOPLE` (default: `336`; at least one Admin, the leadership, one Moderator and one User per group)
- `RESOURCE_ALLOCATION_VOLUME_GROUPS` (default: `30`, from 1 to 200)
- `RESOURCE_ALLOCATION_VOLUME_MONTHS` (default: `12`, from 1 to 36) of request and allocation history; allocations also extend 75 days ahead
- `RESOURCE_ALLOCATION_VOLUME_SEED` (default: `pmo-hub-volume`)

The same seed, parameters, and São Paulo business date produce the same records, including their IDs. A different seed produces a different dataset. The command refuses to run, changes nothing, and exits with status `1` when it finds a previous volume dataset (`volume-*` local profile IDs, `Volume Group *` groups, or `ITDM-VOL-*` initiatives). To generate it again, start from a newly migrated database.

The dataset follows the domain rules:

- One role per person: one Admin, one Manager per 10 groups, one Supervisor per 5 groups, one Moderator per group, and the remaining people as Users spread across the groups. Every active group has a Supervisor and a Manager that cover it.
- Each group has three active resource profiles and FTE capacity entries by group, profile, and classification (`INTERNAL`, `THIRD_PARTY`), with an entry in force from the start of the period and some later changes, including future ones.
- Allocations use people and profiles active in the allocation group, weekly hours above zero and up to 40 with one decimal place, and Vacation at 40 hours without a profile. Initiative work comes from approved requests or direct allocations; operational work comes from self or direct allocations. States follow the dates: `DONE` or `CANCELED` in the past, `IN_PROGRESS` today, `NOT_STARTED` in the future, with some `SUSPENDED` and `ALLOCATED_WITHOUT_ACTION`.
- Requests in every decision state. The open ones are recent and inside the deadlines that the worker enforces: 3 `WAITING_FOR_PRESENTATION` and 3 `PENDING_TEAM_DECISION` per group, plus `APPROVED_WITH_CHANGES`, `DENIED`, `PRE_N3`, `ESCALATION`, and `REQUIRES_REVALIDATION`. Requesters are Users from another group, so an Admin or the group leadership can approve them. Requested periods start 14 to 60 days ahead.
- Request and allocation history events, and notifications. Notifications older than 7 days are marked as read.

The command prints the counts read back from the database, by role, decision state, allocation state, and origin. It also prints the identities a measurement uses, followed by a `VOLUME_DATASET_SUMMARY` JSON line:

- `volume-admin`: an Admin with every `WAITING_FOR_PRESENTATION` request in the presentation queue.
- `volume-manager-01`: a Manager who covers `Volume Group 01` to `Volume Group 10`, with their `PENDING_TEAM_DECISION` requests in the group decision queue and their weekly capacity comparison.
- `volume-moderator-01` and `volume-user-0001`: a Moderator and a User of `Volume Group 01` with allocations across the period. The Moderator is on Vacation in the current week.

Open requests are dated relative to the day of generation. Waiting reminders start after 7 days and changed proposals are confirmed automatically after 72 hours, so measure on the day you generate the dataset.

### Run against the kind PostgreSQL

The kind deployment from `node infrastructure/kubernetes/local/deploy.mjs backend --with-postgres` creates the `resource-allocation-postgres` StatefulSet and Secret, applies the migrations, and prepares the first Admin. Use one of the following options against that database. Both run the same command.

Through a port-forward, from the monorepo root, keep this command running:

```powershell
kubectl --context kind-pmo-hub -n pmo-hub port-forward service/resource-allocation-postgres 5435:5432
```

In a second terminal, run:

```powershell
$password = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((kubectl --context kind-pmo-hub -n pmo-hub get secret resource-allocation-postgres -o jsonpath='{.data.password}')))
$env:RESOURCE_ALLOCATION_DATABASE_URL = "postgresql://resource_allocation:$password@127.0.0.1:5435/resource_allocation"
npm run prepare:volume --workspace @pmo-hub/resource-allocation-api
```

As a Job in the cluster, with the deployed API image (it must include this command):

```powershell
$image = kubectl --context kind-pmo-hub -n pmo-hub get deployment resource-allocation-api -o jsonpath='{.spec.template.spec.containers[0].image}'
@"
{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"resource-allocation-prepare-volume"},
 "spec":{"backoffLimit":0,"activeDeadlineSeconds":300,"template":{"spec":{"restartPolicy":"Never","containers":[{
  "name":"prepare-volume","image":"$image","imagePullPolicy":"Never","command":["node","dist/database/prepare-volume-data.js"],
  "env":[{"name":"RESOURCE_ALLOCATION_DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"resource-allocation-postgres","key":"url"}}}]}]}}}}
"@ | kubectl --context kind-pmo-hub -n pmo-hub create -f -
kubectl --context kind-pmo-hub -n pmo-hub wait --for=condition=complete job/resource-allocation-prepare-volume --timeout=300s
kubectl --context kind-pmo-hub -n pmo-hub logs job/resource-allocation-prepare-volume
kubectl --context kind-pmo-hub -n pmo-hub delete job resource-allocation-prepare-volume
```

To change the parameters in the Job, add `RESOURCE_ALLOCATION_VOLUME_*` entries to `env`. If the Job fails, its log shows the reason, for example an existing volume dataset.

## Commands

- `npm run build --workspace @pmo-hub/resource-allocation-api` builds the API.
- `npm run openapi:generate --workspace @pmo-hub/resource-allocation-api` generates `openapi/resource-allocation-v1.json` from Nest Swagger decorators and response DTOs.
- `npm run migration:run --workspace @pmo-hub/resource-allocation-api` applies pending TypeORM migrations explicitly.
- `npm run prepare:first-admin --workspace @pmo-hub/resource-allocation-api` safely prepares the first Admin after migration.
- `npm run prepare:minimal --workspace @pmo-hub/resource-allocation-api` idempotently prepares minimal operational baseline records (active group, initial resource profiles, ITDM, and basic local roles) without overwriting manual edits.
- If existing baseline references are inactive and no active compatible alternative exists, `prepare:minimal` writes an explicit non-operational baseline diagnostic to stderr and preserves the records; it exits with status 1 so automation can detect that the baseline is not operational. The programmatic result exposes `operational: false` and the `diagnostics` array.
- `npm run prepare:demo --workspace @pmo-hub/resource-allocation-api` optionally and idempotently prepares a separate illustrative demo dataset across request and allocation lifecycle stages.
- `npm run prepare:volume --workspace @pmo-hub/resource-allocation-api` generates the deterministic volume dataset for performance measurement once per database (see [Prepare volume data for performance measurement](#prepare-volume-data-for-performance-measurement)).
- `npm run worker --workspace @pmo-hub/resource-allocation-api` runs the background worker. Every ten seconds it independently processes submissions, Waiting reminders/expiration, Denied expiration, changed-proposal reminders/deadlines, and São Paulo allocation lifecycle changes. A failing job does not stop the other jobs. Submission claims abandoned for at least a minute are recovered.
- `npm run worker:once --workspace @pmo-hub/resource-allocation-api` processes one batch for each job and exits. The workspace alias `npm run resource-allocation:worker` starts the background worker from the monorepo root.
- `npm run worker:status --workspace @pmo-hub/resource-allocation-api` prints a local JSON operational check and returns exit code `1` if any job has not succeeded in the last 60 seconds, has a due item older than 60 seconds, has a recent cycle error, or has never completed a cycle. It includes per-job due count, age of the oldest due item, retry count, successful cycle time, error count, and the last sanitized error class. Retry count means items still due after at least one worker interval; for submissions, it counts lines claimed more than once. It reads PostgreSQL directly and adds no API route or product dashboard.
- `npm run test --workspace @pmo-hub/resource-allocation-api` validates the generated contract.
- `npm run test:integration --workspace @pmo-hub/resource-allocation-api` runs Supertest against PostgreSQL 17 in Testcontainers; Docker is required.

Health routes are `GET /health/live`, `/health/ready`, and `/health/startup`. These routes report API process/dependency/migration health independently of the worker. Use `worker:status` for processing health. Swagger UI is available at `/api/resource-allocation/v1/docs`.

## Request consultation scope

`GET /requests` defaults to the current person's own operational requests. Leadership can opt into `GET /requests?scope=visible`; Admins use the same opt-in for the global operational list. The API resolves each request's current group against the caller's current module role and group assignment: Moderators see their group, Supervisors and Managers see covered groups, and Admins see all groups. The scope applies across operational decision states, including denied, approved with changes, approved, and cancelled requests. A user role cannot request the visible scope.

The same current scope authorizes `GET /requests/{id}` and `GET /requests/{id}/history`. A non-owner can consult those records but receives no requester actions in `availableActions`; requester edits, withdrawal, acceptance, contest, and denial cancellation remain owner-only. Reads of removed-request audit records stay restricted to the requester and Admin. The browser's My requests view remains the default and offers a view switch to leadership and Admin profiles.

The local Kubernetes backend release includes a separate `resource-allocation-worker` Deployment that reuses the API image and database secret. It has no Service or API health probe. Without `--with-postgres`, the Deployment stays at zero replicas; the release and rollback continue to manage the API and worker together.
