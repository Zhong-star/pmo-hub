# Coding Standards — PMO Hub Monorepo

Judgement-call conventions enforced during `/code-review` across `apps/` and `services/`. Mechanical checks (ESLint, TypeScript, OpenAPI contract drift, and `limit` pagination bounds) live in CI and automated tests.

## React Query & Infinite Lists

- Keep `isFetchNextPageError` localized next to the `Load more` control so already-loaded items stay visible and retryable; gate top-level query error banners with `!isFetchNextPageError`.
- Disable `Load more` while `isFetching` is active or when a background refresh failed (`isError && !isFetchNextPageError`), preventing pagination over stale cursors until the collection refreshes cleanly.

## Cross-Surface Cache & Modal Lifecycle

- Invalidate or update every query surface that renders a mutated entity (collection lists, detail caches, contributor profiles, rankings, dashboards, and `Home` when mutated from `Home` itself — avoid triggering extra access-check `getHome` fetches from unrelated pages).
- Clear active modal state and reload stale-version confirmation dialogs against the query key of the surface that opened the modal (e.g., Library vs. Contributor Profile vs. operational Submissions).

## Forms (`ADR-024`)

- Manage form field values, validation errors, and submission pending state through `react-hook-form` (`useForm`, `handleSubmit`, `formState`) rather than duplicating them in parallel `useState` variables.

## Module Cohesion

- Organize controllers, services, and UI views around cohesive feature verticals. Split a module when unrelated verticals cause repeated edits for separate reasons (*Divergent Change*).

## HTTP & OpenAPI Boundaries

- Pair every database-backed controller with RFC 9457 `application/problem+json` error translation so unexpected persistence failures return structured problem responses without leaking internal details.
- Declare `ETag` response headers in OpenAPI strictly on endpoints whose runtime response emits an `ETag`.
- Preserve backward compatibility explicitly when supporting mixed-version rollouts (e.g., opt-in query parameters or feature-checked responses).
