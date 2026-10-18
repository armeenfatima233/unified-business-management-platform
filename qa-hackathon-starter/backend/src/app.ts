// Express app factory. Kept separate from server.ts so tests can build an app
// against a temporary database without binding the real port.
import cookieParser from "cookie-parser";
import { randomBytes } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Db } from "./db.ts";
import type { FetchLike, IntegrationContext } from "./integrations/core.ts";
import { authRouter } from "./auth/routes.ts";
import { apiError } from "./middleware/requireAuth.ts";
import { HttpError } from "./http.ts";
import { cors, csrfGuard, securityHeaders } from "./middleware/cors.ts";
import { invitationAcceptRouter, membersRouter } from "./members/routes.ts";
import { setSessionCookie } from "./auth/sessions.ts";
import { auditRouter } from "./audit/audit.ts";
import { alertsRouter } from "./integrations/alerts.ts";
import { dashboardRouter } from "./dashboard/routes.ts";
import { eventsRouter } from "./events/bus.ts";
import { leadSettingsRouter, leadsRouter, publicLeadsRouter } from "./leads/routes.ts";
import { handleAvailabilityChange } from "./leads/service.ts";
import { companiesRouter, contactsRouter } from "./crm/contacts.ts";
import { customFieldsRouter, pipelinesRouter, stagesRouter } from "./crm/config.ts";
import { opportunitiesRouter, savedFiltersRouter } from "./crm/opportunities.ts";

declare module "express-serve-static-core" {
  interface Request {
    rawBody?: Buffer; // exact bytes received, for webhook signature checks (Svix, Stripe, Twilio)
  }
}

export interface AppOptions {
  cookieSecure?: boolean;
  corsOrigins?: string[];
  // How the integrations module attaches itself (see src/integrations/index.ts).
  integrations?: { mount?: (app: Express, ctx: IntegrationContext) => void; secretsKey?: Buffer; publicBaseUrl?: string; frontendUrl?: string; fetch?: FetchLike };
}

export function createApp(db: Db, opts: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  // Small body limit: the API only takes tiny JSON payloads (Q3).
  app.use(securityHeaders);
  app.use(cors(opts.corsOrigins ?? []));
  app.use(csrfGuard(opts.corsOrigins ?? []));
  const keepRawBody = (req: Request, _res: Response, buf: Buffer) => { req.rawBody = buf; };
  app.use(express.json({ limit: "256kb", verify: keepRawBody }));
  app.use(express.urlencoded({ extended: false, limit: "256kb", verify: keepRawBody })); // form-encoded provider webhooks
  app.use(cookieParser());

  app.get("/api/v1/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  const cookieSecure = opts.cookieSecure ?? false;
  app.use("/api/v1/auth", authRouter(db, { cookieSecure }));
  app.use("/api/v1/auth", invitationAcceptRouter(db, (res, token, expiresAt) => setSessionCookie(res, token, expiresAt, cookieSecure)));
  app.use("/api/v1/members", membersRouter(db, (workspaceId, userId, availability) => handleAvailabilityChange(db, workspaceId, userId, availability)));
  app.use("/api/v1/audit-events", auditRouter(db));
  app.use("/api/v1/events", eventsRouter(db));
  app.use("/api/v1/contacts", contactsRouter(db));
  app.use("/api/v1/companies", companiesRouter(db));
  app.use("/api/v1/opportunities", opportunitiesRouter(db));
  app.use("/api/v1/pipelines", pipelinesRouter(db));
  app.use("/api/v1/stages", stagesRouter(db));
  app.use("/api/v1/custom-fields", customFieldsRouter(db));
  app.use("/api/v1/saved-filters", savedFiltersRouter(db));
  app.use("/api/v1/dashboard", dashboardRouter(db));
  app.use("/api/v1", alertsRouter(db));
  app.use("/api/v1/leads", leadsRouter(db));
  app.use("/api/v1/settings", leadSettingsRouter(db));
  app.use("/api/v1/public", publicLeadsRouter(db));

  const ctx: IntegrationContext = {
    db,
    fetch: opts.integrations?.fetch ?? ((url, init) => fetch(url, init)),
    secretsKey: opts.integrations?.secretsKey ?? randomBytes(32),
    publicBaseUrl: opts.integrations?.publicBaseUrl ?? "http://localhost:8080",
    frontendUrl: opts.integrations?.frontendUrl ?? opts.corsOrigins?.[0] ?? "http://localhost:3000",
  };
  app.locals.integrationContext = ctx;
  opts.integrations?.mount?.(app, ctx); // integration routes are registered before the catch-all 404 below

  app.use((_req, res) => apiError(res, 404, "NOT_FOUND", "Route not found."));

  // Last-resort handler: malformed JSON is the client's fault (400); anything
  // else is logged server-side and returned without internals (Q10).
  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.type === "entity.too.large") return apiError(res, 413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    if (err.type === "entity.parse.failed") return apiError(res, 400, "INVALID_JSON", "Malformed JSON body.");
    console.error(err);
    apiError(res, 500, "INTERNAL_ERROR", "Something went wrong.");
  });
  return app;
}
