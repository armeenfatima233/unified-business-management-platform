// Members, invitations, roles and permissions (F1.2, F1.3, F1.5, F1.6) and availability (F3.2).
// The workspace always comes from the session; a target user from another workspace is
// indistinguishable from a missing one (404), so guessed ids reveal nothing (F1.6).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { tx, type Db } from "../db.ts";
import { hashPassword } from "../auth/password.ts";
import { ALL_PERMISSIONS, defaultPermissions, effectivePermissions, isPermission, type Permission } from "../auth/permissions.ts";
import { createSession } from "../auth/sessions.ts";
import { audit } from "../audit/audit.ts";
import { releaseMember } from "../leads/service.ts";
import { loadMember } from "../middleware/requirePermission.ts";
import { apiError, requireAuth } from "../middleware/requireAuth.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // D11 proposal: 7 days
const AVAILABILITY = ["available", "busy", "on_leave", "offline"] as const;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  baseLevel: z.enum(["admin", "user"]),
});
const roleSchema = z.object({ baseLevel: z.enum(["admin", "user"]) });
const permissionsSchema = z.object({ permissions: z.array(z.string()).max(ALL_PERMISSIONS.length) });
const availabilitySchema = z.object({ availability: z.enum(AVAILABILITY) });
const acceptSchema = z.object({
  token: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(10).max(200),
});

interface MemberRow {
  user_id: string;
  base_level: string;
  availability: string;
  name: string;
  email: string;
}

