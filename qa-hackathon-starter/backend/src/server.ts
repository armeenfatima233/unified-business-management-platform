// Entry point. Configuration comes from environment variables (Q13); see .env.example.
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { integrationTicks, mountIntegrations } from "./integrations/index.ts";
import { loadSecretsKey } from "./integrations/key.ts";
import type { IntegrationContext } from "./integrations/core.ts";
import { startWorker } from "./leads/worker.ts";

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.DB_PATH ?? "./data/app.db";

const db = openDb(dbPath);
const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((o) => o.trim()).filter(Boolean);
const app = createApp(db, {
  cookieSecure: process.env.COOKIE_SECURE === "true",
  corsOrigins,
  integrations: {
    mount: mountIntegrations,
    secretsKey: loadSecretsKey(process.env.SECRETS_KEY, dbPath),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    frontendUrl: process.env.FRONTEND_URL ?? corsOrigins[0],
  },
});

// Escalation timers are polled from the database so they survive restarts (Q5). 1s lets a demo use short windows.
startWorker(db, Number(process.env.WORKER_INTERVAL_MS ?? 1000), integrationTicks(app.locals.integrationContext as IntegrationContext));

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port} (db: ${dbPath})`);
});
