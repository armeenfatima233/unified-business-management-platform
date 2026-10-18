// CRM configuration done by Admins from the interface, no code (F2.2-F2.5): pipelines, stages and
// custom fields. Every change is audited (F4.1) and deletions never leave orphaned data (Q4).
import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { audit } from "../audit/audit.ts";
import { tx, type Db } from "../db.ts";
import { HttpError, validationMessage } from "../http.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { loadMember, requirePermission } from "../middleware/requirePermission.ts";
import { logActivity } from "./common.ts";

// Configuration is for Owner/Admin ("delegated to configure the system").
function requireAdmin(db: Db) {
  const load = loadMember(db);
  return (req: Request, res: Response, next: NextFunction) =>
    load(req, res, () => {
      if (req.member!.baseLevel === "user") return res.status(403).json({ error: { code: "FORBIDDEN", message: "Only an Owner or Admin can change the CRM setup." } });
      next();
    });
}

const kind = z.enum(["open", "won", "lost"]);
const pipelineBody = z.object({ name: z.string().trim().min(1).max(80) });
const stageCreate = z.object({ name: z.string().trim().min(1).max(80), kind: kind.default("open"), position: z.number().int().min(0).optional() });
const stagePatch = z.object({ name: z.string().trim().min(1).max(80).optional(), kind: kind.optional() });
const orderBody = z.object({ stageIds: z.array(z.string().max(64)).min(1).max(100) });
const requiredBody = z.object({ fieldIds: z.array(z.string().max(64)).max(50) });
const fieldCreate = z.object({
  entityType: z.enum(["contact", "company", "opportunity"]),
  pipelineId: z.string().max(64).nullish(),
  name: z.string().trim().min(1).max(80),
  fieldType: z.enum(["text", "number", "date", "dropdown", "checkbox"]),
  options: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
});
const fieldPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  options: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  position: z.number().int().min(0).optional(),
});

const bad = (res: Response, err: z.ZodError) => res.status(400).json({ error: { code: "VALIDATION_ERROR", message: validationMessage(err) } });

function stagesOf(db: Db, workspaceId: string, pipelineId: string) {
  return (db.prepare(
    `SELECT s.id, s.name, s.position, s.kind, (SELECT COUNT(*) FROM opportunities o WHERE o.stage_id = s.id) AS opportunities
     FROM stages s WHERE s.workspace_id = ? AND s.pipeline_id = ? ORDER BY s.position`,
  ).all(workspaceId, pipelineId) as Record<string, unknown>[]).map((s) => ({
    id: s.id, name: s.name, position: s.position, kind: s.kind, opportunities: s.opportunities,
    requiredFieldIds: (db.prepare("SELECT field_id FROM stage_required_fields WHERE stage_id = ?").all(s.id as string) as { field_id: string }[]).map((r) => r.field_id),
  }));
}

