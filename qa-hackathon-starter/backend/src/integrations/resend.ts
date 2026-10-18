// Resend inbound email (I1-style channel, F3.1): POST /api/v1/webhooks/resend/:key.
//
// The workspace comes from the unguessable :key (never from the payload), and the Svix signature is checked
// with THAT workspace's signing secret, so one workspace's webhook can never act on another's data (I5.2).
// The Resend API key is environment-level for now; the connection record is per workspace, so moving the key
// per workspace later only changes where it is read from.
//
// The adapter (integrations/resend) verifies the signature, fetches the email body and de-duplicates by Svix id.
// This module supplies what it calls back into: durable de-duplication, and the CRM actions for a received email
// (find or create the contact by sender address, append the message to the email conversation, create a lead for
// an unknown sender). Every CRM action is idempotent on the provider's email id, so a retry can never duplicate.
import { Router, type Request } from "express";
import { z } from "zod";
import { audit } from "../audit/audit.ts";
import { logActivity } from "../crm/common.ts";
import { findOrCreateContact } from "../crm/contactService.ts";
import { tx, type Db } from "../db.ts";
import { publish } from "../events/bus.ts";
import { HttpError, validationMessage } from "../http.ts";
import { createLead } from "../leads/service.ts";
import { apiError, requireAuth } from "../middleware/requireAuth.ts";
import { loadMember, requirePermission } from "../middleware/requirePermission.ts";
import { loadResendModules } from "./adapters.ts";
import {
  connectionConfig, connectionSecrets, findByWebhookKey, getConnection, logEvent, markFailure, markSuccess, mask, saveConnection,
  type Connection, type IntegrationContext,
} from "./core.ts";
import { randomUUID } from "node:crypto";

// ----- Shapes the adapter hands to the handlers (mirrors integrations/resend/types.ts) -----
export interface IncomingEmail {
  providerEmailId: string;
  providerMessageId: string;
  from: string;
  to: string[];
  receivedFor: string[];
  subject: string;
  text: string | null;
  html: string | null;
  receivedAt: Date;
}
export interface EmailDeliveryEvent { providerEventId: string; type: string; to: string[]; subject: string }
export interface ResendWebhookPort {
  handleWebhook(rawPayload: string, headers: Record<string, string | undefined>): Promise<{ kind: "processed" | "duplicate" | "ignored"; providerEventId: string }>;
}
export type ResendPortFactory = (ctx: IntegrationContext, conn: Connection) => Promise<ResendWebhookPort | null>;

// ----- Address and text helpers -----
export function parseAddress(raw: string): { email: string; name: string | null } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { email: m[2]!.trim().toLowerCase(), name: m[1]!.trim() || null };
  return { email: raw.trim().toLowerCase(), name: null };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MAX_BODY = 20_000;
const ownAddresses = () => new Set([process.env.RESEND_FROM_EMAIL, process.env.RESEND_RECEIVING_ADDRESS].filter(Boolean).map((a) => parseAddress(a!).email));

// ----- Durable, serialised de-duplication (the adapter's ResendWebhookEventDeduplicator) -----
// A delivery is recorded only AFTER its work succeeded, so failed work stays retryable. Concurrent deliveries of the same
// id run one after the other (in-process queue), and the second then finds the first's record and reports a duplicate.
const queues = new Map<string, Promise<unknown>>();
export function createEventDeduplicator(db: Db, workspaceId: string) {
  return {
    async processOnce(providerEventId: string, work: () => Promise<void>): Promise<boolean> {
      const key = `${workspaceId}|${providerEventId}`;
      const previous = queues.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => { release = resolve; });
      const tail = previous.then(() => mine);
      queues.set(key, tail);
      await previous.catch(() => undefined);
      try {
        if (db.prepare("SELECT 1 FROM processed_events WHERE workspace_id = ? AND provider = 'resend' AND external_id = ?").get(workspaceId, providerEventId)) return false;
        await work();
        db.prepare("INSERT OR IGNORE INTO processed_events (workspace_id, provider, external_id, created_at) VALUES (?,?,?,?)").run(workspaceId, "resend", providerEventId, new Date().toISOString());
        return true;
      } finally {
        release();
        if (queues.get(key) === tail) queues.delete(key);
      }
    },
  };
}

