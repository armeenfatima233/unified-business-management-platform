// Escalation alerts outside the app (I4, F3.9). The core decides WHEN: escalateLead() writes a pending
// row to delivery_attempts in the same transaction as the reassignment. This module decides nothing
// about email: it hands each pending alert to an EscalationAlertSender (the Resend adapter), resolves the
// recipient from workspace-scoped settings, records every failure durably, and shows Admins the history.
//
// The three interfaces below are the contract with the Resend adapter (integrations/resend); they are
// declared here with the same shapes so the core does not depend on the provider SDK.
import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit/audit.ts";
import { tx, type Db } from "../db.ts";
import { HttpError, paginate, validationMessage } from "../http.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { loadMember, requirePermission } from "../middleware/requirePermission.ts";
import { logEvent, type IntegrationContext } from "./core.ts";

export interface EscalationAlertInput {
  alertId: string;
  workspaceId: string;
  employeeId: string;
  leadId: string;
  leadName: string;
  leadSource: string;
  reason: string;
  directLink: string;
}
export interface EscalationAlertRecipient { email: string }
export interface EscalationAlertRecipientResolver {
  resolveRecipient(workspaceId: string, employeeId: string): Promise<EscalationAlertRecipient | null>;
}
export interface EscalationAlertFailure {
  alertId: string;
  workspaceId: string;
  employeeId: string;
  leadId: string;
  attempt: number;
  occurredAt: Date;
  errorName: string;
  providerStatusCode: number | null;
  retryable: boolean;
  finalAttempt: boolean;
}
export interface EscalationAlertFailureRecorder {
  recordFailure(failure: EscalationAlertFailure): Promise<void>;
}
export interface EscalationAlertSender {
  sendEscalationAlert(alert: EscalationAlertInput): Promise<{ providerEmailId: string; attempts: number }>;
}

const SOURCE_LABEL: Record<string, string> = { web_form: "Web form", message: "Incoming message", manual: "Manual entry" };
const CLAIM_MS = 120_000; // a crash mid-send re-offers the alert after this; the provider idempotency key prevents a duplicate email

// Employee-configured destination first (I4.3), otherwise the address they log in with. A removed member has none.
export function createRecipientResolver(db: Db): EscalationAlertRecipientResolver {
  return {
    async resolveRecipient(workspaceId, employeeId) {
      const member = db.prepare("SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ? AND m.removed_at IS NULL").get(workspaceId, employeeId) as { email: string } | undefined;
      if (!member) return null;
      const chosen = db.prepare("SELECT destination FROM notification_destinations WHERE workspace_id = ? AND user_id = ? AND channel = 'email'").get(workspaceId, employeeId) as { destination: string } | undefined;
      return { email: chosen?.destination ?? member.email };
    },
  };
}

const failureText = (f: EscalationAlertFailure) =>
  f.errorName === "EscalationAlertRecipientError"
    ? "No valid email address is set for this person."
    : `Attempt ${f.attempt} failed (${f.errorName}${f.providerStatusCode ? `, HTTP ${f.providerStatusCode}` : ""})${f.finalAttempt ? "; giving up." : "; will retry."}`;

// Durable failure history for the integration status page and retries (I4.4, I5.4).
export function createFailureRecorder(db: Db): EscalationAlertFailureRecorder {
  return {
    async recordFailure(f) {
      const text = failureText(f);
      logEvent(db, { workspaceId: f.workspaceId, provider: "resend", direction: "outbound", eventType: "escalation_alert", externalId: f.alertId, result: "error", detail: text });
      db.prepare("UPDATE delivery_attempts SET attempts = MAX(attempts, ?), last_error = ? WHERE id = ? AND workspace_id = ?").run(f.attempt, text, f.alertId, f.workspaceId);
    },
  };
}