function getPipeline(db: Db, workspaceId: string, id: string) {
  const p = db.prepare("SELECT id, name FROM pipelines WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as { id: string; name: string } | undefined;
  if (!p) throw new HttpError(404, "NOT_FOUND", "Pipeline not found.");
  return p;
}

function renumber(db: Db, pipelineId: string, orderedIds: string[]) {
  // Two passes avoid transient clashes if a unique index on position is ever added.
  orderedIds.forEach((id, i) => db.prepare("UPDATE stages SET position = ? WHERE id = ? AND pipeline_id = ?").run(i, id, pipelineId));
}

export function pipelinesRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  router.get("/", requirePermission(db, "crmView"), (req, res) => {
    const { workspaceId } = req.session!;
    const items = (db.prepare("SELECT id, name FROM pipelines WHERE workspace_id = ? ORDER BY created_at, rowid").all(workspaceId) as { id: string; name: string }[]).map((p) => ({ ...p, stages: stagesOf(db, workspaceId, p.id) }));
    res.json({ items });
  });

  router.post("/", requireAdmin(db), (req, res) => {
    const parsed = pipelineBody.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    const id = randomUUID();
    tx(db, () => {
      db.prepare("INSERT INTO pipelines (id, workspace_id, name, created_at) VALUES (?,?,?,?)").run(id, workspaceId, parsed.data.name, new Date().toISOString());
      // A new pipeline starts with the standard stage set so it is usable straight away.
      ["New", "Qualified", "Won", "Lost"].forEach((name, i) =>
        db.prepare("INSERT INTO stages (id, workspace_id, pipeline_id, name, position, kind) VALUES (?,?,?,?,?,?)").run(randomUUID(), workspaceId, id, name, i, name === "Won" ? "won" : name === "Lost" ? "lost" : "open"));
      audit(db, { workspaceId, actorId: userId, action: "pipeline.created", targetType: "pipeline", targetId: id, after: { name: parsed.data.name } });
    });
    res.status(201).json({ id, name: parsed.data.name, stages: stagesOf(db, workspaceId, id) });
  });

  router.patch("/:id", requireAdmin(db), (req, res) => {
    const parsed = pipelineBody.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    const p = getPipeline(db, workspaceId, String(req.params.id));
    tx(db, () => {
      db.prepare("UPDATE pipelines SET name = ? WHERE id = ?").run(parsed.data.name, p.id);
      audit(db, { workspaceId, actorId: userId, action: "pipeline.renamed", targetType: "pipeline", targetId: p.id, before: { name: p.name }, after: { name: parsed.data.name } });
    });
    res.json({ id: p.id, name: parsed.data.name, stages: stagesOf(db, workspaceId, p.id) });
  });

  router.delete("/:id", requireAdmin(db), (req, res) => {
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const p = getPipeline(db, workspaceId, String(req.params.id));
      const n = (db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE pipeline_id = ?").get(p.id) as { n: number }).n;
      if (n > 0) throw new HttpError(409, "PIPELINE_NOT_EMPTY", `This pipeline still has ${n} opportunit${n === 1 ? "y" : "ies"}. Move or delete them first.`, { opportunities: n });
      const only = (db.prepare("SELECT COUNT(*) AS n FROM pipelines WHERE workspace_id = ?").get(workspaceId) as { n: number }).n;
      if (only <= 1) throw new HttpError(409, "LAST_PIPELINE", "A workspace needs at least one pipeline.");
      db.prepare("DELETE FROM custom_field_values WHERE field_id IN (SELECT id FROM custom_field_definitions WHERE pipeline_id = ?)").run(p.id);
      db.prepare("DELETE FROM custom_field_definitions WHERE pipeline_id = ?").run(p.id); // pipeline-scoped fields go with it
      db.prepare("DELETE FROM stages WHERE pipeline_id = ?").run(p.id);
      db.prepare("DELETE FROM pipelines WHERE id = ?").run(p.id);
      audit(db, { workspaceId, actorId: userId, action: "pipeline.deleted", targetType: "pipeline", targetId: p.id, before: { name: p.name } });
    });
    res.status(204).end();
  });

  router.post("/:id/stages", requireAdmin(db), (req, res) => {
    const parsed = stageCreate.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    const id = randomUUID();
    tx(db, () => {
      const p = getPipeline(db, workspaceId, String(req.params.id));
      const existing = (db.prepare("SELECT id FROM stages WHERE pipeline_id = ? ORDER BY position").all(p.id) as { id: string }[]).map((s) => s.id);
      db.prepare("INSERT INTO stages (id, workspace_id, pipeline_id, name, position, kind) VALUES (?,?,?,?,?,?)").run(id, workspaceId, p.id, parsed.data.name, existing.length, parsed.data.kind);
      const at = Math.min(parsed.data.position ?? existing.length, existing.length);
      existing.splice(at, 0, id);
      renumber(db, p.id, existing);
      audit(db, { workspaceId, actorId: userId, action: "stage.created", targetType: "stage", targetId: id, after: { name: parsed.data.name, kind: parsed.data.kind, pipelineId: p.id } });
    });
    res.status(201).json({ stages: stagesOf(db, workspaceId, String(req.params.id)) });
  });

  router.put("/:id/stages/order", requireAdmin(db), (req, res) => {
    const parsed = orderBody.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const p = getPipeline(db, workspaceId, String(req.params.id));
      const current = (db.prepare("SELECT id FROM stages WHERE pipeline_id = ? ORDER BY position").all(p.id) as { id: string }[]).map((s) => s.id);
      const same = current.length === parsed.data.stageIds.length && current.every((id) => parsed.data.stageIds.includes(id)) && new Set(parsed.data.stageIds).size === current.length;
      if (!same) throw new HttpError(400, "VALIDATION_ERROR", "stageIds must list every stage of this pipeline exactly once.");
      renumber(db, p.id, parsed.data.stageIds);
      audit(db, { workspaceId, actorId: userId, action: "stage.reordered", targetType: "pipeline", targetId: p.id, before: { order: current }, after: { order: parsed.data.stageIds } });
    });
    res.json({ stages: stagesOf(db, workspaceId, String(req.params.id)) });
  });

  return router;
}

