// Admin setup for the Resend connection (I5.2, I5.3): each workspace has its own webhook URL (an unguessable key),
// signing secret and optional API key / sender / inbox address. Secrets are encrypted at rest and only ever shown masked.
// The webhook route itself lives in ./resend.ts; this is the screen-facing way to create the connection it needs.
import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit/audit.ts";
import { tx } from "../db.ts";
import { HttpError, validationMessage } from "../http.ts";
import { apiError, requireAuth } from "../middleware/requireAuth.ts";
import { loadMember, requirePermission } from "../middleware/requirePermission.ts";
import { connectionConfig, connectionSecrets, getConnection, mask, saveConnection, type Connection, type IntegrationContext } from "./core.ts";

interface ResendSecrets { apiKey?: string; webhookSecret?: string }
interface ResendConfig { fromEmail?: string | null; inboundAddress?: string | null }

const setupSchema = z.object({
  webhookSecret: z.string().trim().min(8).max(300),
  apiKey: z.string().trim().min(8).max(300).optional(), // optional: the server-wide RESEND_API_KEY is used when absent
  fromEmail: z.string().trim().email().max(254).nullish(),
  inboundAddress: z.string().trim().toLowerCase().email().max(254).nullish(),
});

function view(ctx: IntegrationContext, conn: Connection | undefined) {
  const secrets = conn ? connectionSecrets<ResendSecrets>(ctx, conn) : {};
  const cfg = conn ? connectionConfig<ResendConfig>(conn) : {};
  return {
    status: conn ? (conn.status === "connected" ? "connected" : "error") : "not_connected",
    webhookUrl: conn ? `${ctx.publicBaseUrl}/api/v1/webhooks/resend/${conn.webhook_key}` : null,
    signingSecret: mask(secrets.webhookSecret),
    apiKey: secrets.apiKey ? mask(secrets.apiKey) : process.env.RESEND_API_KEY ? "from the server environment" : null,
    fromEmail: cfg.fromEmail ?? null,
    inboundAddress: cfg.inboundAddress ?? null,
    lastSuccessAt: conn?.last_success_at ?? null,
    lastError: conn?.last_error ?? null,
  };
}

export function resendSettingsRouter(ctx: IntegrationContext) {
  const { db } = ctx;
  const router = Router();
  const guard = [requireAuth(db), loadMember(db), requirePermission(db, "manageIntegrations")]; // route-level: mounted at /api/v1

  router.get("/integrations/resend", ...guard, (req, res) => {
    res.json(view(ctx, getConnection(db, req.session!.workspaceId, "resend")));
  });

  router.put("/integrations/resend", ...guard, (req, res) => {
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", validationMessage(parsed.error));
    const { workspaceId, userId } = req.session!;
    const existing = getConnection(db, workspaceId, "resend");
    const previous = existing ? connectionSecrets<ResendSecrets>(ctx, existing) : {};
    const apiKey = parsed.data.apiKey ?? previous.apiKey;
    if (!apiKey && !process.env.RESEND_API_KEY) return apiError(res, 400, "VALIDATION_ERROR", "Provide a Resend API key, or set RESEND_API_KEY on the server.");
    const conn = tx(db, () => {
      const c = saveConnection(
        ctx, workspaceId, "resend", null,
        { fromEmail: parsed.data.fromEmail ?? null, inboundAddress: parsed.data.inboundAddress ?? null },
        { ...(apiKey ? { apiKey } : {}), webhookSecret: parsed.data.webhookSecret },
      );
      audit(db, { workspaceId, actorId: userId, action: existing ? "integration.updated" : "integration.connected", targetType: "integration", targetId: "resend", after: { fromEmail: parsed.data.fromEmail ?? null, inboundAddress: parsed.data.inboundAddress ?? null } }); // never a secret
      return c;
    });
    res.status(existing ? 200 : 201).json(view(ctx, conn));
  });

  router.delete("/integrations/resend", ...guard, (req, res) => {
    const { workspaceId, userId } = req.session!;
    const conn = getConnection(db, workspaceId, "resend");
    if (!conn) throw new HttpError(404, "NOT_FOUND", "Resend is not connected.");
    tx(db, () => {
      db.prepare("DELETE FROM integration_connections WHERE id = ?").run(conn.id);
      audit(db, { workspaceId, actorId: userId, action: "integration.removed", targetType: "integration", targetId: "resend" });
    });
    res.status(204).end();
  });

  return router;
}
