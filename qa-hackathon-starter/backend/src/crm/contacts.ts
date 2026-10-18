// Contacts and companies (F2.1, F2.2, F2.7, F2.8). Permissions are enforced on every route and the
// workspace always comes from the session (F1.5, F1.6).
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit/audit.ts";
import { tx, type Db } from "../db.ts";
import { HttpError, normalizePhone, paginate, validationMessage } from "../http.ts";
import { maskValue } from "../auth/permissions.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { loadMember, requirePermission } from "../middleware/requirePermission.ts";
import { recordLeadAction } from "../leads/service.ts";
import {
  assertVersion, fieldDefsFor, logActivity, readCustomFields, saveCustomFields, typedValue,
} from "./common.ts";
import { criteriaFromQuery, csvCell, queryContacts } from "./queries.ts";

const tagsSchema = z.array(z.string().trim().min(1).max(50)).max(20);
const contactCreate = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254).nullish(),
  phone: z.string().trim().max(40).nullish(),
  companyId: z.string().max(64).nullish(),
  ownerId: z.string().max(64).nullish(),
  tags: tagsSchema.default([]),
  optOut: z.boolean().default(false),
  customFields: z.record(z.string().max(64), z.unknown()).default({}),
});
const contactPatch = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  companyId: z.string().max(64).nullable().optional(),
  ownerId: z.string().max(64).nullable().optional(),
  tags: tagsSchema.optional(),
  optOut: z.boolean().optional(),
  customFields: z.record(z.string().max(64), z.unknown()).optional(),
});
const noteSchema = z.object({ text: z.string().trim().min(1).max(5000) });
const companyCreate = z.object({ name: z.string().trim().min(1).max(100), customFields: z.record(z.string().max(64), z.unknown()).default({}) });
const companyPatch = z.object({ version: z.number().int().min(1), name: z.string().trim().min(1).max(100).optional(), customFields: z.record(z.string().max(64), z.unknown()).optional() });

interface ContactRow {
  id: string; workspace_id: string; company_id: string | null; name: string; email: string | null; phone: string | null;
  opt_out: number; owner_id: string | null; tags: string; version: number; created_at: string; updated_at: string;
}