function explain(err: unknown): { text: string; attempts?: number } {
  const e = err as { name?: string; attempts?: number; providerErrorName?: string; message?: string };
  if (e?.name === "EscalationAlertRecipientError") return { text: "No valid email address is set for this person." };
  if (e?.name === "EscalationAlertDeliveryError") return { text: `The email provider could not deliver the alert after ${e.attempts} attempts (${e.providerErrorName}).`, attempts: e.attempts };
  if (err instanceof TypeError && /HTTPS/i.test(e.message ?? "")) return { text: "Alert links must be https. Set FRONTEND_URL to the public https address of the app." };
  return { text: `The alert could not be sent (${e?.name ?? "error"}).` };
}

interface PendingRow { id: string; workspace_id: string; lead_id: string; user_id: string; reason: string | null; attempts: number }

// One worker tick: send every alert that is due. Returns how many were handled.
export async function dispatchAlerts(ctx: IntegrationContext, getSender: () => Promise<EscalationAlertSender | null>): Promise<number> {
  const { db } = ctx;
  const due = db.prepare("SELECT id, workspace_id, lead_id, user_id, reason, attempts FROM delivery_attempts WHERE status = 'pending' AND channel = 'email' AND next_attempt_at <= ? ORDER BY created_at LIMIT 10").all(new Date().toISOString()) as unknown as PendingRow[];
  if (due.length === 0) return 0;
  const sender = await getSender();
  for (const a of due) {
    const finish = (status: "sent" | "failed", attempts: number, lastError: string | null) =>
      db.prepare("UPDATE delivery_attempts SET status = ?, attempts = ?, last_error = ?, next_attempt_at = NULL WHERE id = ?").run(status, attempts, lastError, a.id);
    db.prepare("UPDATE delivery_attempts SET next_attempt_at = ? WHERE id = ?").run(new Date(Date.now() + CLAIM_MS).toISOString(), a.id); // claim
    if (!sender) { finish("failed", a.attempts, "Email alerts are not configured on the server (RESEND_API_KEY and RESEND_FROM_EMAIL)."); continue; }
    const lead = db.prepare("SELECT l.id, l.source, c.name FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.workspace_id = ? AND l.id = ?").get(a.workspace_id, a.lead_id) as { id: string; source: string; name: string } | undefined;
    if (!lead) { finish("failed", a.attempts, "The lead no longer exists."); continue; }
    try {
      const receipt = await sender.sendEscalationAlert({
        alertId: a.id, workspaceId: a.workspace_id, employeeId: a.user_id, leadId: lead.id, leadName: lead.name,
        leadSource: SOURCE_LABEL[lead.source] ?? lead.source, reason: a.reason ?? "This lead was escalated to you.",
        directLink: `${ctx.frontendUrl.replace(/\/$/, "")}/?lead=${lead.id}`, // opens the lead after sign-in
      });
      finish("sent", receipt.attempts, null);
      logEvent(db, { workspaceId: a.workspace_id, provider: "resend", direction: "outbound", eventType: "escalation_alert", externalId: a.id, result: "ok", detail: `Accepted by the email provider (message ${receipt.providerEmailId}) after ${receipt.attempts} attempt(s).` });
    } catch (err) {
      const why = explain(err);
      finish("failed", why.attempts ?? Math.max(a.attempts, 1), why.text); // the adapter has already recorded each attempt through the failure recorder
      if (!(err as { name?: string }).name?.startsWith("EscalationAlert")) logEvent(db, { workspaceId: a.workspace_id, provider: "resend", direction: "outbound", eventType: "escalation_alert", externalId: a.id, result: "error", detail: why.text });
    }
  }
  return due.length;
}

// ----- API: Admins see alert history and retry failures (I4.4); everyone sets their own address (I4.3) -----
const destinationSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

