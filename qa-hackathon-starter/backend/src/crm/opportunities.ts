// Opportunities (F2.1, F2.4, F2.5, F2.7, F1.4) and saved lists (F2.6).
import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { audit } from "../audit/audit.ts";
import { tx, type Db } from "../db.ts";
import { HttpError, paginate, validationMessage } from "../http.ts";
import { maskValue, type Permission } from "../auth/permissions.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { loadMember, requirePermission } from "../middleware/requirePermission.ts";
import { recordLeadAction } from "../leads/service.ts";
import { assertVersion, fieldDefsFor, logActivity, readCustomFields, saveCustomFields, typedValue } from "./common.ts";
import { criteriaFromQuery, criteriaSchema, csvCell, queryContacts, queryOpportunities } from "./queries.ts";

const customFieldsSchema = z.record(z.string().max(64), z.unknown());
const createSchema = z.object({
  contactId: z.string().min(1).max(64),
  pipelineId: z.string().min(1).max(64),
  stageId: z.string().max(64).optional(),
  name: z.string().trim().min(1).max(150),
  value: z.number().finite().min(0).max(1e12).nullish(),
  currency: z.string().trim().length(3).toUpperCase().default("USD"),
  ownerId: z.string().max(64).nullish(),
  customFields: customFieldsSchema.default({}),
});
const patchSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(150).optional(),
  value: z.number().finite().min(0).max(1e12).nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  ownerId: z.string().max(64).nullable().optional(),
  customFields: customFieldsSchema.optional(),
});
const moveSchema = z.object({ stageId: z.string().min(1).max(64), version: z.number().int().min(1).optional(), customFields: customFieldsSchema.optional() });
const savedCreate = z.object({ entity: z.enum(["contact", "opportunity"]), name: z.string().trim().min(1).max(100), criteria: criteriaSchema });

interface OppRow {
  id: string; workspace_id: string; contact_id: string; pipeline_id: string; stage_id: string; name: string;
  value: number | null; currency: string; owner_id: string | null; version: number; created_at: string; updated_at: string;
}

