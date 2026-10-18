// The single place where the integrations module plugs into the core (I1-I5). The core owns
// authentication, tenancy, audit, leads and the CRM; an integration only needs to:
//   - register its routers in mountIntegrations() (webhooks are public: authenticate them by signature;
//     the raw request body is available as req.rawBody for signature checks),
//   - optionally return background jobs from integrationTicks() (retries, alert sender), run by the worker each tick.
// Shared building blocks are in ./core.ts (encrypted secrets, connections, sync history, processOnce()).
import type { Express } from "express";
import type { IntegrationContext } from "./core.ts";

export function mountIntegrations(_app: Express, _ctx: IntegrationContext): void {
  // e.g. app.use("/api/v1/webhooks/resend", resendWebhookRouter(ctx));
  //      app.use("/api/v1", googleCalendarRouter(ctx));
}

export function integrationTicks(_ctx: IntegrationContext): Array<() => Promise<void> | void> {
  return []; // e.g. [() => dispatchAlerts(ctx), () => retryDueMessages(ctx)]
}
