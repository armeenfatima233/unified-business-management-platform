// Lead endpoints (F3.1-F3.8), routing settings (F3.3-F3.5) and the public intake form (F3.1).
import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit/audit.ts";
import { findOrCreateContact } from "../crm/contactService.ts";
import { tx, type Db } from "../db.ts";
import { HttpError, paginate, validationMessage } from "../http.ts";
import { apiError, requireAuth } from "../middleware/requireAuth.ts";
import { loadMember, requirePermission } from "../middleware/requirePermission.ts";
import {
  acknowledgeLead, closeLead, createLead, getRules, leadDetail, listLeads, reassignLead,
} from "./service.ts";

const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(254).optional(),
});
const manualLeadSchema = z
  .object({ contactId: z.string().max(64).optional(), contact: contactSchema.optional(), message: z.string().trim().max(2000).optional() })
  .refine((v) => Boolean(v.contactId) !== Boolean(v.contact), { message: "Send either contactId or contact." });
const publicLeadSchema = contactSchema.extend({ message: z.string().trim().max(2000).optional() }).refine((v) => v.phone || v.email, {
  message: "Provide a phone number or an email address.",
});
const reassignSchema = z.object({ assigneeId: z.string().min(1).max(64) });
const rulesSchema = z.object({
  ackWindowSeconds: z.number().int().min(1).max(7 * 86400),
  maxOpenLeads: z.number().int().min(1).max(1000),
  escalationLevels: z.number().int().min(1).max(3),
  idleSeconds: z.number().int().min(1).max(30 * 86400),
  levelWindowSeconds: z.array(z.number().int().min(1).max(7 * 86400)).max(4).default([]),
  backupUserId: z.string().max(64).nullable(),
  managerUserId: z.string().max(64).nullable(),
});

const isManager = (permissions: readonly string[]) => permissions.includes("manageAssignmentRules");

export function leadsRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  router.get("/", (req, res) => {
    const { workspaceId, userId } = req.session!;
    const { page, pageSize, offset } = paginate(req.query);
    const scope = req.query.scope === "all" ? "all" : req.query.scope === "recovery" ? "recovery" : "mine";
    const { items, total } = listLeads(db, workspaceId, {
      scope, userId, canSeeAll: isManager(req.member!.permissions), q: typeof req.query.search === "string" ? req.query.search : undefined,
      includeClosed: req.query.includeClosed === "true", limit: pageSize, offset,
      createdFrom: typeof req.query.createdFrom === "string" ? req.query.createdFrom : undefined,
      escalatedSince: typeof req.query.escalatedSince === "string" ? req.query.escalatedSince : undefined,
    });
    res.json({ items, page, pageSize, total });
  });

  router.get("/recovery", (req, res) => {
    const { workspaceId, userId } = req.session!;
    const { page, pageSize, offset } = paginate(req.query);
    const { items, total } = listLeads(db, workspaceId, { scope: "recovery", userId, canSeeAll: isManager(req.member!.permissions), limit: pageSize, offset });
    res.json({ items, page, pageSize, total });
  });

  router.post("/", requirePermission(db, "crmCreate"), (req, res) => {
    const parsed = manualLeadSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", validationMessage(parsed.error));
    const { workspaceId, userId } = req.session!;
    const lead = tx(db, () => {
      let contactId = parsed.data.contactId;
      if (contactId) {
        if (!db.prepare("SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ?").get(workspaceId, contactId)) throw new HttpError(404, "NOT_FOUND", "Contact not found.");
      } else contactId = findOrCreateContact(db, workspaceId, parsed.data.contact!, userId).id;
      return createLead(db, { workspaceId, contactId, source: "manual", message: parsed.data.message, actorId: userId });
    });
    res.status(201).json(leadDetail(db, workspaceId, lead.id, userId, true));
  });

  router.get("/:id", (req, res) => {
    const { workspaceId, userId } = req.session!;
    res.json(leadDetail(db, workspaceId, String(req.params.id), userId, isManager(req.member!.permissions)));
  });

  router.post("/:id/acknowledge", (req, res) => {
    const { workspaceId, userId } = req.session!;
    const lead = acknowledgeLead(db, workspaceId, String(req.params.id), userId, isManager(req.member!.permissions));
    res.json({ leadId: lead.id, acknowledgedAt: lead.acknowledged_at, acknowledgedBy: userId });
  });

  router.post("/:id/reassign", requirePermission(db, "manageAssignmentRules"), (req, res) => {
    const parsed = reassignSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", validationMessage(parsed.error));
    const { workspaceId, userId } = req.session!;
    const lead = reassignLead(db, workspaceId, String(req.params.id), userId, parsed.data.assigneeId);
    res.json(leadDetail(db, workspaceId, lead.id, userId, true));
  });

  router.post("/:id/close", (req, res) => {
    const { workspaceId, userId } = req.session!;
    closeLead(db, workspaceId, String(req.params.id), userId, isManager(req.member!.permissions));
    res.json(leadDetail(db, workspaceId, String(req.params.id), userId, true));
  });

  return router;
}