const getOpp = (db: Db, workspaceId: string, id: string) => db.prepare("SELECT * FROM opportunities WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as OppRow | undefined;
const bad = (res: Response, err: z.ZodError) => res.status(400).json({ error: { code: "VALIDATION_ERROR", message: validationMessage(err) } });

function mustSetValue(perms: readonly Permission[], value: unknown) {
  if (value !== undefined && !perms.includes("viewOpportunityValue")) {
    throw new HttpError(403, "FORBIDDEN", "You do not have permission to set opportunity values.");
  }
}

// F2.4: entering a stage is blocked, with a clear message, until its required fields are filled.
function assertRequiredFields(db: Db, workspaceId: string, oppId: string, stageId: string) {
  const stage = db.prepare("SELECT name FROM stages WHERE id = ?").get(stageId) as { name: string };
  const values = readCustomFields(db, oppId);
  const missing = (db.prepare(
    `SELECT d.id, d.name FROM stage_required_fields r JOIN custom_field_definitions d ON d.id = r.field_id WHERE r.stage_id = ? ORDER BY d.position`,
  ).all(stageId) as { id: string; name: string }[]).filter((f) => values[f.id] === undefined || values[f.id] === "");
  if (missing.length) {
    throw new HttpError(422, "REQUIRED_FIELDS_MISSING", `Fill in ${missing.map((m) => m.name).join(", ")} before moving to "${stage.name}".`, { fields: missing });
  }
}

function assertStageInPipeline(db: Db, workspaceId: string, stageId: string, pipelineId: string) {
  const s = db.prepare("SELECT id FROM stages WHERE workspace_id = ? AND id = ? AND pipeline_id = ?").get(workspaceId, stageId, pipelineId);
  if (!s) throw new HttpError(400, "VALIDATION_ERROR", "That stage does not belong to this opportunity's pipeline.");
}

function requireOwnerOrNull(db: Db, workspaceId: string, userId: string | null | undefined) {
  if (userId && !db.prepare("SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND removed_at IS NULL").get(workspaceId, userId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "ownerId must be a member of this workspace.");
  }
}

const snap = (o: OppRow, perms: readonly Permission[]) => ({ name: o.name, value: maskValue(o.value, perms) === null ? undefined : o.value, currency: o.currency, ownerId: o.owner_id, stageId: o.stage_id });
// Audit snapshots keep the real value (value is redacted again when the audit log is read without permission).
const auditSnap = (o: OppRow) => ({ name: o.name, value: o.value, currency: o.currency, ownerId: o.owner_id, stageId: o.stage_id });

export function opportunitiesRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  router.get("/", requirePermission(db, "crmView"), (req, res) => {
    const { workspaceId } = req.session!;
    const { page, pageSize, offset } = paginate(req.query);
    const { items, total } = queryOpportunities(db, workspaceId, req.member!.permissions, criteriaFromQuery({ ...req.query, q: req.query.search ?? req.query.q }), { limit: pageSize, offset });
    res.json({ items, page, pageSize, total });
  });

  router.get("/export.csv", requirePermission(db, "crmExport"), (req, res) => {
    const { workspaceId, userId } = req.session!;
    const { items } = queryOpportunities(db, workspaceId, req.member!.permissions, criteriaFromQuery(req.query), { limit: 10000, offset: 0 });
    const rows = [
      ["Name", "Contact", "Company", "Pipeline", "Stage", "Value", "Currency", "Owner"],
      // The value is masked in exports exactly like in lists and detail pages (F1.4).
      ...items.map((o) => [o.name, o.contact, o.company, o.pipeline, o.stage, o.valueHidden ? "(hidden)" : o.value, o.currency, o.owner]),
    ];
    audit(db, { workspaceId, actorId: userId, action: "opportunity.exported", targetType: "opportunity", after: { rows: items.length } });
    res.type("text/csv").send(rows.map((r) => r.map(csvCell).join(",")).join("\r\n"));
  });

  router.post("/", requirePermission(db, "crmCreate"), (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    const d = parsed.data;
    const perms = req.member!.permissions;
    const id = randomUUID();
    tx(db, () => {
      mustSetValue(perms, d.value);
      if (!db.prepare("SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ?").get(workspaceId, d.contactId)) throw new HttpError(400, "VALIDATION_ERROR", "contactId does not exist in this workspace.");
      if (!db.prepare("SELECT 1 FROM pipelines WHERE workspace_id = ? AND id = ?").get(workspaceId, d.pipelineId)) throw new HttpError(400, "VALIDATION_ERROR", "pipelineId does not exist in this workspace.");
      requireOwnerOrNull(db, workspaceId, d.ownerId);
      const stageId = d.stageId ?? (db.prepare("SELECT id FROM stages WHERE pipeline_id = ? ORDER BY position LIMIT 1").get(d.pipelineId) as { id: string } | undefined)?.id;
      if (!stageId) throw new HttpError(409, "NO_STAGES", "This pipeline has no stages.");
      assertStageInPipeline(db, workspaceId, stageId, d.pipelineId);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO opportunities (id, workspace_id, contact_id, pipeline_id, stage_id, name, value, currency, owner_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, workspaceId, d.contactId, d.pipelineId, stageId, d.name, d.value ?? null, d.currency, d.ownerId ?? null, now, now);
      saveCustomFields(db, workspaceId, "opportunity", id, d.pipelineId, d.customFields);
      assertRequiredFields(db, workspaceId, id, stageId); // creating straight into a gated stage is also blocked
      logActivity(db, { workspaceId, contactId: d.contactId, opportunityId: id, type: "opportunity", text: `Opportunity "${d.name}" created.`, actorId: userId });
      audit(db, { workspaceId, actorId: userId, action: "opportunity.created", targetType: "opportunity", targetId: id, after: auditSnap(getOpp(db, workspaceId, id)!) });
      recordLeadAction(db, workspaceId, d.contactId, userId);
    });
    res.status(201).json(opportunityDetail(db, workspaceId, id, perms));
  });

  router.get("/:id", requirePermission(db, "crmView"), (req, res) => {
    res.json(opportunityDetail(db, req.session!.workspaceId, String(req.params.id), req.member!.permissions));
  });

  router.patch("/:id", requirePermission(db, "crmEdit"), (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    const d = parsed.data;
    const perms = req.member!.permissions;
    tx(db, () => {
      const cur = getOpp(db, workspaceId, String(req.params.id));
      if (!cur) throw new HttpError(404, "NOT_FOUND", "Opportunity not found.");
      assertVersion(cur.version, d.version);
      mustSetValue(perms, d.value);
      if (d.ownerId !== undefined) requireOwnerOrNull(db, workspaceId, d.ownerId);
      db.prepare("UPDATE opportunities SET name = ?, value = ?, currency = ?, owner_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(
        d.name ?? cur.name, d.value === undefined ? cur.value : d.value, d.currency ?? cur.currency, d.ownerId === undefined ? cur.owner_id : d.ownerId, new Date().toISOString(), cur.id, cur.version,
      );
      const fieldChanges = d.customFields ? saveCustomFields(db, workspaceId, "opportunity", cur.id, cur.pipeline_id, d.customFields) : [];
      const next = getOpp(db, workspaceId, cur.id)!;
      const changed = Object.entries(auditSnap(cur)).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((auditSnap(next) as Record<string, unknown>)[k])).map(([k]) => k);
      if (changed.length || fieldChanges.length) {
        // The history text never states the value, so it cannot leak it (F1.4).
        logActivity(db, { workspaceId, contactId: cur.contact_id, opportunityId: cur.id, type: "field_edit", text: `Updated ${[...changed, ...fieldChanges.map((c) => c.split(":")[0])].join(", ")}.`, actorId: userId });
        audit(db, { workspaceId, actorId: userId, action: "opportunity.updated", targetType: "opportunity", targetId: cur.id, before: auditSnap(cur), after: auditSnap(next) });
        recordLeadAction(db, workspaceId, cur.contact_id, userId);
      }
    });
    res.json(opportunityDetail(db, workspaceId, String(req.params.id), perms));
  });

  // Moving between stages on the board or list (F2.5) with required-field gating (F2.4).
  router.post("/:id/move", requirePermission(db, "crmEdit"), (req, res) => {
    const parsed = moveSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const cur = getOpp(db, workspaceId, String(req.params.id));
      if (!cur) throw new HttpError(404, "NOT_FOUND", "Opportunity not found.");
      if (parsed.data.version !== undefined) assertVersion(cur.version, parsed.data.version);
      assertStageInPipeline(db, workspaceId, parsed.data.stageId, cur.pipeline_id);
      if (parsed.data.customFields) saveCustomFields(db, workspaceId, "opportunity", cur.id, cur.pipeline_id, parsed.data.customFields);
      if (parsed.data.stageId === cur.stage_id) return;
      assertRequiredFields(db, workspaceId, cur.id, parsed.data.stageId); // throws 422 -> whole transaction rolls back
      const names = db.prepare("SELECT (SELECT name FROM stages WHERE id = ?) AS from_name, (SELECT name FROM stages WHERE id = ?) AS to_name").get(cur.stage_id, parsed.data.stageId) as { from_name: string; to_name: string };
      db.prepare("UPDATE opportunities SET stage_id = ?, version = version + 1, updated_at = ? WHERE id = ?").run(parsed.data.stageId, new Date().toISOString(), cur.id);
      logActivity(db, { workspaceId, contactId: cur.contact_id, opportunityId: cur.id, type: "stage_change", text: `Moved from "${names.from_name}" to "${names.to_name}".`, actorId: userId });
      audit(db, { workspaceId, actorId: userId, action: "opportunity.stage_changed", targetType: "opportunity", targetId: cur.id, before: { stageId: cur.stage_id, stage: names.from_name }, after: { stageId: parsed.data.stageId, stage: names.to_name } });
      recordLeadAction(db, workspaceId, cur.contact_id, userId); // a stage change counts as acknowledgement
    });
    res.json(opportunityDetail(db, workspaceId, String(req.params.id), req.member!.permissions));
  });

  router.delete("/:id", requirePermission(db, "crmDelete"), (req, res) => {
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const cur = getOpp(db, workspaceId, String(req.params.id));
      if (!cur) throw new HttpError(404, "NOT_FOUND", "Opportunity not found.");
      const payments = (db.prepare("SELECT COUNT(*) AS n FROM payments WHERE opportunity_id = ?").get(cur.id) as { n: number }).n;
      if (payments > 0) throw new HttpError(409, "HAS_RELATED_RECORDS", "This opportunity has payments and cannot be deleted.", { payments });
      db.prepare("DELETE FROM custom_field_values WHERE entity_id = ?").run(cur.id);
      db.prepare("DELETE FROM opportunities WHERE id = ?").run(cur.id);
      logActivity(db, { workspaceId, contactId: cur.contact_id, type: "opportunity", text: `Opportunity "${cur.name}" deleted.`, actorId: userId });
      audit(db, { workspaceId, actorId: userId, action: "opportunity.deleted", targetType: "opportunity", targetId: cur.id, before: auditSnap(cur) });
    });
    res.status(204).end();
  });

  return router;
}