const getContact = (db: Db, workspaceId: string, id: string) =>
  db.prepare("SELECT * FROM contacts WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as ContactRow | undefined;

function requireMemberOrNull(db: Db, workspaceId: string, userId: string | null | undefined) {
  if (userId && !db.prepare("SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND removed_at IS NULL").get(workspaceId, userId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "ownerId must be a member of this workspace.");
  }
}
function requireCompanyOrNull(db: Db, workspaceId: string, companyId: string | null | undefined) {
  if (companyId && !db.prepare("SELECT 1 FROM companies WHERE workspace_id = ? AND id = ?").get(workspaceId, companyId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "companyId does not exist in this workspace.");
  }
}

const snapshot = (c: ContactRow) => ({ name: c.name, email: c.email, phone: c.phone, companyId: c.company_id, ownerId: c.owner_id, tags: JSON.parse(c.tags), optOut: c.opt_out === 1 });

export function contactsRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  router.get("/", requirePermission(db, "crmView"), (req, res) => {
    const { workspaceId } = req.session!;
    const { page, pageSize, offset } = paginate(req.query);
    const criteria = criteriaFromQuery({ ...req.query, q: req.query.search ?? req.query.q });
    const { items, total } = queryContacts(db, workspaceId, criteria, { limit: pageSize, offset });
    res.json({ items, page, pageSize, total });
  });

  // Declared before /:id so "export.csv" is not read as an id.
  router.get("/export.csv", requirePermission(db, "crmExport"), (req, res) => {
    const { workspaceId, userId } = req.session!;
    const { items } = queryContacts(db, workspaceId, criteriaFromQuery(req.query), { limit: 10000, offset: 0 });
    const rows = [["Name", "Email", "Phone", "Company", "Owner", "Tags", "Opted out"], ...items.map((c) => [c.name, c.email, c.phone, c.company, c.owner, c.tags.join("; "), c.optedOut ? "yes" : "no"])];
    audit(db, { workspaceId, actorId: userId, action: "contact.exported", targetType: "contact", after: { rows: items.length } });
    res.type("text/csv").send(rows.map((r) => r.map(csvCell).join(",")).join("\r\n"));
  });

  router.post("/", requirePermission(db, "crmCreate"), (req, res) => {
    const parsed = contactCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: validationMessage(parsed.error) } });
    const { workspaceId, userId } = req.session!;
    const d = parsed.data;
    const id = randomUUID();
    tx(db, () => {
      requireCompanyOrNull(db, workspaceId, d.companyId);
      requireMemberOrNull(db, workspaceId, d.ownerId);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO contacts (id, workspace_id, company_id, name, email, phone, phone_normalized, opt_out, owner_id, tags, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, workspaceId, d.companyId ?? null, d.name, d.email?.toLowerCase() ?? null, d.phone ?? null, normalizePhone(d.phone), d.optOut ? 1 : 0, d.ownerId ?? null, JSON.stringify(d.tags), now, now);
      saveCustomFields(db, workspaceId, "contact", id, null, d.customFields);
      logActivity(db, { workspaceId, contactId: id, type: "created", text: "Contact created.", actorId: userId });
      audit(db, { workspaceId, actorId: userId, action: "contact.created", targetType: "contact", targetId: id, after: snapshot(getContact(db, workspaceId, id)!) });
    });
    res.status(201).json(contactDetail(db, workspaceId, id, req.member!.permissions));
  });

  router.get("/:id", requirePermission(db, "crmView"), (req, res) => {
    res.json(contactDetail(db, req.session!.workspaceId, String(req.params.id), req.member!.permissions));
  });

  router.patch("/:id", requirePermission(db, "crmEdit"), (req, res) => {
    const parsed = contactPatch.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: validationMessage(parsed.error) } });
    const { workspaceId, userId } = req.session!;
    const d = parsed.data;
    tx(db, () => {
      const current = getContact(db, workspaceId, String(req.params.id));
      if (!current) throw new HttpError(404, "NOT_FOUND", "Contact not found.");
      assertVersion(current.version, d.version);
      if (d.companyId !== undefined) requireCompanyOrNull(db, workspaceId, d.companyId);
      if (d.ownerId !== undefined) requireMemberOrNull(db, workspaceId, d.ownerId);
      const next = {
        name: d.name ?? current.name,
        email: d.email === undefined ? current.email : d.email?.toLowerCase() ?? null,
        phone: d.phone === undefined ? current.phone : d.phone,
        company_id: d.companyId === undefined ? current.company_id : d.companyId,
        owner_id: d.ownerId === undefined ? current.owner_id : d.ownerId,
        tags: d.tags ? JSON.stringify(d.tags) : current.tags,
        opt_out: d.optOut === undefined ? current.opt_out : d.optOut ? 1 : 0,
      };
      db.prepare(
        `UPDATE contacts SET name = ?, email = ?, phone = ?, phone_normalized = ?, company_id = ?, owner_id = ?, tags = ?, opt_out = ?,
                version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      ).run(next.name, next.email, next.phone, normalizePhone(next.phone), next.company_id, next.owner_id, next.tags, next.opt_out, new Date().toISOString(), current.id, current.version);
      const fieldChanges = d.customFields ? saveCustomFields(db, workspaceId, "contact", current.id, null, d.customFields) : [];
      const after = getContact(db, workspaceId, current.id)!;
      const changed = (Object.keys(snapshot(current)) as (keyof ReturnType<typeof snapshot>)[]).filter((k) => JSON.stringify(snapshot(current)[k]) !== JSON.stringify(snapshot(after)[k]));
      if (changed.length || fieldChanges.length) {
        logActivity(db, { workspaceId, contactId: current.id, type: "field_edit", text: `Updated ${[...changed, ...fieldChanges.map((c) => c.split(":")[0])].join(", ")}.`, actorId: userId });
        audit(db, { workspaceId, actorId: userId, action: "contact.updated", targetType: "contact", targetId: current.id, before: snapshot(current), after: snapshot(after) });
      }
      if (d.optOut !== undefined && d.optOut !== (current.opt_out === 1)) {
        audit(db, { workspaceId, actorId: userId, action: d.optOut ? "contact.opted_out" : "contact.opted_in", targetType: "contact", targetId: current.id });
      }
    });
    res.json(contactDetail(db, workspaceId, String(req.params.id), req.member!.permissions));
  });

  router.delete("/:id", requirePermission(db, "crmDelete"), (req, res) => {
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const current = getContact(db, workspaceId, String(req.params.id));
      if (!current) throw new HttpError(404, "NOT_FOUND", "Contact not found.");
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ? AND contact_id = ?`).get(workspaceId, current.id) as { n: number }).n;
      const related = { opportunities: count("opportunities"), leads: count("leads"), payments: count("payments"), appointments: count("appointments"), conversations: count("conversations") };
      if (Object.values(related).some((n) => n > 0)) {
        throw new HttpError(409, "HAS_RELATED_RECORDS", "This contact still has linked opportunities, leads, payments, appointments or conversations. Remove or reassign them first.", related);
      }
      db.prepare("DELETE FROM activities WHERE workspace_id = ? AND contact_id = ?").run(workspaceId, current.id);
      db.prepare("DELETE FROM custom_field_values WHERE entity_id = ?").run(current.id);
      db.prepare("DELETE FROM contacts WHERE id = ?").run(current.id);
      audit(db, { workspaceId, actorId: userId, action: "contact.deleted", targetType: "contact", targetId: current.id, before: snapshot(current) });
    });
    res.status(204).end();
  });

  router.post("/:id/notes", requirePermission(db, "crmEdit"), (req, res) => {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: validationMessage(parsed.error) } });
    const { workspaceId, userId } = req.session!;
    const note = tx(db, () => {
      const contact = getContact(db, workspaceId, String(req.params.id));
      if (!contact) throw new HttpError(404, "NOT_FOUND", "Contact not found.");
      logActivity(db, { workspaceId, contactId: contact.id, type: "note", text: parsed.data.text, actorId: userId });
      recordLeadAction(db, workspaceId, contact.id, userId); // a note counts as acknowledgement (glossary)
      return { contactId: contact.id, text: parsed.data.text, createdAt: new Date().toISOString() };
    });
    res.status(201).json({ ...note, actorId: userId });
  });

  return router;
}