// onAvailabilityChange lets the lead module reassign a member's unacknowledged leads in the
// same transaction when they go On leave/Offline (F3.6), without this module importing it.
export function membersRouter(db: Db, onAvailabilityChange?: (workspaceId: string, userId: string, availability: string) => void) {
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  const findMember = (workspaceId: string, userId: string) =>
    db
      .prepare(
        `SELECT m.user_id, m.base_level, m.availability, u.name, u.email
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? AND m.user_id = ? AND m.removed_at IS NULL`,
      )
      .get(workspaceId, userId) as MemberRow | undefined;

  // The Owner may manage anyone else; an Admin may only manage plain Users (F1.2).
  const canManage = (callerLevel: string, target: MemberRow) =>
    target.base_level !== "owner" && (callerLevel === "owner" || (callerLevel === "admin" && target.base_level === "user"));

  router.get("/", (req, res) => {
    const { workspaceId } = req.session!;
    const rows = db
      .prepare(
        `SELECT m.user_id, m.base_level, m.availability, u.name, u.email
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? AND m.removed_at IS NULL ORDER BY m.created_at`,
      )
      .all(workspaceId) as unknown as MemberRow[];
    const seesPermissions = req.member!.baseLevel !== "user";
    res.json({
      items: rows.map((r) => ({
        id: r.user_id,
        name: r.name,
        email: r.email,
        baseLevel: r.base_level,
        availability: r.availability,
        ...(seesPermissions ? { permissions: effectivePermissions(db, workspaceId, r.user_id, r.base_level) } : {}),
      })),
    });
  });

  router.post("/invitations", (req, res) => {
    const caller = req.member!;
    if (caller.baseLevel === "user") return apiError(res, 403, "FORBIDDEN", "Only an Owner or Admin can invite people.");
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input.");
    const { email, baseLevel } = parsed.data;
    if (baseLevel === "admin" && caller.baseLevel !== "owner") {
      return apiError(res, 403, "FORBIDDEN", "Only the Owner can invite an Admin.");
    }
    const { workspaceId, userId } = req.session!;
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
      return apiError(res, 409, "EMAIL_TAKEN", "An account with this email already exists.");
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
    const id = randomUUID();
    tx(db, () => {
      // Re-inviting replaces any earlier open invitation, so only the newest link works.
      db.prepare("DELETE FROM invitations WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL").run(workspaceId, email);
      db.prepare(
        "INSERT INTO invitations (id, token_hash, workspace_id, email, base_level, invited_by, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(id, sha256(token), workspaceId, email, baseLevel, userId, expiresAt, now.toISOString());
      audit(db, { workspaceId, actorId: userId, action: "member.invited", targetType: "invitation", targetId: id, after: { email, baseLevel } });
    });
    // The raw token is shown once; only its hash is stored. No email provider is chosen yet (I4).
    res.status(201).json({ id, email, baseLevel, expiresAt, token });
  });

  router.patch("/:id/role", (req, res) => {
    if (req.member!.baseLevel !== "owner") return apiError(res, 403, "FORBIDDEN", "Only the Owner can change levels.");
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", "baseLevel must be admin or user.");
    const { workspaceId } = req.session!;
    const target = findMember(workspaceId, String(req.params.id));
    if (!target) return apiError(res, 404, "NOT_FOUND", "Member not found.");
    if (target.base_level === "owner") return apiError(res, 403, "FORBIDDEN", "The Owner cannot be changed.");
    tx(db, () => {
      db.prepare("UPDATE memberships SET base_level = ? WHERE workspace_id = ? AND user_id = ?").run(
        parsed.data.baseLevel, workspaceId, target.user_id,
      );
      // Reset overrides so the member starts from the new level's defaults.
      db.prepare("DELETE FROM member_permissions WHERE workspace_id = ? AND user_id = ?").run(workspaceId, target.user_id);
      audit(db, {
        workspaceId, actorId: req.session!.userId, action: "member.role_changed", targetType: "member", targetId: target.user_id,
        before: { baseLevel: target.base_level }, after: { baseLevel: parsed.data.baseLevel },
      });
    });
    res.json({
      id: target.user_id,
      baseLevel: parsed.data.baseLevel,
      permissions: effectivePermissions(db, workspaceId, target.user_id, parsed.data.baseLevel),
    });
  });

  router.put("/:id/permissions", (req, res) => {
    const parsed = permissionsSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.permissions.every(isPermission)) {
      return apiError(res, 400, "VALIDATION_ERROR", `permissions must be a list of: ${ALL_PERMISSIONS.join(", ")}.`);
    }
    const { workspaceId } = req.session!;
    const target = findMember(workspaceId, String(req.params.id));
    if (!target) return apiError(res, 404, "NOT_FOUND", "Member not found.");
    if (!canManage(req.member!.baseLevel, target)) {
      return apiError(res, 403, "FORBIDDEN", "You cannot change this member's permissions.");
    }
    const want = new Set(parsed.data.permissions as Permission[]);
    const defaults = new Set(defaultPermissions(target.base_level));
    const beforePerms = effectivePermissions(db, workspaceId, target.user_id, target.base_level);
    tx(db, () => {
      db.prepare("DELETE FROM member_permissions WHERE workspace_id = ? AND user_id = ?").run(workspaceId, target.user_id);
      const insert = db.prepare("INSERT INTO member_permissions (workspace_id, user_id, permission, granted) VALUES (?,?,?,?)");
      for (const p of ALL_PERMISSIONS) {
        // Only differences from the level's defaults are stored.
        if (want.has(p) !== defaults.has(p)) insert.run(workspaceId, target.user_id, p, want.has(p) ? 1 : 0);
      }
      audit(db, {
        workspaceId, actorId: req.session!.userId, action: "member.permissions_changed", targetType: "member", targetId: target.user_id,
        before: { permissions: beforePerms }, after: { permissions: ALL_PERMISSIONS.filter((p) => want.has(p)) },
      });
    });
    res.json({ id: target.user_id, permissions: effectivePermissions(db, workspaceId, target.user_id, target.base_level) });
  });

  router.delete("/:id", (req, res) => {
    const { workspaceId, userId } = req.session!;
    const target = findMember(workspaceId, String(req.params.id));
    if (!target) return apiError(res, 404, "NOT_FOUND", "Member not found.");
    if (target.user_id === userId) return apiError(res, 400, "CANNOT_REMOVE_SELF", "Ask an Owner or Admin to remove you.");
    if (!canManage(req.member!.baseLevel, target)) return apiError(res, 403, "FORBIDDEN", "You cannot remove this member.");
    releaseMember(db, workspaceId, target.user_id, userId);
    res.status(204).end();
  });

  // F3.2: an employee sets their own status; an Owner/Admin can set anyone's.
  const setAvailability = (workspaceId: string, actorId: string, userId: string, availability: string) =>
    tx(db, () => {
      const before = db.prepare("SELECT availability FROM memberships WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as { availability: string };
      db.prepare("UPDATE memberships SET availability = ? WHERE workspace_id = ? AND user_id = ?").run(availability, workspaceId, userId);
      audit(db, { workspaceId, actorId, action: "member.availability_changed", targetType: "member", targetId: userId, before: { availability: before.availability }, after: { availability } });
      onAvailabilityChange?.(workspaceId, userId, availability);
    });

  router.patch("/me/availability", (req, res) => {
    const parsed = availabilitySchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", `availability must be one of: ${AVAILABILITY.join(", ")}.`);
    const { workspaceId, userId } = req.session!;
    setAvailability(workspaceId, userId, userId, parsed.data.availability);
    res.json({ id: userId, availability: parsed.data.availability });
  });

  router.patch("/:id/availability", (req, res) => {
    if (req.member!.baseLevel === "user") {
      return apiError(res, 403, "FORBIDDEN", "Only an Owner or Admin can set someone else's status.");
    }
    const parsed = availabilitySchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", `availability must be one of: ${AVAILABILITY.join(", ")}.`);
    const { workspaceId } = req.session!;
    const target = findMember(workspaceId, String(req.params.id));
    if (!target) return apiError(res, 404, "NOT_FOUND", "Member not found.");
    setAvailability(workspaceId, req.session!.userId, target.user_id, parsed.data.availability);
    res.json({ id: target.user_id, availability: parsed.data.availability });
  });

  return router;
}

// Public (no session yet): the invited person sets a name and password and joins the workspace.
export function invitationAcceptRouter(db: Db, setCookie: (res: Response, token: string, expiresAt: Date) => void) {
  const router = Router();
  router.post("/accept-invitation", async (req, res) => {
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input.");
    const { token, name, password } = parsed.data;
    const passwordHash = await hashPassword(password); // slow work stays outside the transaction
    const userId = randomUUID();
    const now = new Date().toISOString();
    type Joined = { workspaceId: string; email: string; baseLevel: string };
    let joined: Joined | null;
    try {
      joined = tx(db, (): Joined | null => {
        const inv = db
          .prepare("SELECT id, workspace_id, email, base_level, expires_at, accepted_at FROM invitations WHERE token_hash = ?")
          .get(sha256(token)) as
          | { id: string; workspace_id: string; email: string; base_level: string; expires_at: string; accepted_at: string | null }
          | undefined;
        if (!inv || inv.accepted_at || new Date(inv.expires_at).getTime() <= Date.now()) return null;
        db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)").run(
          userId, inv.email, name, passwordHash, now,
        );
        db.prepare("INSERT INTO memberships (workspace_id, user_id, base_level, created_at) VALUES (?,?,?,?)").run(
          inv.workspace_id, userId, inv.base_level, now,
        );
        db.prepare("UPDATE invitations SET accepted_at = ? WHERE id = ?").run(now, inv.id); // single use
        audit(db, { workspaceId: inv.workspace_id, actorId: userId, action: "member.joined", targetType: "member", targetId: userId, after: { baseLevel: inv.base_level } });
        return { workspaceId: inv.workspace_id, email: inv.email, baseLevel: inv.base_level };
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: users\.email/.test(err.message)) {
        return apiError(res, 409, "EMAIL_TAKEN", "An account with this email already exists.");
      }
      throw err;
    }
    if (!joined) return apiError(res, 400, "INVALID_INVITATION", "This invitation is invalid or has expired.");
    const workspace = db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(joined.workspaceId) as { id: string; name: string };
    const session = createSession(db, userId, joined.workspaceId);
    setCookie(res, session.token, session.expiresAt);
    res.status(201).json({
      user: { id: userId, email: joined.email, name },
      workspace,
      baseLevel: joined.baseLevel,
      availability: "available",
      permissions: effectivePermissions(db, joined.workspaceId, userId, joined.baseLevel),
    });
  });
  return router;
}