export function stagesRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db), requireAdmin(db));

  const getStage = (workspaceId: string, id: string) => {
    const s = db.prepare("SELECT id, name, kind, pipeline_id, position FROM stages WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as { id: string; name: string; kind: string; pipeline_id: string; position: number } | undefined;
    if (!s) throw new HttpError(404, "NOT_FOUND", "Stage not found.");
    return s;
  };

  router.patch("/:id", (req, res) => {
    const parsed = stagePatch.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const s = getStage(workspaceId, String(req.params.id));
      const name = parsed.data.name ?? s.name;
      const k = parsed.data.kind ?? s.kind;
      db.prepare("UPDATE stages SET name = ?, kind = ? WHERE id = ?").run(name, k, s.id);
      audit(db, { workspaceId, actorId: userId, action: "stage.updated", targetType: "stage", targetId: s.id, before: { name: s.name, kind: s.kind }, after: { name, kind: k } });
    });
    res.json({ stages: stagesOf(db, workspaceId, getStage(workspaceId, String(req.params.id)).pipeline_id) });
  });

  // Deleting a stage that holds opportunities moves them to `moveTo` first, in one transaction (F2.5).
  router.delete("/:id", (req, res) => {
    const { workspaceId, userId } = req.session!;
    const moveTo = typeof req.query.moveTo === "string" ? req.query.moveTo : "";
    let pipelineId = "";
    tx(db, () => {
      const s = getStage(workspaceId, String(req.params.id));
      pipelineId = s.pipeline_id;
      const siblings = (db.prepare("SELECT id FROM stages WHERE pipeline_id = ? ORDER BY position").all(s.pipeline_id) as { id: string }[]).map((r) => r.id);
      if (siblings.length <= 1) throw new HttpError(409, "LAST_STAGE", "A pipeline needs at least one stage.");
      const opps = db.prepare("SELECT o.id, o.contact_id FROM opportunities o WHERE o.stage_id = ?").all(s.id) as { id: string; contact_id: string }[];
      if (opps.length > 0) {
        if (!moveTo) throw new HttpError(409, "STAGE_NOT_EMPTY", `This stage holds ${opps.length} opportunit${opps.length === 1 ? "y" : "ies"}. Choose a stage to move them to (moveTo).`, { opportunities: opps.length });
        const target = db.prepare("SELECT id, name FROM stages WHERE workspace_id = ? AND id = ? AND pipeline_id = ?").get(workspaceId, moveTo, s.pipeline_id) as { id: string; name: string } | undefined;
        if (!target || target.id === s.id) throw new HttpError(400, "VALIDATION_ERROR", "moveTo must be another stage of the same pipeline.");
        db.prepare("UPDATE opportunities SET stage_id = ?, version = version + 1, updated_at = ? WHERE stage_id = ?").run(target.id, new Date().toISOString(), s.id);
        for (const o of opps) logActivity(db, { workspaceId, contactId: o.contact_id, opportunityId: o.id, type: "stage_change", text: `Stage "${s.name}" was removed; moved to "${target.name}".`, actorId: userId });
      }
      db.prepare("DELETE FROM stage_required_fields WHERE stage_id = ?").run(s.id);
      db.prepare("DELETE FROM stages WHERE id = ?").run(s.id);
      renumber(db, s.pipeline_id, siblings.filter((id) => id !== s.id));
      audit(db, { workspaceId, actorId: userId, action: "stage.deleted", targetType: "stage", targetId: s.id, before: { name: s.name, kind: s.kind }, after: { movedOpportunities: opps.length, movedTo: moveTo || null } });
    });
    res.json({ stages: stagesOf(db, workspaceId, pipelineId) });
  });

  // Fields that must be filled before an opportunity may enter this stage (F2.4).
  router.put("/:id/required-fields", (req, res) => {
    const parsed = requiredBody.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const s = getStage(workspaceId, String(req.params.id));
      for (const fieldId of parsed.data.fieldIds) {
        const f = db.prepare("SELECT 1 FROM custom_field_definitions WHERE workspace_id = ? AND id = ? AND entity_type = 'opportunity' AND (pipeline_id IS NULL OR pipeline_id = ?)").get(workspaceId, fieldId, s.pipeline_id);
        if (!f) throw new HttpError(400, "VALIDATION_ERROR", "Each required field must be an opportunity field available in this pipeline.");
      }
      const before = (db.prepare("SELECT field_id FROM stage_required_fields WHERE stage_id = ?").all(s.id) as { field_id: string }[]).map((r) => r.field_id);
      db.prepare("DELETE FROM stage_required_fields WHERE stage_id = ?").run(s.id);
      for (const fieldId of new Set(parsed.data.fieldIds)) db.prepare("INSERT INTO stage_required_fields (workspace_id, stage_id, field_id) VALUES (?,?,?)").run(workspaceId, s.id, fieldId);
      audit(db, { workspaceId, actorId: userId, action: "stage.required_fields_changed", targetType: "stage", targetId: s.id, before: { fieldIds: before }, after: { fieldIds: parsed.data.fieldIds } });
    });
    res.json({ stages: stagesOf(db, workspaceId, getStage(workspaceId, String(req.params.id)).pipeline_id) });
  });

  return router;
}

