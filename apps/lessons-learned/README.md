# Lessons Learned frontend

Independent React and Vite workspace for the technical Lessons Learned screen. Vite serves the app under `/lessons-learned/`, uses strict loopback port `5174`, and proxies `/api/lessons-learned/v1` to the local API on port `3002`.

From the monorepo root, use:

```powershell
npm run dev --workspace @pmo-hub/lessons-learned
npm run openapi:generate --workspace @pmo-hub/lessons-learned
npm run typecheck --workspace @pmo-hub/lessons-learned
npm run lint --workspace @pmo-hub/lessons-learned
npm run test --workspace @pmo-hub/lessons-learned
npm run build --workspace @pmo-hub/lessons-learned
```

Open `http://127.0.0.1:5174/lessons-learned/` while the API is running. `openapi:generate` reads the versioned contract at `services/lessons-learned-api/openapi/lessons-learned-v1.json`, emits TypeScript contract types, then generates the Axios health client.
