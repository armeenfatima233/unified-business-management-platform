// The central integrations page (I5.1, I5.4, I5.6): one list with each integration's status, when it last worked,
// its recent errors and plain statements of what it can and cannot do, plus the synchronisation history.
import { Router } from "express";
import { paginate } from "../http.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { loadMember, requirePermission } from "../middleware/requirePermission.ts";
import { connectionConfig, getConnection, type IntegrationContext } from "./core.ts";
import { googleConfigured } from "./googleCalendar.ts";

export function integrationsStatusRouter(ctx: IntegrationContext) {
  const { db } = ctx;
  const router = Router();
  const guard = [requireAuth(db), loadMember(db), requirePermission(db, "manageIntegrations")]; // route-level: mounted at /api/v1

  const recentErrors = (workspaceId: string, provider: string) =>
    (db.prepare("SELECT created_at, event_type, result, detail FROM integration_events WHERE workspace_id = ? AND provider = ? AND result IN ('error','rejected') ORDER BY created_at DESC, rowid DESC LIMIT 5").all(workspaceId, provider) as Record<string, unknown>[])
      .map((e) => ({ at: e.created_at, type: e.event_type, result: e.result, detail: e.detail }));
  const lastOk = (workspaceId: string, provider: string) =>
    (db.prepare("SELECT created_at FROM integration_events WHERE workspace_id = ? AND provider = ? AND result = 'ok' ORDER BY created_at DESC LIMIT 1").get(workspaceId, provider) as { created_at: string } | undefined)?.created_at ?? null;

  router.get("/integrations", ...guard, (req, res) => {
    const { workspaceId } = req.session!;
    const resend = getConnection(db, workspaceId, "resend");
    const googleRows = db.prepare("SELECT status FROM integration_connections WHERE workspace_id = ? AND provider = 'google' AND user_id IS NOT NULL").all(workspaceId) as { status: string }[];
    const googleStatus = googleRows.some((r) => r.status === "needs_reconnection") ? "needs_reconnection" : googleRows.length ? "connected" : "not_connected";
    const alerts = db.prepare("SELECT status, COUNT(*) AS n FROM delivery_attempts WHERE workspace_id = ? GROUP BY status").all(workspaceId) as { status: string; n: number }[];
    const count = (s: string) => alerts.find((a) => a.status === s)?.n ?? 0;
    res.json({
      items: [
        {
          id: "email-inbound", name: "Email (Resend)", purpose: "Receive customers' emails as conversations and leads.",
          status: resend ? (resend.status === "connected" ? "connected" : "error") : "not_connected",
          lastSuccessAt: resend?.last_success_at ?? lastOk(workspaceId, "resend"), lastError: resend?.last_error ?? null, recentErrors: recentErrors(workspaceId, "resend"),
          details: { receivingAddress: resend ? connectionConfig<{ receivingAddress?: string }>(resend).receivingAddress ?? null : null, serverConfigured: Boolean(process.env.RESEND_API_KEY) },
          limits: "Receives mail sent to the connected address and records delivery/bounce events. Attachment contents are not downloaded. Replying to customers by email is not available yet.",
        },
        {
          id: "calendar", name: "Google Calendar", purpose: "Book appointments in each employee's own calendar.",
          status: googleStatus, lastSuccessAt: lastOk(workspaceId, "google"), lastError: null, recentErrors: recentErrors(workspaceId, "google"),
          details: { connectedEmployees: googleRows.length, serverConfigured: googleConfigured() },
          limits: "Each employee connects their own account. While the Google app is in testing, only listed test users can sign in and refresh tokens may expire after 7 days (the connection then shows “needs reconnection”).",
        },
        {
          id: "notifications", name: "Escalation alerts (email)", purpose: "Email the new owner when a lead escalates.",
          status: !process.env.RESEND_API_KEY ? "not_connected" : count("failed") > 0 && count("sent") === 0 ? "error" : "connected",
          lastSuccessAt: lastOk(workspaceId, "resend"), lastError: (db.prepare("SELECT last_error FROM delivery_attempts WHERE workspace_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1").get(workspaceId) as { last_error: string } | undefined)?.last_error ?? null,
          recentErrors: [], details: { sent: count("sent"), failed: count("failed"), pending: count("pending"), serverConfigured: Boolean(process.env.RESEND_API_KEY) },
          limits: "“Sent” means the email provider accepted the message, not that it reached an inbox. Failures are retried up to three times, then listed with a Retry button.",
        },
      ],
    });
  });

  router.get("/integrations/events", ...guard, (req, res) => {
    const { workspaceId } = req.session!;
    const { page, pageSize, offset } = paginate(req.query);
    const where = ["workspace_id = ?"]; const args: (string | number)[] = [workspaceId];
    for (const key of ["provider", "result"] as const) if (typeof req.query[key] === "string" && req.query[key]) { where.push(`${key} = ?`); args.push(req.query[key] as string); }
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM integration_events WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n;
    const rows = db.prepare(`SELECT id, provider, direction, event_type, external_id, result, detail, created_at FROM integration_events WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset) as Record<string, unknown>[];
    res.json({ items: rows.map((r) => ({ id: r.id, provider: r.provider, direction: r.direction, type: r.event_type, reference: r.external_id, result: r.result, detail: r.detail, at: r.created_at })), page, pageSize, total });
  });

  return router;
}
