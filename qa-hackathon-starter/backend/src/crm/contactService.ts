// Contact lookup/creation used by every intake path (public form, manual lead, inbound message).
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { normalizePhone } from "../http.ts";
import { audit } from "../audit/audit.ts";

export interface ContactInput {
  name: string;
  phone?: string | null;
  email?: string | null;
}

// Matches an existing contact by normalised phone, then by email (I1.5); creates one otherwise.
export function findOrCreateContact(db: Db, workspaceId: string, input: ContactInput, actorId: string | null): { id: string; created: boolean } {
  const phone = normalizePhone(input.phone ?? null);
  const email = input.email?.trim().toLowerCase() || null;
  let existing: { id: string } | undefined;
  if (phone) existing = db.prepare("SELECT id FROM contacts WHERE workspace_id = ? AND phone_normalized = ? ORDER BY created_at LIMIT 1").get(workspaceId, phone) as { id: string } | undefined;
  if (!existing && email) existing = db.prepare("SELECT id FROM contacts WHERE workspace_id = ? AND lower(email) = ? ORDER BY created_at LIMIT 1").get(workspaceId, email) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO contacts (id, workspace_id, name, email, phone, phone_normalized, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, workspaceId, input.name, email, input.phone ?? null, phone, now, now);
  audit(db, { workspaceId, actorId, action: "contact.created", targetType: "contact", targetId: id, after: { name: input.name } });
  return { id, created: true };
}
