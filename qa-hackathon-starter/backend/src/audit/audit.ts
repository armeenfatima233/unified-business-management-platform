// Audit history (F4). Rows are written by the application only through audit(), inside the
// same transaction as the change they describe, and the DB blocks UPDATE/DELETE (F4.3).
import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Db } from "../db.ts";
import { maskValue } from "../auth/permissions.ts";
import { requirePermission } from "../middleware/requirePermission.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { paginate } from "../http.ts";

export interface AuditInput {
  workspaceId: string;
  actorId: string | null; // null = the system (timers, webhooks)
  action: string; // dotted, e.g. "lead.escalated"
  targetType: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
}

export function audit(db: Db, ev: AuditInput) {
  db.prepare(
    `INSERT INTO audit_events (id, workspace_id, actor_id, action, target_type, target_id, before_json, after_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(),
    ev.workspaceId,
    ev.actorId,
    ev.action,
    ev.targetType,
    ev.targetId ?? null,
    ev.before === undefined ? null : JSON.stringify(ev.before),
    ev.after === undefined ? null : JSON.stringify(ev.after),
    new Date().toISOString(),
  );
}

interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

// Opportunity values inside before/after snapshots are protected like everywhere else (F1.4).
function redact(json: string | null, canSeeValue: boolean): unknown {
  if (json === null) return null;
  const parsed = JSON.parse(json) as Record<string, unknown> | null;
  if (canSeeValue || parsed === null || typeof parsed !== "object" || !("value" in parsed)) return parsed;
  return { ...parsed, value: null };
}

export function auditRouter(db: Db) {
  const router = Router();
  router.get("/", requireAuth(db), requirePermission(db, "viewAuditLog"), (req, res) => {
    const { workspaceId } = req.session!;
    const { page, pageSize, offset } = paginate(req.query);
    const where = ["a.workspace_id = ?"];
    const args: (string | number)[] = [workspaceId];
    const type = typeof req.query.eventType === "string" ? req.query.eventType : "";
    if (type) {
      where.push("(a.action = ? OR a.action LIKE ?)"); // exact action or a prefix like "lead"
      args.push(type, `${type}.%`);
    }
    if (typeof req.query.actorId === "string" && req.query.actorId) {
      where.push("a.actor_id = ?");
      args.push(req.query.actorId);
    }
    if (typeof req.query.from === "string" && req.query.from) {
      where.push("a.created_at >= ?");
      args.push(req.query.from);
    }
    if (typeof req.query.to === "string" && req.query.to) {
      where.push("a.created_at <= ?");
      args.push(req.query.to);
    }
    const whereSql = where.join(" AND ");
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_events a WHERE ${whereSql}`).get(...args) as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT a.id, a.actor_id, u.name AS actor_name, a.action, a.target_type, a.target_id, a.before_json, a.after_json, a.created_at
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
         WHERE ${whereSql} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, offset) as unknown as AuditRow[];
    const canSeeValue = maskValue(true, req.member!.permissions) === true;
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        time: r.created_at,
        actorId: r.actor_id,
        actor: r.actor_name ?? "System",
        type: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        before: redact(r.before_json, canSeeValue),
        after: redact(r.after_json, canSeeValue),
      })),
      page,
      pageSize,
      total,
    });
  });
  // Deliberately no PUT/PATCH/DELETE: history cannot be edited through the product (F4.3).
  return router;
}
