// The single place where the integrations module plugs into the core (I1-I5). The core owns
// authentication, tenancy, audit, leads and the CRM; an integration only needs to:
//   - register its routers in mountIntegrations() (webhooks are public: authenticate them by signature;
//     the raw request body is available as req.rawBody for signature checks),
//   - optionally return background jobs from integrationTicks() (retries, alert sender), run by the worker each tick.
// Shared building blocks are in ./core.ts (encrypted secrets, connections, sync history, processOnce()).
import type { Express } from "express";
import type { IntegrationContext } from "./core.ts";
import { dispatchResendEscalationAlerts, resendWebhookRouter } from "./resend.ts";
import { googleCalendarOAuthRouter } from "./google-calendar.ts";

export function mountIntegrations(app: Express, ctx: IntegrationContext): void {
  app.use("/api/v1/webhooks/resend", resendWebhookRouter(ctx));
  app.use(
    "/api/v1/integrations/google/calendar",
    googleCalendarOAuthRouter(ctx),
  );
}

export function integrationTicks(
  ctx: IntegrationContext,
): Array<() => Promise<void> | void> {
  return [() => dispatchResendEscalationAlerts(ctx)];
}
