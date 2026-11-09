# Hub API

NestJS API for the Hub entry flow. Run the service from this directory so the default local profile configuration at `config/local-users.json` can be found.

Set `HUB_LOCAL_USERS_FILE` to an absolute path or a path relative to the service working directory to use another developer-local profile list. The file is a JSON array of `{ "id": "...", "displayName": "..." }` objects. It is configuration for local development, not an identity or permission store.

The API is available under `/api/hub/v1`; generated Swagger documentation is served at `/api/hub/v1/docs`.