// The complete customer view (F2.8): everything about a contact on one page.
export function contactDetail(db: Db, workspaceId: string, id: string, perms: readonly import("../auth/permissions.ts").Permission[]) {
  const c = getContact(db, workspaceId, id);
  if (!c) throw new HttpError(404, "NOT_FOUND", "Contact not found.");
  const company = c.company_id ? (db.prepare("SELECT id, name FROM companies WHERE id = ?").get(c.company_id) as { id: string; name: string }) : null;
  const owner = c.owner_id ? (db.prepare("SELECT name FROM users WHERE id = ?").get(c.owner_id) as { name: string }) : null;
  const values = readCustomFields(db, c.id);
  const defs = fieldDefsFor(db, workspaceId, "contact", null);
  const opportunities = (db.prepare(
    `SELECT o.id, o.name, o.value, o.currency, o.version, s.name AS stage, s.kind AS stage_kind, p.name AS pipeline, o.updated_at
     FROM opportunities o JOIN stages s ON s.id = o.stage_id JOIN pipelines p ON p.id = o.pipeline_id
     WHERE o.workspace_id = ? AND o.contact_id = ? ORDER BY o.updated_at DESC`,
  ).all(workspaceId, c.id) as Record<string, unknown>[]).map((o) => ({
    id: o.id, name: o.name, value: maskValue(o.value as number | null, perms), valueHidden: !perms.includes("viewOpportunityValue"),
    currency: o.currency, stage: o.stage, stageKind: o.stage_kind, pipeline: o.pipeline, version: o.version, updatedAt: o.updated_at,
  }));
  const conversations = (db.prepare("SELECT id, channel, last_message_at, unread FROM conversations WHERE workspace_id = ? AND contact_id = ?").all(workspaceId, c.id) as Record<string, unknown>[]).map((cv) => ({
    id: cv.id, channel: cv.channel, lastMessageAt: cv.last_message_at, unread: cv.unread,
    messages: (db.prepare("SELECT id, direction, body, status, failure_reason, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").all(cv.id as string) as Record<string, unknown>[])
      .reverse().map((m) => ({ id: m.id, direction: m.direction, body: m.body, status: m.status, failureReason: m.failure_reason, at: m.created_at })),
  }));
  const payments = (db.prepare("SELECT id, opportunity_id, amount, currency, status, refunded_amount, provider_reference, requested_by, created_at FROM payments WHERE workspace_id = ? AND contact_id = ? ORDER BY created_at DESC").all(workspaceId, c.id) as Record<string, unknown>[]).map((p) => ({
    id: p.id, opportunityId: p.opportunity_id, amount: Number(p.amount) / 100, currency: p.currency, status: p.status, refunded: Number(p.refunded_amount) / 100,
    providerReference: p.provider_reference, requestedBy: (db.prepare("SELECT name FROM users WHERE id = ?").get(p.requested_by as string) as { name: string } | undefined)?.name ?? null, createdAt: p.created_at,
  }));
  const appointments = (db.prepare("SELECT id, title, starts_at, ends_at, timezone, status, user_id FROM appointments WHERE workspace_id = ? AND contact_id = ? ORDER BY starts_at DESC").all(workspaceId, c.id) as Record<string, unknown>[]).map((a) => ({
    id: a.id, title: a.title, startsAt: a.starts_at, endsAt: a.ends_at, timezone: a.timezone, status: a.status, userId: a.user_id,
  }));
  const activities = (db.prepare(
    `SELECT a.id, a.type, a.text, a.opportunity_id, a.created_at, u.name AS actor FROM activities a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.workspace_id = ? AND a.contact_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 500`,
  ).all(workspaceId, c.id) as Record<string, unknown>[]).map((a) => ({ id: a.id, type: a.type, text: a.text, opportunityId: a.opportunity_id, actor: a.actor ?? "System", at: a.created_at }));
  return {
    contact: {
      id: c.id, name: c.name, email: c.email, phone: c.phone, optedOut: c.opt_out === 1, tags: JSON.parse(c.tags) as string[],
      company, ownerId: c.owner_id, owner: owner?.name ?? null, version: c.version, createdAt: c.created_at, updatedAt: c.updated_at,
      customFields: defs.map((d) => ({ id: d.id, name: d.name, type: d.field_type, options: JSON.parse(d.options), value: values[d.id] === undefined ? null : typedValue(d, values[d.id]!) })),
    },
    opportunities, conversations, payments, appointments, activities,
    leads: (db.prepare("SELECT id, source, owner_id, acknowledged_at, closed_at, escalation_count FROM leads WHERE workspace_id = ? AND contact_id = ? ORDER BY created_at DESC").all(workspaceId, c.id) as Record<string, unknown>[]).map((l) => ({
      id: l.id, source: l.source, ownerId: l.owner_id, acknowledgedAt: l.acknowledged_at, closedAt: l.closed_at, escalationCount: l.escalation_count,
    })),
  };
}

