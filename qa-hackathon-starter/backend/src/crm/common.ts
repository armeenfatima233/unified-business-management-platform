// Shared CRM helpers: activity log, custom-field validation/storage, optimistic concurrency.
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { HttpError } from "../http.ts";

export { HttpError };

export interface ActivityInput {
  workspaceId: string;
  contactId: string;
  opportunityId?: string | null;
  type: string;
  text: string;
  actorId: string | null;
}

export function logActivity(db: Db, a: ActivityInput) {
  db.prepare(
    "INSERT INTO activities (id, workspace_id, contact_id, opportunity_id, type, text, actor_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(randomUUID(), a.workspaceId, a.contactId, a.opportunityId ?? null, a.type, a.text, a.actorId, new Date().toISOString());
}

export interface FieldDef {
  id: string;
  pipeline_id: string | null;
  entity_type: "contact" | "company" | "opportunity";
  name: string;
  field_type: "text" | "number" | "date" | "dropdown" | "checkbox";
  options: string;
  position: number;
}

// Definitions that apply to an entity: global ones plus those scoped to the given pipeline (F2.3).
export function fieldDefsFor(db: Db, workspaceId: string, entityType: string, pipelineId: string | null): FieldDef[] {
  return db
    .prepare(
      `SELECT id, pipeline_id, entity_type, name, field_type, options, position FROM custom_field_definitions
       WHERE workspace_id = ? AND entity_type = ? AND (pipeline_id IS NULL OR pipeline_id = ?)
       ORDER BY position, created_at`,
    )
    .all(workspaceId, entityType, pipelineId) as unknown as FieldDef[];
}

// Validates one value against its definition and returns the canonical stored string, or null for "empty".
export function canonicalValue(def: FieldDef, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (def.field_type) {
    case "text":
      if (typeof raw !== "string" || raw.length > 2000) throw new HttpError(400, "VALIDATION_ERROR", `${def.name} must be text up to 2000 characters.`);
      return raw;
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n)) throw new HttpError(400, "VALIDATION_ERROR", `${def.name} must be a number.`);
      return String(n);
    }
    case "date":
      if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
        throw new HttpError(400, "VALIDATION_ERROR", `${def.name} must be a date in YYYY-MM-DD format.`);
      }
      return raw;
    case "dropdown": {
      const options = JSON.parse(def.options) as string[];
      if (typeof raw !== "string" || !options.includes(raw)) {
        throw new HttpError(400, "VALIDATION_ERROR", `${def.name} must be one of: ${options.join(", ")}.`);
      }
      return raw;
    }
    case "checkbox":
      if (typeof raw !== "boolean") throw new HttpError(400, "VALIDATION_ERROR", `${def.name} must be true or false.`);
      return raw ? "true" : "false";
  }
}

export function typedValue(def: Pick<FieldDef, "field_type">, stored: string): unknown {
  if (def.field_type === "number") return Number(stored);
  if (def.field_type === "checkbox") return stored === "true";
  return stored;
}

// Stores values for the given definitions only (unknown ids are rejected, so a client cannot
// attach fields from another pipeline or workspace). Returns human-readable changes for the history.
export function saveCustomFields(
  db: Db,
  workspaceId: string,
  entityType: "contact" | "company" | "opportunity",
  entityId: string,
  pipelineId: string | null,
  values: Record<string, unknown>,
): string[] {
  const defs = new Map(fieldDefsFor(db, workspaceId, entityType, pipelineId).map((d) => [d.id, d]));
  const changes: string[] = [];
  for (const [fieldId, raw] of Object.entries(values)) {
    const def = defs.get(fieldId);
    if (!def) throw new HttpError(400, "UNKNOWN_FIELD", "A custom field does not exist for this record.");
    const next = canonicalValue(def, raw);
    const prev = db.prepare("SELECT value FROM custom_field_values WHERE entity_id = ? AND field_id = ?").get(entityId, fieldId) as { value: string } | undefined;
    if ((prev?.value ?? null) === next) continue;
    if (next === null) db.prepare("DELETE FROM custom_field_values WHERE entity_id = ? AND field_id = ?").run(entityId, fieldId);
    else {
      db.prepare(
        `INSERT INTO custom_field_values (workspace_id, entity_type, entity_id, field_id, value) VALUES (?,?,?,?,?)
         ON CONFLICT (entity_id, field_id) DO UPDATE SET value = excluded.value`,
      ).run(workspaceId, entityType, entityId, fieldId, next);
    }
    changes.push(`${def.name}: ${prev?.value ?? "empty"} -> ${next ?? "empty"}`);
  }
  return changes;
}

export function readCustomFields(db: Db, entityId: string): Record<string, string> {
  const rows = db.prepare("SELECT field_id, value FROM custom_field_values WHERE entity_id = ?").all(entityId) as { field_id: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.field_id, r.value]));
}

// Optimistic concurrency (Q4): the caller must send the version it read; a stale edit gets 409.
export function assertVersion(current: number, supplied: number) {
  if (current !== supplied) {
    throw new HttpError(409, "VERSION_CONFLICT", "This record was changed by someone else. Reload it and try again.", { currentVersion: current });
  }
}
