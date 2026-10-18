// Auth endpoints (F1.1): POST /auth/signup, /auth/login, /auth/logout, GET /auth/me.
// Routes follow docs/API_CONTRACT.md (proposed) under the /api/v1 prefix.
import { randomBytes, randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { tx, type Db } from "../db.ts";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./password.ts";
import { createSession, revokeSession, SESSION_COOKIE } from "./sessions.ts";
import { clearFailures, isThrottled, recordFailure } from "../middleware/loginThrottle.ts";
import { apiError, requireAuth } from "../middleware/requireAuth.ts";
import { effectivePermissions } from "./permissions.ts";
import { audit } from "../audit/audit.ts";
import { seedWorkspace } from "../workspace/seed.ts";

// Input validation (Q3): reject malformed payloads before touching the DB.
const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(100),
  workspaceName: z.string().trim().min(1).max(100),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export function authRouter(db: Db, opts: { cookieSecure: boolean }) {
  const router = Router();

  // httpOnly keeps the token away from page scripts (XSS); SameSite=Lax blocks
  // cross-site POSTs (CSRF); Secure is switched on behind HTTPS.
  const setSessionCookie = (res: Response, token: string, expiresAt: Date) =>
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: opts.cookieSecure,
      expires: expiresAt,
      path: "/",
    });

  router.post("/signup", async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const { email, password, name, workspaceName } = parsed.data;
    const passwordHash = await hashPassword(password); // slow work stays outside the DB transaction

    const userId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    try {
      // One transaction: a workspace can never exist without its Owner.
      tx(db, () => {
        db.prepare("INSERT INTO workspaces (id, name, created_at, public_key) VALUES (?,?,?,?)").run(workspaceId, workspaceName, now, randomBytes(16).toString("hex"));
        db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)").run(
          userId, email, name, passwordHash, now,
        );
        db.prepare("INSERT INTO memberships (workspace_id, user_id, base_level, created_at) VALUES (?,?,'owner',?)").run(
          workspaceId, userId, now,
        );
        seedWorkspace(db, workspaceId, userId); // default pipeline + routing rules (D10)
        audit(db, { workspaceId, actorId: userId, action: "workspace.created", targetType: "workspace", targetId: workspaceId, after: { name: workspaceName } });
      });
    } catch (err) {
      // The UNIQUE constraint on users.email is the source of truth, which also
      // makes two simultaneous signups with one email safe.
      if (err instanceof Error && /UNIQUE constraint failed: users\.email/.test(err.message)) {
        return apiError(res, 409, "EMAIL_TAKEN", "An account with this email already exists.");
      }
      throw err;
    }

    const { token, expiresAt } = createSession(db, userId, workspaceId);
    setSessionCookie(res, token, expiresAt);
    res.status(201).json({
      user: { id: userId, email, name },
      workspace: { id: workspaceId, name: workspaceName },
      baseLevel: "owner",
      availability: "available",
      permissions: effectivePermissions(db, workspaceId, userId, "owner"),
    });
  });

  router.post("/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", "Email and password are required.");
    const { email, password } = parsed.data;
    const ip = req.ip ?? "unknown";

    if (isThrottled(db, email, ip)) {
      return apiError(res, 429, "TOO_MANY_ATTEMPTS", "Too many failed logins. Try again later.");
    }

    const user = db.prepare("SELECT id, name, password_hash FROM users WHERE email = ?").get(email) as
      | { id: string; name: string; password_hash: string }
      | undefined;
    // Verify even when the user is missing so timing does not reveal which emails exist.
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      recordFailure(db, email, ip);
      return apiError(res, 401, "INVALID_CREDENTIALS", "Invalid email or password."); // same message either way
    }

    // Single workspace per user for now; multi-workspace selection is out of scope for F1.1.
    const membership = db
      .prepare(
        `SELECT m.workspace_id, m.base_level, m.availability, w.name AS workspace_name
         FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ? AND m.removed_at IS NULL ORDER BY m.created_at LIMIT 1`,
      )
      .get(user.id) as { workspace_id: string; base_level: string; availability: string; workspace_name: string } | undefined;
    if (!membership) return apiError(res, 403, "NO_WORKSPACE", "This account has no workspace.");

    clearFailures(db, email, ip);
    const { token, expiresAt } = createSession(db, user.id, membership.workspace_id);
    setSessionCookie(res, token, expiresAt);
    res.json({
      user: { id: user.id, email, name: user.name },
      workspace: { id: membership.workspace_id, name: membership.workspace_name },
      baseLevel: membership.base_level,
      availability: membership.availability,
      permissions: effectivePermissions(db, membership.workspace_id, user.id, membership.base_level),
    });
  });

  router.post("/logout", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === "string") revokeSession(db, token); // server-side revoke, not just cookie removal
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  });

  // Used by the frontend after a page refresh to restore the logged-in state.
  router.get("/me", requireAuth(db), (req, res) => {
    const { userId, workspaceId } = req.session!;
    const row = db
      .prepare(
        `SELECT u.id, u.email, u.name, m.base_level, m.availability, w.id AS workspace_id, w.name AS workspace_name
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ? AND m.removed_at IS NULL
         JOIN workspaces w ON w.id = m.workspace_id
         WHERE u.id = ?`,
      )
      .get(workspaceId, userId) as
      | { id: string; email: string; name: string; base_level: string; availability: string; workspace_id: string; workspace_name: string }
      | undefined;
    if (!row) return apiError(res, 401, "UNAUTHENTICATED", "Please log in.");
    res.json({
      user: { id: row.id, email: row.email, name: row.name },
      workspace: { id: row.workspace_id, name: row.workspace_name },
      baseLevel: row.base_level,
      availability: row.availability,
      permissions: effectivePermissions(db, workspaceId, userId, row.base_level),
    });
  });

  return router;
}