export function companiesRouter(db: Db) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  router.get("/", requirePermission(db, "crmView"), (req, res) => {
    const { workspaceId } = req.session!;
    const { page, pageSize, offset } = paginate(req.query);
    const q = typeof req.query.search === "string" && req.query.search ? `%${req.query.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const where = `workspace_id = ? ${q ? "AND name LIKE ? ESCAPE '\\'" : ""}`;
    const args = q ? [workspaceId, q] : [workspaceId];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE ${where}`).get(...args) as { n: number }).n;
    const items = (db.prepare(
      `SELECT id, name, version, created_at, (SELECT COUNT(*) FROM contacts c WHERE c.company_id = companies.id) AS contacts
       FROM companies WHERE ${where} ORDER BY name LIMIT ? OFFSET ?`,
    ).all(...args, pageSize, offset) as Record<string, unknown>[]).map((r) => ({ id: r.id, name: r.name, contacts: r.contacts, version: r.version, createdAt: r.created_at }));
    res.json({ items, page, pageSize, total });
  });

  router.post("/", requirePermission(db, "crmCreate"), (req, res) => {
    const parsed = companyCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: validationMessage(parsed.error) } });
    const { workspaceId, userId } = req.session!;
    const id = randomUUID();
    tx(db, () => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO companies (id, workspace_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, workspaceId, parsed.data.name, now, now);
      saveCustomFields(db, workspaceId, "company", id, null, parsed.data.customFields);
      audit(db, { workspaceId, actorId: userId, action: "company.created", targetType: "company", targetId: id, after: { name: parsed.data.name } });
    });
    res.status(201).json(companyDetail(db, workspaceId, id));
  });

  router.get("/:id", requirePermission(db, "crmView"), (req, res) => {
    res.json(companyDetail(db, req.session!.workspaceId, String(req.params.id)));
  });

  router.patch("/:id", requirePermission(db, "crmEdit"), (req, res) => {
    const parsed = companyPatch.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: validationMessage(parsed.error) } });
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const current = db.prepare("SELECT id, name, version FROM companies WHERE workspace_id = ? AND id = ?").get(workspaceId, String(req.params.id)) as { id: string; name: string; version: number } | undefined;
      if (!current) throw new HttpError(404, "NOT_FOUND", "Company not found.");
      assertVersion(current.version, parsed.data.version);
      const name = parsed.data.name ?? current.name;
      db.prepare("UPDATE companies SET name = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(name, new Date().toISOString(), current.id, current.version);
      if (parsed.data.customFields) saveCustomFields(db, workspaceId, "company", current.id, null, parsed.data.customFields);
      audit(db, { workspaceId, actorId: userId, action: "company.updated", targetType: "company", targetId: current.id, before: { name: current.name }, after: { name } });
    });
    res.json(companyDetail(db, workspaceId, String(req.params.id)));
  });

  router.delete("/:id", requirePermission(db, "crmDelete"), (req, res) => {
    const { workspaceId, userId } = req.session!;
    tx(db, () => {
      const current = db.prepare("SELECT id, name FROM companies WHERE workspace_id = ? AND id = ?").get(workspaceId, String(req.params.id)) as { id: string; name: string } | undefined;
      if (!current) throw new HttpError(404, "NOT_FOUND", "Company not found.");
      const n = (db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE workspace_id = ? AND company_id = ?").get(workspaceId, current.id) as { n: number }).n;
      if (n > 0) throw new HttpError(409, "HAS_RELATED_RECORDS", `This company still has ${n} contact(s). Move or delete them first.`, { contacts: n });
      db.prepare("DELETE FROM custom_field_values WHERE entity_id = ?").run(current.id);
      db.prepare("DELETE FROM companies WHERE id = ?").run(current.id);
      audit(db, { workspaceId, actorId: userId, action: "company.deleted", targetType: "company", targetId: current.id, before: { name: current.name } });
    });
    res.status(204).end();
  });

  return router;
}

function companyDetail(db: Db, workspaceId: string, id: string) {
  const c = db.prepare("SELECT id, name, version, created_at FROM companies WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as { id: string; name: string; version: number; created_at: string } | undefined;
  if (!c) throw new HttpError(404, "NOT_FOUND", "Company not found.");
  const values = readCustomFields(db, c.id);
  return {
    id: c.id, name: c.name, version: c.version, createdAt: c.created_at,
    customFields: fieldDefsFor(db, workspaceId, "company", null).map((d) => ({ id: d.id, name: d.name, type: d.field_type, value: values[d.id] === undefined ? null : typedValue(d, values[d.id]!) })),
    contacts: db.prepare("SELECT id, name, email, phone FROM contacts WHERE workspace_id = ? AND company_id = ? ORDER BY name").all(workspaceId, c.id),
  };
}