export function customFieldsRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  const present = (d: Record<string, unknown>) => ({
    id: d.id, entityType: d.entity_type, pipelineId: d.pipeline_id, name: d.name, fieldType: d.field_type, options: JSON.parse(String(d.options)), position: d.position,
  });

  router.get("/", requirePermission(db, "crmView"), (req, res) => {
    const { workspaceId } = req.session!;
    const where = ["workspace_id = ?"];
    const args: string[] = [workspaceId];
    if (typeof req.query.entity === "string" && req.query.entity) { where.push("entity_type = ?"); args.push(req.query.entity); }
    if (typeof req.query.pipelineId === "string" && req.query.pipelineId) { where.push("(pipeline_id IS NULL OR pipeline_id = ?)"); args.push(req.query.pipelineId); }
    const rows = db.prepare(`SELECT * FROM custom_field_definitions WHERE ${where.join(" AND ")} ORDER BY position, created_at`).all(...args) as Record<string, unknown>[];
    res.json({ items: rows.map(present) });
  });

  router.post("/", requireAdmin(db), (req, res) => {
    const parsed = fieldCreate.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    const d = parsed.data;
    const id = randomUUID();
    tx(db, () => {
      if (d.pipelineId) getPipeline(db, workspaceId, d.pipelineId);
      if (d.pipelineId && d.entityType !== "opportunity") throw new HttpError(400, "VALIDATION_ERROR", "Only opportunity fields can belong to a single pipeline.");
      if (d.fieldType === "dropdown" && d.options.length === 0) throw new HttpError(400, "VALIDATION_ERROR", "A dropdown needs at least one option.");
      const dup = db.prepare("SELECT 1 FROM custom_field_definitions WHERE workspace_id = ? AND entity_type = ? AND lower(name) = lower(?) AND ifnull(pipeline_id,'') = ifnull(?, '')").get(workspaceId, d.entityType, d.name, d.pipelineId ?? null);
      if (dup) throw new HttpError(409, "DUPLICATE_FIELD", "A field with this name already exists here.");
      const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM custom_field_definitions WHERE workspace_id = ? AND entity_type = ?").get(workspaceId, d.entityType) as { n: number }).n;
      db.prepare("INSERT INTO custom_field_definitions (id, workspace_id, pipeline_id, entity_type, name, field_type, options, position, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
        id, workspaceId, d.pipelineId ?? null, d.entityType, d.name, d.fieldType, JSON.stringify(d.fieldType === "dropdown" ? d.options : []), position, new Date().toISOString(),
      );
      audit(db, { workspaceId, actorId: userId, action: "custom_field.created", targetType: "custom_field", targetId: id, after: { name: d.name, entityType: d.entityType, fieldType: d.fieldType, pipelineId: d.pipelineId ?? null } });
    });
    res.status(201).json(present(db.prepare("SELECT * FROM custom_field_definitions WHERE id = ?").get(id) as Record<string, unknown>));
  });

  router.patch("/:id", requireAdmin(db), (req, res) => {
    const parsed = fieldPatch.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const f = db.prepare("SELECT * FROM custom_field_definitions WHERE workspace_id = ? AND id = ?").get(workspaceId, String(req.params.id)) as Record<string, unknown> | undefined;
      if (!f) throw new HttpError(404, "NOT_FOUND", "Field not found.");
      let options = f.options as string;
      if (parsed.data.options) {
        if (f.field_type !== "dropdown") throw new HttpError(400, "VALIDATION_ERROR", "Only dropdown fields have options.");
        const removed = (JSON.parse(options) as string[]).filter((o) => !parsed.data.options!.includes(o));
        for (const o of removed) {
          const used = (db.prepare("SELECT COUNT(*) AS n FROM custom_field_values WHERE field_id = ? AND value = ?").get(f.id as string, o) as { n: number }).n;
          if (used > 0) throw new HttpError(409, "OPTION_IN_USE", `The option "${o}" is used by ${used} record(s). Change those records first.`, { option: o, records: used });
        }
        options = JSON.stringify(parsed.data.options);
      }
      const name = parsed.data.name ?? (f.name as string);
      db.prepare("UPDATE custom_field_definitions SET name = ?, options = ?, position = ? WHERE id = ?").run(name, options, parsed.data.position ?? (f.position as number), f.id as string);
      audit(db, { workspaceId, actorId: userId, action: "custom_field.updated", targetType: "custom_field", targetId: f.id as string, before: { name: f.name, options: JSON.parse(String(f.options)) }, after: { name, options: JSON.parse(options) } });
    });
    res.json(present(db.prepare("SELECT * FROM custom_field_definitions WHERE id = ?").get(String(req.params.id)) as Record<string, unknown>));
  });

  router.delete("/:id", requireAdmin(db), (req, res) => {
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const f = db.prepare("SELECT * FROM custom_field_definitions WHERE workspace_id = ? AND id = ?").get(workspaceId, String(req.params.id)) as Record<string, unknown> | undefined;
      if (!f) throw new HttpError(404, "NOT_FOUND", "Field not found.");
      const values = (db.prepare("SELECT COUNT(*) AS n FROM custom_field_values WHERE field_id = ?").get(f.id as string) as { n: number }).n;
      db.prepare("DELETE FROM custom_field_values WHERE field_id = ?").run(f.id as string);
      db.prepare("DELETE FROM stage_required_fields WHERE field_id = ?").run(f.id as string); // no stage keeps requiring a field that is gone
      db.prepare("DELETE FROM custom_field_definitions WHERE id = ?").run(f.id as string);
      audit(db, { workspaceId, actorId: userId, action: "custom_field.deleted", targetType: "custom_field", targetId: f.id as string, before: { name: f.name, fieldType: f.field_type }, after: { removedValues: values } });
    });
    res.status(204).end();
  });

  return router;
}
