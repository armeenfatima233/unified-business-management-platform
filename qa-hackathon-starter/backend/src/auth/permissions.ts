// Capability-based permissions (F1.3). Names match the frontend's Permission type so the
// UI can hide controls, but the server remains the only enforcement point (F1.5).
// Effective permissions = defaults for the base level, adjusted by per-member overrides
// stored in member_permissions. "Manager" is just a permission set, not a fourth level.
import type { Db } from "../db.ts";

export const ALL_PERMISSIONS = [
  "crmView", "crmCreate", "crmEdit", "crmDelete", "crmExport",
  "manageAssignmentRules", "manageIntegrations", "viewAuditLog", "viewOpportunityValue",
] as const;
export type Permission = (typeof ALL_PERMISSIONS)[number];
export type BaseLevel = "owner" | "admin" | "user";

export const isPermission = (value: string): value is Permission =>
  (ALL_PERMISSIONS as readonly string[]).includes(value);

export function defaultPermissions(baseLevel: string): Permission[] {
  if (baseLevel === "owner" || baseLevel === "admin") return [...ALL_PERMISSIONS];
  return ["crmView", "crmCreate", "crmEdit"];
}

// Read on every request (not cached in the session) so a change applies immediately.
export function effectivePermissions(db: Db, workspaceId: string, userId: string, baseLevel: string): Permission[] {
  if (baseLevel === "owner") return [...ALL_PERMISSIONS]; // the Owner can never be locked out
  const set = new Set<Permission>(defaultPermissions(baseLevel));
  const rows = db
    .prepare("SELECT permission, granted FROM member_permissions WHERE workspace_id = ? AND user_id = ?")
    .all(workspaceId, userId) as { permission: string; granted: number }[];
  for (const { permission, granted } of rows) {
    if (!isPermission(permission)) continue;
    if (granted) set.add(permission);
    else set.delete(permission);
  }
  return ALL_PERMISSIONS.filter((p) => set.has(p));
}

// Field-level protection (F1.4): every list, detail and export must pass the value through here.
export function maskValue<T>(value: T, permissions: readonly Permission[]): T | null {
  return permissions.includes("viewOpportunityValue") ? value : null;
}