export function opportunityDetail(db: Db, workspaceId: string, id: string, perms: readonly Permission[]) {
  const o = getOpp(db, workspaceId, id);
  if (!o) throw new HttpError(404, "NOT_FOUND", "Opportunity not found.");
  const contact = db.prepare("SELECT c.id, c.name, co.name AS company FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = ?").get(o.contact_id) as { id: string; name: string; company: string | null };
  const pipeline = db.prepare("SELECT id, name FROM pipelines WHERE id = ?").get(o.pipeline_id) as { id: string; name: string };
  const stages = db.prepare("SELECT id, name, kind, position FROM stages WHERE pipeline_id = ? ORDER BY position").all(o.pipeline_id) as { id: string; name: string; kind: string; position: number }[];
  const values = readCustomFields(db, o.id);
  const required = new Map<string, string[]>();
  for (const r of db.prepare("SELECT stage_id, field_id FROM stage_required_fields WHERE stage_id IN (SELECT id FROM stages WHERE pipeline_id = ?)").all(o.pipeline_id) as { stage_id: string; field_id: string }[]) {
    required.set(r.stage_id, [...(required.get(r.stage_id) ?? []), r.field_id]);
  }
  const activities = (db.prepare(
    `SELECT a.id, a.type, a.text, a.created_at, u.name AS actor FROM activities a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.workspace_id = ? AND a.opportunity_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 500`,
  ).all(workspaceId, o.id) as Record<string, unknown>[]).map((a) => ({ id: a.id, type: a.type, text: a.text, actor: a.actor ?? "System", at: a.created_at }));
  return {
    opportunity: {
      id: o.id, name: o.name, value: maskValue(o.value, perms), valueHidden: !perms.includes("viewOpportunityValue"), currency: o.currency,
      ownerId: o.owner_id, stageId: o.stage_id, version: o.version, createdAt: o.created_at, updatedAt: o.updated_at, contact, pipeline,
      customFields: fieldDefsFor(db, workspaceId, "opportunity", o.pipeline_id).map((d) => ({ id: d.id, name: d.name, type: d.field_type, options: JSON.parse(d.options), value: values[d.id] === undefined ? null : typedValue(d, values[d.id]!) })),
    },
    stages: stages.map((s) => ({ ...s, requiredFieldIds: required.get(s.id) ?? [] })),
    payments: (db.prepare("SELECT id, amount, currency, status, provider_reference, created_at FROM payments WHERE opportunity_id = ? ORDER BY created_at DESC").all(o.id) as Record<string, unknown>[]).map((p) => ({
      id: p.id, amount: Number(p.amount) / 100, currency: p.currency, status: p.status, providerReference: p.provider_reference, createdAt: p.created_at,
    })),
    appointments: (db.prepare("SELECT id, title, starts_at, ends_at, timezone, status FROM appointments WHERE opportunity_id = ? ORDER BY starts_at DESC").all(o.id) as Record<string, unknown>[]).map((a) => ({
      id: a.id, title: a.title, startsAt: a.starts_at, endsAt: a.ends_at, timezone: a.timezone, status: a.status,
    })),
    activities,
  };
}