// ----- What happens to a received email -----
export function createInboundHandlers(ctx: IntegrationContext, conn: Connection) {
  const { db } = ctx;
  const workspaceId = conn.workspace_id;
  return {
    async onIncomingEmail(email: IncomingEmail): Promise<void> {
      const cfg = connectionConfig<{ receivingAddress?: string }>(conn);
      const sender = parseAddress(email.from);
      const addressedTo = [...email.receivedFor, ...email.to].map((a) => parseAddress(a).email);
      // Only mail sent to this workspace's inbox belongs to it; anything else is recorded and ignored.
      if (cfg.receivingAddress && !addressedTo.includes(cfg.receivingAddress.trim().toLowerCase())) {
        logEvent(db, { workspaceId, provider: "resend", direction: "inbound", eventType: "email.received", externalId: email.providerEmailId, result: "rejected", detail: "Not addressed to this workspace's inbox." });
        return;
      }
      if (ownAddresses().has(sender.email)) { // never answer ourselves: that is how mail loops start
        logEvent(db, { workspaceId, provider: "resend", direction: "inbound", eventType: "email.received", externalId: email.providerEmailId, result: "rejected", detail: "Sent from this platform's own address; ignored." });
        return;
      }
      const text = (email.text?.trim() ? email.text : email.html ? htmlToText(email.html) : "").slice(0, MAX_BODY);
      const body = (email.subject ? `${email.subject}\n\n${text}` : text).trim() || "(empty message)";
      const outcome = tx(db, () => {
        // Idempotent on the provider's email id: the same email can only ever add one message.
        if (db.prepare("SELECT 1 FROM messages WHERE workspace_id = ? AND provider_message_id = ?").get(workspaceId, email.providerEmailId)) return "duplicate" as const;
        const contact = findOrCreateContact(db, workspaceId, { name: sender.name ?? sender.email, email: sender.email }, null);
        let conversation = db.prepare("SELECT id FROM conversations WHERE workspace_id = ? AND contact_id = ? AND channel = 'email'").get(workspaceId, contact.id) as { id: string } | undefined;
        const now = new Date().toISOString();
        if (!conversation) {
          conversation = { id: randomUUID() };
          db.prepare("INSERT INTO conversations (id, workspace_id, contact_id, channel, last_message_at) VALUES (?,?,?,'email',?)").run(conversation.id, workspaceId, contact.id, now);
        }
        db.prepare("INSERT INTO messages (id, workspace_id, conversation_id, direction, body, provider_message_id, status, created_at) VALUES (?,?,?,'inbound',?,?,'received',?)").run(
          randomUUID(), workspaceId, conversation.id, body, email.providerEmailId, email.receivedAt.toISOString(),
        );
        db.prepare("UPDATE conversations SET last_message_at = ?, unread = unread + 1 WHERE id = ?").run(now, conversation.id);
        logActivity(db, { workspaceId, contactId: contact.id, type: "message", text: `Email received: ${(email.subject || text).slice(0, 120)}`, actorId: null });
        if (contact.created) createLead(db, { workspaceId, contactId: contact.id, source: "message", message: body.slice(0, 2000), actorId: null }); // unknown sender -> contact + lead (F3.1)
        return contact.created ? ("lead" as const) : ("message" as const);
      });
      logEvent(db, { workspaceId, provider: "resend", direction: "inbound", eventType: "email.received", externalId: email.providerEmailId, result: outcome === "duplicate" ? "duplicate" : "ok", detail: outcome === "lead" ? "New contact and lead created." : outcome === "message" ? "Added to the existing contact's conversation." : "Already recorded." });
      if (outcome !== "duplicate") publish(workspaceId, { type: "incomingMessage", title: "New email", detail: `${sender.name ?? sender.email}: ${(email.subject || text).slice(0, 80)}`, tone: "info" });
    },

    // Delivery/bounce notifications are kept in the synchronisation history (I5.4); bad outcomes show as errors.
    async onDeliveryEvent(event: EmailDeliveryEvent): Promise<void> {
      const bad = /bounced|complained|failed|suppressed/.test(event.type);
      logEvent(db, { workspaceId, provider: "resend", direction: "inbound", eventType: event.type, externalId: event.providerEventId, result: bad ? "error" : "ok", detail: `${event.type} for ${event.to.join(", ")}` });
    },
  };
}

// Builds the real adapter for one workspace: the API key from the environment, the signing secret from the connection.
export const defaultResendFactory: ResendPortFactory = async (ctx, conn) => {
  const apiKey = process.env.RESEND_API_KEY;
  const secrets = connectionSecrets<{ webhookSecret?: string }>(ctx, conn);
  if (!apiKey || !secrets.webhookSecret) return null;
  try {
    const { email } = await loadResendModules();
    return email.createResendEmailAdapter({
      apiKey, webhookSecret: secrets.webhookSecret, defaultFrom: process.env.RESEND_FROM_EMAIL,
      eventDeduplicator: createEventDeduplicator(ctx.db, conn.workspace_id), handlers: createInboundHandlers(ctx, conn),
    }) as ResendWebhookPort;
  } catch (err) {
    console.warn("[resend] adapter unavailable:", (err as Error).message);
    return null;
  }
};