// ----- Settings: routing rules and the public form key -----
export function leadSettingsRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  const rulesJson = (workspaceId: string) => {
    const r = getRules(db, workspaceId);
    return {
      ackWindowSeconds: r.ack_window_seconds, maxOpenLeads: r.max_open_leads, escalationLevels: r.escalation_levels, idleSeconds: r.idle_seconds,
      levelWindowSeconds: JSON.parse(r.level_window_seconds) as number[], backupUserId: r.backup_user_id, managerUserId: r.manager_user_id,
      strategy: "Round-robin among Available employees below the open-lead limit",
    };
  };

  router.get("/lead-routing", requirePermission(db, "manageAssignmentRules"), (req, res) => {
    res.json(rulesJson(req.session!.workspaceId));
  });

  router.put("/lead-routing", requirePermission(db, "manageAssignmentRules"), (req, res) => {
    const parsed = rulesSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", validationMessage(parsed.error));
    const { workspaceId, userId } = req.session!;
    const d = parsed.data;
    for (const id of [d.backupUserId, d.managerUserId]) {
      if (id && !db.prepare("SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND removed_at IS NULL").get(workspaceId, id)) {
        return apiError(res, 400, "VALIDATION_ERROR", "Backup and manager must be members of this workspace.");
      }
    }
    const before = rulesJson(workspaceId);
    getRules(db, workspaceId); // makes sure the row exists
    tx(db, () => {
      db.prepare(
        `UPDATE lead_routing_rules SET ack_window_seconds = ?, max_open_leads = ?, escalation_levels = ?, idle_seconds = ?, level_window_seconds = ?,
                backup_user_id = ?, manager_user_id = COALESCE(?, manager_user_id), updated_at = ? WHERE workspace_id = ?`,
      ).run(d.ackWindowSeconds, d.maxOpenLeads, d.escalationLevels, d.idleSeconds, JSON.stringify(d.levelWindowSeconds), d.backupUserId, d.managerUserId, new Date().toISOString(), workspaceId);
      audit(db, { workspaceId, actorId: userId, action: "routing_rules.updated", targetType: "workspace", targetId: workspaceId, before, after: rulesJson(workspaceId) });
    });
    res.json(rulesJson(workspaceId));
  });

  router.get("/public-form", requirePermission(db, "manageAssignmentRules"), (req, res) => {
    const row = db.prepare("SELECT public_key FROM workspaces WHERE id = ?").get(req.session!.workspaceId) as { public_key: string };
    res.json({ publicKey: row.public_key, submitPath: `/api/v1/public/leads/${row.public_key}` });
  });

  return router;
}

// ----- Public web form (F3.1): no session, so the workspace comes from an unguessable form key.
// The source label is set here on the server and is never taken from the request.
const hits = new Map<string, number[]>();
function allow(key: string, limit = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length <= limit;
}

export function publicLeadsRouter(db: Db) {
  const router = Router();
  router.post("/leads/:publicKey", (req, res) => {
    if (!allow(`${req.ip}|${req.params.publicKey}`)) return apiError(res, 429, "RATE_LIMITED", "Too many submissions. Please try again shortly.");
    const parsed = publicLeadSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", validationMessage(parsed.error));
    const ws = db.prepare("SELECT id FROM workspaces WHERE public_key = ?").get(String(req.params.publicKey)) as { id: string } | undefined;
    if (!ws) return apiError(res, 404, "NOT_FOUND", "Form not found.");
    const lead = tx(db, () => {
      const contact = findOrCreateContact(db, ws.id, parsed.data, null);
      return createLead(db, { workspaceId: ws.id, contactId: contact.id, source: "web_form", message: parsed.data.message, actorId: null });
    });
    res.status(201).json({ received: true, reference: lead.id });
  });
  return router;
}
