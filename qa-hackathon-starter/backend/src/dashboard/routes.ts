// Operational dashboard (F5). Every figure is computed on request from the same tables and the
// same definitions the lists use (glossary), so a number always matches the records behind it (Q12).
import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db.ts";
import { HttpError, validationMessage } from "../http.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { loadMember } from "../middleware/requirePermission.ts";
import { listLeads } from "../leads/service.ts";

export const WIDGETS = ["newLeads", "openPipeline", "responseTime", "recovery", "escalations", "availability", "appointments", "payments"] as const;
const prefsSchema = z.object({ hidden: z.array(z.enum(WIDGETS)).max(WIDGETS.length) });

// Start of "today" / "this month" in the viewer's IANA time zone, returned as a UTC instant.
export function zonedStart(unit: "day" | "month", timeZone: string, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, unit === "month" ? 1 : get("day"));
  const nowWallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = nowWallAsUtc - Math.floor(now.getTime() / 1000) * 1000; // zone offset at "now"
  return new Date(wallAsUtc - offsetMs);
}

function validZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "tz must be a valid IANA time zone such as America/Los_Angeles.");
  }
}

export function dashboardRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  router.get("/summary", (req, res) => {
    const { workspaceId, userId } = req.session!;
    const perms = req.member!.permissions;
    const companyWide = req.member!.baseLevel !== "user" || perms.includes("manageAssignmentRules"); // F5.4
    const tz = validZone(req.query.tz);
    const now = new Date();
    const dayStart = zonedStart("day", tz, now).toISOString();
    const monthStart = zonedStart("month", tz, now).toISOString();
    const since24h = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const nowIso = now.toISOString();
    const mine = (col: string) => (companyWide ? { sql: "", args: [] as string[] } : { sql: ` AND ${col} = ?`, args: [userId] });

    const lead = mine("owner_id");
    const newLeads = (db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ? AND created_at >= ?${lead.sql}`).get(workspaceId, dayStart, ...lead.args) as { n: number }).n;

    // Open pipeline value: opportunities not won/lost, grouped by stage; amounts only with the value permission.
    const opp = mine("o.owner_id");
    const stages = db.prepare(
      `SELECT s.id, s.name, p.name AS pipeline, COUNT(o.id) AS count, COALESCE(SUM(o.value), 0) AS total
       FROM stages s JOIN pipelines p ON p.id = s.pipeline_id LEFT JOIN opportunities o ON o.stage_id = s.id${opp.sql}
       WHERE s.workspace_id = ? AND s.kind = 'open' GROUP BY s.id ORDER BY p.created_at, s.position`,
    ).all(...opp.args, workspaceId) as { id: string; name: string; pipeline: string; count: number; total: number }[];
    const canSeeValue = perms.includes("viewOpportunityValue");
    const openPipeline = {
      byStage: stages.map((s) => ({ stageId: s.id, stage: s.name, pipeline: s.pipeline, count: s.count, amount: canSeeValue ? s.total : null })),
      total: canSeeValue ? stages.reduce((sum, s) => sum + s.total, 0) : null,
      valueHidden: !canSeeValue,
    };

    const rt = mine("owner_id");
    const response = db.prepare(
      `SELECT COUNT(*) AS n, AVG((julianday(first_response_at) - julianday(first_assigned_at)) * 86400.0) AS avg FROM leads
       WHERE workspace_id = ? AND first_response_at IS NOT NULL${rt.sql}`,
    ).get(workspaceId, ...rt.args) as { n: number; avg: number | null };

    const recovery = listLeads(db, workspaceId, { scope: "recovery", userId, canSeeAll: companyWide, limit: 1, offset: 0 }).total;

    const esc = companyWide ? { sql: "", args: [] as string[] } : { sql: " AND to_user_id = ?", args: [userId] };
    const escalations = (db.prepare(`SELECT COUNT(*) AS n FROM lead_assignment_history WHERE workspace_id = ? AND reason = 'escalation' AND created_at >= ?${esc.sql}`).get(workspaceId, since24h, ...esc.args) as { n: number }).n;

    const availRows = db.prepare(`SELECT availability, COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND removed_at IS NULL${companyWide ? "" : " AND user_id = ?"} GROUP BY availability`).all(workspaceId, ...(companyWide ? [] : [userId])) as { availability: string; n: number }[];
    const availability = { available: 0, busy: 0, on_leave: 0, offline: 0, total: 0 } as Record<string, number>;
    for (const r of availRows) { availability[r.availability] = r.n; availability.total! += r.n; }

    const ap = mine("user_id");
    const upcoming = db.prepare(
      `SELECT a.id, a.title, a.starts_at, a.ends_at, a.timezone, c.name AS contact FROM appointments a JOIN contacts c ON c.id = a.contact_id
       WHERE a.workspace_id = ? AND a.status = 'confirmed' AND a.starts_at >= ?${ap.sql.replace("user_id", "a.user_id")} ORDER BY a.starts_at LIMIT 5`,
    ).all(workspaceId, nowIso, ...ap.args) as { id: string; title: string; starts_at: string; ends_at: string; timezone: string; contact: string }[];
    const upcomingCount = (db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE workspace_id = ? AND status = 'confirmed' AND starts_at >= ?${ap.sql}`).get(workspaceId, nowIso, ...ap.args) as { n: number }).n;

    // Collected revenue: provider-confirmed payments minus confirmed refunds, by confirmation month (glossary).
    const pay = mine("requested_by");
    const collected = db.prepare(
      `SELECT COALESCE(SUM(amount - refunded_amount), 0) AS minor, currency FROM payments
       WHERE workspace_id = ? AND paid_at IS NOT NULL AND paid_at >= ?${pay.sql} GROUP BY currency`,
    ).all(workspaceId, monthStart, ...pay.args) as { minor: number; currency: string }[];

    const prefs = db.prepare("SELECT hidden FROM dashboard_preferences WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as { hidden: string } | undefined;
    res.json({
      scope: companyWide ? "company" : "personal",
      scopeLabel: companyWide ? "Company-wide view" : "Your personal view",
      timezone: tz,
      generatedAt: nowIso,
      hidden: prefs ? (JSON.parse(prefs.hidden) as string[]) : [],
      metrics: {
        newLeads: { value: newLeads, since: dayStart, drilldown: `/leads?scope=${companyWide ? "all" : "mine"}&createdFrom=${encodeURIComponent(dayStart)}` },
        openPipeline: { ...openPipeline, drilldown: "/opportunities?stageId=<stageId>" },
        responseTime: { averageSeconds: response.avg === null ? null : Math.round(response.avg), sampleSize: response.n },
        recovery: { value: recovery, drilldown: "/leads/recovery" },
        escalations: { value: escalations, since: since24h, drilldown: `/leads?scope=${companyWide ? "all" : "mine"}&escalatedSince=${encodeURIComponent(since24h)}` },
        availability,
        appointments: { count: upcomingCount, items: upcoming.map((a) => ({ id: a.id, title: a.title, contact: a.contact, startsAt: a.starts_at, endsAt: a.ends_at, timezone: a.timezone })), drilldown: "/appointments?from=now" },
        payments: { collected: collected.map((c) => ({ currency: c.currency, amount: c.minor / 100 })), since: monthStart, drilldown: `/payments?collectedFrom=${encodeURIComponent(monthStart)}` },
      },
      definitions: {
        newLeads: "Leads created today in your time zone.",
        openPipeline: "Sum of opportunity values not in a won or lost stage, grouped by stage. Shown only with permission to see values.",
        responseTime: "Average time from a lead's first assignment to its first acknowledgement.",
        recovery: "Open leads unacknowledged beyond their window, escalated twice or more, idle too long, or without an eligible owner.",
        escalations: "Automatic reassignments caused by an expired acknowledgement window in the last 24 hours (manual reassignments are not counted).",
        availability: "Employees by status.",
        appointments: "Confirmed appointments that have not started yet.",
        payments: "Payments confirmed by the payment provider this month, minus confirmed refunds. Projected or unpaid amounts are not included.",
      },
    });
  });

  router.get("/preferences", (req, res) => {
    const { workspaceId, userId } = req.session!;
    const row = db.prepare("SELECT hidden FROM dashboard_preferences WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as { hidden: string } | undefined;
    res.json({ hidden: row ? JSON.parse(row.hidden) : [], widgets: WIDGETS });
  });

  // Show/hide choices are remembered per user (F5.5).
  router.put("/preferences", (req, res) => {
    const parsed = prefsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: validationMessage(parsed.error) } });
    const { workspaceId, userId } = req.session!;
    db.prepare(
      `INSERT INTO dashboard_preferences (workspace_id, user_id, hidden) VALUES (?,?,?)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET hidden = excluded.hidden`,
    ).run(workspaceId, userId, JSON.stringify([...new Set(parsed.data.hidden)]));
    res.json({ hidden: [...new Set(parsed.data.hidden)] });
  });

  return router;
}