export function alertsRouter(db: Db) {
  const router = Router();
  // Route-level guards (not router.use): this router is mounted at /api/v1 and must not intercept other paths.
  const guard = [requireAuth(db), loadMember(db)];

  router.get("/notifications/alerts", ...guard, requirePermission(db, "manageIntegrations"), (req, res) => {
    const { workspaceId } = req.session!;
    const { page, pageSize, offset } = paginate(req.query);
    const status = typeof req.query.status === "string" && ["pending", "sent", "failed"].includes(req.query.status) ? req.query.status : null;
    const where = `d.workspace_id = ?${status ? " AND d.status = ?" : ""}`;
    const args = status ? [workspaceId, status] : [workspaceId];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM delivery_attempts d WHERE ${where}`).get(...args) as { n: number }).n;
    const rows = db.prepare(
      `SELECT d.id, d.lead_id, d.reason, d.status, d.attempts, d.last_error, d.created_at, c.name AS lead_name, l.source, u.name AS recipient
       FROM delivery_attempts d LEFT JOIN leads l ON l.id = d.lead_id LEFT JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = d.user_id
       WHERE ${where} ORDER BY d.created_at DESC, d.rowid DESC LIMIT ? OFFSET ?`,
    ).all(...args, pageSize, offset) as Record<string, unknown>[];
    res.json({
      items: rows.map((r) => ({
        id: r.id, leadId: r.lead_id, lead: r.lead_name ?? "Deleted lead", source: SOURCE_LABEL[String(r.source)] ?? r.source, recipient: r.recipient ?? "Unknown",
        reason: r.reason, status: r.status, attempts: r.attempts, lastError: r.last_error, createdAt: r.created_at,
        history: (db.prepare("SELECT created_at, result, detail FROM integration_events WHERE workspace_id = ? AND external_id = ? ORDER BY created_at DESC LIMIT 5").all(workspaceId, r.id as string) as Record<string, unknown>[]).map((e) => ({ at: e.created_at, result: e.result, detail: e.detail })),
      })),
      page, pageSize, total,
    });
  });

  router.post("/notifications/alerts/:id/retry", ...guard, requirePermission(db, "manageIntegrations"), (req, res) => {
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const a = db.prepare("SELECT id, status FROM delivery_attempts WHERE workspace_id = ? AND id = ?").get(workspaceId, String(req.params.id)) as { id: string; status: string } | undefined;
      if (!a) throw new HttpError(404, "NOT_FOUND", "Alert not found.");
      if (a.status !== "failed") throw new HttpError(409, "NOT_RETRYABLE", "Only failed alerts can be retried.");
      db.prepare("UPDATE delivery_attempts SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = ? WHERE id = ?").run(new Date().toISOString(), a.id);
      audit(db, { workspaceId, actorId: userId, action: "notification.retried", targetType: "alert", targetId: a.id });
    });
    res.json({ id: String(req.params.id), status: "pending" });
  });

  router.get("/me/notification-destination", ...guard, (req, res) => {
    const { workspaceId, userId } = req.session!;
    const row = db.prepare("SELECT destination FROM notification_destinations WHERE workspace_id = ? AND user_id = ? AND channel = 'email'").get(workspaceId, userId) as { destination: string } | undefined;
    const account = (db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string }).email;
    res.json({ channel: "email", email: row?.destination ?? null, effectiveEmail: row?.destination ?? account, usingAccountEmail: !row });
  });

  router.put("/me/notification-destination", ...guard, (req, res) => {
    const parsed = destinationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: validationMessage(parsed.error) } });
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      db.prepare(
        `INSERT INTO notification_destinations (workspace_id, user_id, channel, destination) VALUES (?,?,'email',?)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET channel = 'email', destination = excluded.destination`,
      ).run(workspaceId, userId, parsed.data.email);
      audit(db, { workspaceId, actorId: userId, action: "notification_destination.updated", targetType: "member", targetId: userId });
    });
    res.json({ channel: "email", email: parsed.data.email, effectiveEmail: parsed.data.email, usingAccountEmail: false });
  });

  router.delete("/me/notification-destination", ...guard, (req, res) => {
    const { workspaceId, userId } = req.session!;
    db.prepare("DELETE FROM notification_destinations WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId);
    res.status(204).end();
  });

  return router;
}
