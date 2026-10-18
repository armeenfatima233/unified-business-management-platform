// List queries shared by the live list endpoints, saved lists (F2.6) and exports. A saved list
// is just stored criteria re-run on every read, so it updates as records start or stop matching.
import { z } from "zod";
import type { Db } from "../db.ts";
import { maskValue, type Permission } from "../auth/permissions.ts";

export const criteriaSchema = z
  .object({
    q: z.string().max(200).optional(),
    pipelineId: z.string().max(64).optional(),
    stageId: z.string().max(64).optional(),
    ownerId: z.string().max(64).optional(),
    contactId: z.string().max(64).optional(),
    companyId: z.string().max(64).optional(),
    tag: z.string().max(50).optional(),
    createdFrom: z.string().max(40).optional(),
    createdTo: z.string().max(40).optional(),
    customFields: z.record(z.string().max(64), z.string().max(200)).optional(), // fieldId -> stored value
  })
  .strict();
export type Criteria = z.infer<typeof criteriaSchema>;

// Reads criteria from a URL query string. Custom fields arrive as repeated cf=<fieldId>:<value>.
export function criteriaFromQuery(query: Record<string, unknown>): Criteria {
  const raw: Record<string, unknown> = {};
  for (const key of ["q", "pipelineId", "stageId", "ownerId", "contactId", "companyId", "tag", "createdFrom", "createdTo"]) {
    if (typeof query[key] === "string" && query[key] !== "") raw[key] = query[key];
  }
  const cf = ([] as unknown[]).concat(query.cf ?? []).filter((v): v is string => typeof v === "string");
  if (cf.length) {
    raw.customFields = Object.fromEntries(
      cf.map((entry) => {
        const i = entry.indexOf(":");
        return i > 0 ? [entry.slice(0, i), entry.slice(i + 1)] : [entry, ""];
      }),
    );
  }
  return criteriaSchema.parse(raw);
}

const like = (value: string) => `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

interface Built {
  where: string[];
  args: (string | number)[];
}

function commonFilters(c: Criteria, ownerCol: string, entityIdCol: string, createdCol: string, b: Built) {
  if (c.ownerId) {
    b.where.push(`${ownerCol} = ?`);
    b.args.push(c.ownerId);
  }
  if (c.createdFrom) {
    b.where.push(`${createdCol} >= ?`);
    b.args.push(c.createdFrom);
  }
  if (c.createdTo) {
    b.where.push(`${createdCol} <= ?`);
    b.args.push(c.createdTo);
  }
  for (const [fieldId, value] of Object.entries(c.customFields ?? {})) {
    b.where.push(`EXISTS (SELECT 1 FROM custom_field_values v WHERE v.entity_id = ${entityIdCol} AND v.field_id = ? AND v.value = ?)`);
    b.args.push(fieldId, value);
  }
}

export interface Page {
  limit: number;
  offset: number;
}

export function queryOpportunities(db: Db, workspaceId: string, perms: readonly Permission[], c: Criteria, page: Page) {
  const b: Built = { where: ["o.workspace_id = ?"], args: [workspaceId] };
  if (c.pipelineId) { b.where.push("o.pipeline_id = ?"); b.args.push(c.pipelineId); }
  if (c.stageId) { b.where.push("o.stage_id = ?"); b.args.push(c.stageId); }
  if (c.contactId) { b.where.push("o.contact_id = ?"); b.args.push(c.contactId); }
  if (c.companyId) { b.where.push("c.company_id = ?"); b.args.push(c.companyId); }
  if (c.tag) { b.where.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?)"); b.args.push(c.tag); }
  if (c.q) {
    b.where.push("(o.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')");
    b.args.push(like(c.q), like(c.q));
  }
  commonFilters(c, "o.owner_id", "o.id", "o.created_at", b);
  const from = `FROM opportunities o
    JOIN stages s ON s.id = o.stage_id JOIN pipelines p ON p.id = o.pipeline_id
    JOIN contacts c ON c.id = o.contact_id LEFT JOIN companies co ON co.id = c.company_id
    LEFT JOIN users u ON u.id = o.owner_id WHERE ${b.where.join(" AND ")}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...b.args) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT o.id, o.name, o.value, o.currency, o.stage_id, s.name AS stage_name, s.kind AS stage_kind, o.pipeline_id, p.name AS pipeline_name,
              o.contact_id, c.name AS contact_name, co.name AS company_name, o.owner_id, u.name AS owner_name, o.version, o.created_at, o.updated_at
       ${from} ORDER BY o.updated_at DESC, o.rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...b.args, page.limit, page.offset) as unknown as Record<string, unknown>[];
  return {
    total,
    items: rows.map((r) => ({
      id: r.id, name: r.name, value: maskValue(r.value as number | null, perms), valueHidden: !perms.includes("viewOpportunityValue"),
      currency: r.currency, stageId: r.stage_id, stage: r.stage_name, stageKind: r.stage_kind, pipelineId: r.pipeline_id, pipeline: r.pipeline_name,
      contactId: r.contact_id, contact: r.contact_name, company: r.company_name, ownerId: r.owner_id, owner: r.owner_name,
      version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
    })),
  };
}

export function queryContacts(db: Db, workspaceId: string, c: Criteria, page: Page) {
  const b: Built = { where: ["c.workspace_id = ?"], args: [workspaceId] };
  if (c.companyId) { b.where.push("c.company_id = ?"); b.args.push(c.companyId); }
  if (c.tag) { b.where.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?)"); b.args.push(c.tag); }
  if (c.stageId) { b.where.push("EXISTS (SELECT 1 FROM opportunities o WHERE o.contact_id = c.id AND o.stage_id = ?)"); b.args.push(c.stageId); }
  if (c.pipelineId) { b.where.push("EXISTS (SELECT 1 FROM opportunities o WHERE o.contact_id = c.id AND o.pipeline_id = ?)"); b.args.push(c.pipelineId); }
  if (c.q) {
    b.where.push("(c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\')");
    b.args.push(like(c.q), like(c.q), like(c.q), like(c.q));
  }
  commonFilters(c, "c.owner_id", "c.id", "c.created_at", b);
  const from = `FROM contacts c LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN users u ON u.id = c.owner_id WHERE ${b.where.join(" AND ")}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...b.args) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.email, c.phone, c.opt_out, c.tags, c.company_id, co.name AS company_name, c.owner_id, u.name AS owner_name,
              c.version, c.created_at, c.updated_at,
              (SELECT MAX(a.created_at) FROM activities a WHERE a.contact_id = c.id) AS last_activity
       ${from} ORDER BY c.created_at DESC, c.rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...b.args, page.limit, page.offset) as unknown as Record<string, unknown>[];
  return {
    total,
    items: rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone, optedOut: r.opt_out === 1, tags: JSON.parse(String(r.tags)) as string[],
      companyId: r.company_id, company: r.company_name, ownerId: r.owner_id, owner: r.owner_name, lastActivity: r.last_activity ?? null,
      version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
    })),
  };
}

// CSV cells beginning with = + - @ are prefixed so spreadsheets never execute them (Q3).
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
