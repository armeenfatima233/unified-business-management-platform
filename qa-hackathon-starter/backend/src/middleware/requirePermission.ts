// Server-side authorization (F1.5, Q2). Runs after requireAuth: loads the caller's
// membership in the session's workspace and rejects without the capability.
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db.ts";
import { effectivePermissions, type Permission } from "../auth/permissions.ts";
import { apiError } from "./requireAuth.ts";

declare module "express-serve-static-core" {
  interface Request {
    member?: { baseLevel: string; permissions: Permission[] };
  }
}

// Loads req.member (fresh from the DB) without requiring a specific permission.
export function loadMember(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { userId, workspaceId } = req.session!;
    const row = db
      .prepare("SELECT base_level FROM memberships WHERE workspace_id = ? AND user_id = ? AND removed_at IS NULL")
      .get(workspaceId, userId) as { base_level: string } | undefined;
    if (!row) return apiError(res, 401, "UNAUTHENTICATED", "Please log in.");
    req.member = {
      baseLevel: row.base_level,
      permissions: effectivePermissions(db, workspaceId, userId, row.base_level),
    };
    next();
  };
}

export function requirePermission(db: Db, permission: Permission) {
  const load = loadMember(db);
  return (req: Request, res: Response, next: NextFunction) =>
    load(req, res, () => {
      if (!req.member!.permissions.includes(permission)) {
        return apiError(res, 403, "FORBIDDEN", "You do not have permission to do this.");
      }
      next();
    });
}
