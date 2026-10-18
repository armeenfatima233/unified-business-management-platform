// New-workspace defaults (D10): one pipeline with a sensible stage set and routing rules, so
// the CRM and lead routing are usable immediately. Runs inside the signup transaction.
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";

export const DEFAULT_STAGES = [
  { name: "New", kind: "open" },
  { name: "Qualified", kind: "open" },
  { name: "Proposal", kind: "open" },
  { name: "Won", kind: "won" },
  { name: "Lost", kind: "lost" },
] as const;

export function seedWorkspace(db: Db, workspaceId: string, ownerId: string) {
  const now = new Date().toISOString();
  const pipelineId = randomUUID();
  db.prepare("INSERT INTO pipelines (id, workspace_id, name, created_at) VALUES (?,?,?,?)").run(pipelineId, workspaceId, "Sales", now);
  const insertStage = db.prepare("INSERT INTO stages (id, workspace_id, pipeline_id, name, position, kind) VALUES (?,?,?,?,?,?)");
  DEFAULT_STAGES.forEach((stage, index) => insertStage.run(randomUUID(), workspaceId, pipelineId, stage.name, index, stage.kind));
  // The Owner is the manager fallback until an Admin designates someone else (D06).
  db.prepare(
    "INSERT OR IGNORE INTO lead_routing_rules (workspace_id, manager_user_id, updated_at) VALUES (?,?,?)",
  ).run(workspaceId, ownerId, now);
}

// Workspaces created before the CRM existed get the same starting pipeline and routing rules.
export function backfillWorkspaces(db: Db) {
  const rows = db.prepare(
    `SELECT w.id, (SELECT m.user_id FROM memberships m WHERE m.workspace_id = w.id AND m.base_level = 'owner' LIMIT 1) AS owner_id
     FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM pipelines p WHERE p.workspace_id = w.id)`,
  ).all() as { id: string; owner_id: string | null }[];
  for (const w of rows) if (w.owner_id) seedWorkspace(db, w.id, w.owner_id);
}
