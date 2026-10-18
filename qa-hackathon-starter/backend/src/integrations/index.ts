// The single place where the integrations module plugs into the core (I1-I5). The core owns
// authentication, tenancy, audit, leads and the CRM; an integration only needs to:
//   - register its routers in mountIntegrations() (webhooks are public: authenticate them by signature;
//     the raw request body is available as req.rawBody for signature checks),
//   - optionally return background jobs from integrationTicks() (retries, alert sender), run by the worker each tick.
// Shared building blocks are in ./core.ts (encrypted secrets, connections, sync history, processOnce()).
import type { Express } from "express";
import { createFailureRecorder, createRecipientResolver, dispatchAlerts, type EscalationAlertSender } from "./alerts.ts";
import type { IntegrationContext } from "./core.ts";
import { googleOAuthRouter } from "./googleCalendar.ts";
import { resendSettingsRouter, resendWebhookRouter } from "./resend.ts";
import { integrationsStatusRouter } from "./status.ts";

export function mountIntegrations(app: Express, ctx: IntegrationContext): void {
  app.use("/api/v1/webhooks/resend", resendWebhookRouter(ctx)); // public: authenticated by the Svix signature
  app.use("/api/v1", resendSettingsRouter(ctx)); // connect this workspace's inbox (Admin)
  app.use("/api/v1", googleOAuthRouter(ctx)); // connect / callback / status / disconnect
  app.use("/api/v1", integrationsStatusRouter(ctx)); // central status page + synchronisation history
}

// I4: builds the Resend escalation-alert adapter (integrations/resend) on first use. It is loaded lazily and
// optionally: without RESEND_API_KEY / RESEND_FROM_EMAIL, or if the adapter package is not installed, alerts are
// recorded as failed with a plain explanation (visible to Admins, retryable) instead of breaking anything else (I5.8).
async function loadResendSender(ctx: IntegrationContext): Promise<EscalationAlertSender | null> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    console.warn("[alerts] RESEND_API_KEY / RESEND_FROM_EMAIL not set: escalation emails will be recorded as failed until they are.");
    return null;
  }
  try {
    const dir = new URL("../../../integrations/resend/", import.meta.url);
    const email = await import(new URL("resend-email-adapter.ts", dir).href);
    const alerts = await import(new URL("escalation-alert-adapter.ts", dir).href);
    const sender = email.createResendEmailAdapter({
      apiKey,
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET || "not-used-while-only-sending",
      defaultFrom: from,
      // Inbound webhooks are not mounted here; these are only needed to construct the shared adapter.
      eventDeduplicator: { processOnce: async () => { throw new Error("The Resend inbound webhook is not mounted."); } },
      handlers: { onIncomingEmail: async () => undefined, onDeliveryEvent: async () => undefined },
    });
    return new alerts.ResendEscalationAlertAdapter({ sender, recipientResolver: createRecipientResolver(ctx.db), failureRecorder: createFailureRecorder(ctx.db) }) as EscalationAlertSender;
  } catch (err) {
    console.warn("[alerts] Resend adapter unavailable:", (err as Error).message);
    return null;
  }
}

export function integrationTicks(ctx: IntegrationContext): Array<() => Promise<void> | void> {
  let sender: Promise<EscalationAlertSender | null> | undefined;
  const getSender = () => (sender ??= loadResendSender(ctx));
  return [async () => { await dispatchAlerts(ctx, getSender); }];
}