// ----- Saved lists (F2.6): criteria are stored, results are recomputed on every read -----
export function savedFiltersRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db), requirePermission(db, "crmView"));

  router.get("/", (req, res) => {
    const { workspaceId } = req.session!;
    const entity = typeof req.query.entity === "string" ? req.query.entity : null;
    const rows = db.prepare(`SELECT id, entity, name, criteria, created_by, created_at FROM saved_filters WHERE workspace_id = ? ${entity ? "AND entity = ?" : ""} ORDER BY name`).all(...(entity ? [workspaceId, entity] : [workspaceId])) as Record<string, unknown>[];
    res.json({ items: rows.map((r) => ({ id: r.id, entity: r.entity, name: r.name, criteria: JSON.parse(String(r.criteria)), createdBy: r.created_by, createdAt: r.created_at })) });
  });

  router.post("/", (req, res) => {
    const parsed = savedCreate.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    const id = randomUUID();
    tx(db, () => {
      db.prepare("INSERT INTO saved_filters (id, workspace_id, entity, name, criteria, created_by, created_at) VALUES (?,?,?,?,?,?,?)").run(id, workspaceId, parsed.data.entity, parsed.data.name, JSON.stringify(parsed.data.criteria), userId, new Date().toISOString());
      audit(db, { workspaceId, actorId: userId, action: "saved_filter.created", targetType: "saved_filter", targetId: id, after: { name: parsed.data.name, entity: parsed.data.entity } });
    });
    res.status(201).json({ id, ...parsed.data });
  });

  router.get("/:id/results", (req, res) => {
    const { workspaceId } = req.session!;
    const f = db.prepare("SELECT entity, criteria FROM saved_filters WHERE workspace_id = ? AND id = ?").get(workspaceId, String(req.params.id)) as { entity: string; criteria: string } | undefined;
    if (!f) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Saved list not found." } });
    const { page, pageSize, offset } = paginate(req.query);
    const criteria = criteriaSchema.parse(JSON.parse(f.criteria));
    const result = f.entity === "contact"
      ? queryContacts(db, workspaceId, criteria, { limit: pageSize, offset })
      : queryOpportunities(db, workspaceId, req.member!.permissions, criteria, { limit: pageSize, offset });
    res.json({ entity: f.entity, items: result.items, page, pageSize, total: result.total });
  });

  router.delete("/:id", (req, res) => {
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const f = db.prepare("SELECT id, name, created_by FROM saved_filters WHERE workspace_id = ? AND id = ?").get(workspaceId, String(req.params.id)) as { id: string; name: string; created_by: string } | undefined;
      if (!f) throw new HttpError(404, "NOT_FOUND", "Saved list not found.");
      if (f.created_by !== userId && req.member!.baseLevel === "user") throw new HttpError(403, "FORBIDDEN", "Only the creator or an Admin can delete this list.");
      db.prepare("DELETE FROM saved_filters WHERE id = ?").run(f.id);
      audit(db, { workspaceId, actorId: userId, action: "saved_filter.deleted", targetType: "saved_filter", targetId: f.id, before: { name: f.name } });
    });
    res.status(204).end();
  });

  return router;
}