// ----- Public webhook route -----
export function resendWebhookRouter(ctx: IntegrationContext, factory: ResendPortFactory = defaultResendFactory) {
  const { db } = ctx;
  const router = Router();
  router.post("/:key", async (req: Request, res) => {
    const conn = findByWebhookKey(db, "resend", String(req.params.key));
    if (!conn) return apiError(res, 404, "NOT_FOUND", "Unknown webhook.");
    const workspaceId = conn.workspace_id;
    const raw = req.rawBody; // the exact bytes: re-serialised JSON would not match the signature
    if (!raw) return apiError(res, 400, "VALIDATION_ERROR", "A JSON body is required.");
    const port = await factory(ctx, conn).catch(() => null);
    if (!port) {
      logEvent(db, { workspaceId, provider: "resend", direction: "inbound", eventType: "webhook", result: "error", detail: "Resend is not configured on the server (RESEND_API_KEY, signing secret)." });
      return apiError(res, 503, "INTEGRATION_NOT_CONFIGURED", "Resend is not configured on the server, so this webhook cannot be processed yet."); // non-2xx: Resend retries
    }
    try {
      const result = await port.handleWebhook(raw.toString("utf8"), { "svix-id": req.get("svix-id"), "svix-timestamp": req.get("svix-timestamp"), "svix-signature": req.get("svix-signature") });
      if (result.kind === "duplicate") logEvent(db, { workspaceId, provider: "resend", direction: "inbound", eventType: "webhook", externalId: result.providerEventId, result: "duplicate", detail: "Delivered again by the provider; no second effect." });
      markSuccess(db, conn);
      return res.status(200).json({ received: true, result: result.kind });
    } catch (err) {
      const name = (err as Error).name;
      if (name === "ResendWebhookAuthenticationError" || (err instanceof TypeError && /header/i.test(err.message))) {
        logEvent(db, { workspaceId, provider: "resend", direction: "inbound", eventType: "webhook", externalId: req.get("svix-id") ?? null, result: "rejected", detail: "Signature check failed; nothing was changed." });
        return apiError(res, 401, "INVALID_SIGNATURE", "Signature verification failed.");
      }
      if (name === "ResendWebhookPayloadError") {
        logEvent(db, { workspaceId, provider: "resend", direction: "inbound", eventType: "webhook", externalId: req.get("svix-id") ?? null, result: "rejected", detail: "Malformed payload." });
        return apiError(res, 400, "VALIDATION_ERROR", "The webhook payload is malformed.");
      }
      // Anything else is temporary from our side or the provider's: report failure so Resend retries; nothing was marked processed.
      logEvent(db, { workspaceId, provider: "resend", direction: "inbound", eventType: "webhook", externalId: req.get("svix-id") ?? null, result: "error", detail: `Processing failed (${name}); the provider will retry.` });
      markFailure(db, conn, `Last webhook failed (${name}).`);
      return apiError(res, 500, "PROCESSING_FAILED", "The webhook could not be processed; please retry.");
    }
  });
  return router;
}

// ----- Admin setup: connect this workspace's inbox -----
const setupSchema = z.object({
  webhookSecret: z.string().trim().min(8).max(300),
  receivingAddress: z.string().trim().toLowerCase().email().max(254).optional(),
});

function resendView(ctx: IntegrationContext, conn: Connection | undefined) {
  const cfg = conn ? connectionConfig<{ receivingAddress?: string }>(conn) : {};
  const secrets = conn ? connectionSecrets<{ webhookSecret?: string }>(ctx, conn) : {};
  return {
    status: conn ? (conn.status === "connected" ? "connected" : conn.status) : "not_connected",
    webhookUrl: conn ? `${ctx.publicBaseUrl}/api/v1/webhooks/resend/${conn.webhook_key}` : null,
    signingSecret: mask(secrets.webhookSecret),
    receivingAddress: cfg.receivingAddress ?? null,
    lastSuccessAt: conn?.last_success_at ?? null,
    lastError: conn?.last_error ?? null,
    serverConfigured: Boolean(process.env.RESEND_API_KEY),
  };
}

export function resendSettingsRouter(ctx: IntegrationContext) {
  const { db } = ctx;
  const router = Router();
  const guard = [requireAuth(db), loadMember(db), requirePermission(db, "manageIntegrations")]; // route-level: this router is mounted at /api/v1

  router.get("/integrations/resend", ...guard, (req, res) => {
    res.json(resendView(ctx, getConnection(db, req.session!.workspaceId, "resend")));
  });

  router.put("/integrations/resend", ...guard, (req, res) => {
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", validationMessage(parsed.error));
    const { workspaceId, userId } = req.session!;
    const existed = Boolean(getConnection(db, workspaceId, "resend"));
    const conn = tx(db, () => {
      const c = saveConnection(ctx, workspaceId, "resend", null, { receivingAddress: parsed.data.receivingAddress ?? null }, { webhookSecret: parsed.data.webhookSecret });
      audit(db, { workspaceId, actorId: userId, action: existed ? "integration.updated" : "integration.connected", targetType: "integration", targetId: "resend", after: { receivingAddress: parsed.data.receivingAddress ?? null } }); // never the secret
      return c;
    });
    res.status(existed ? 200 : 201).json(resendView(ctx, conn));
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
