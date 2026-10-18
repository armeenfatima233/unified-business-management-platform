// Server-side sessions (F1.1, Q1). The browser holds only an opaque random token
// in an httpOnly cookie; identity and workspace live in the DB, never in the client.
import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { Db } from "../db.ts";

export const SESSION_COOKIE = "ubmp_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // expiration requirement (Q1)

export interface SessionInfo {
  userId: string;
  workspaceId: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createSession(db: Db, userId: string, workspaceId: string) {
  const token = randomBytes(32).toString("base64url"); // 256 bits of entropy
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, workspace_id, expires_at, created_at) VALUES (?,?,?,?,?)",
  ).run(hashToken(token), userId, workspaceId, expiresAt.toISOString(), now.toISOString());
  return { token, expiresAt };
}

// Returns null for unknown or expired tokens. Expired rows are removed lazily.
export function lookupSession(db: Db, token: string): SessionInfo | null {
  const row = db
    .prepare("SELECT user_id, workspace_id, expires_at FROM sessions WHERE token_hash = ?")
    .get(hashToken(token)) as
    | { user_id: string; workspace_id: string; expires_at: string }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    revokeSession(db, token);
    return null;
  }
  return { userId: row.user_id, workspaceId: row.workspace_id };
}

// Logout: deleting the row makes the token useless immediately.
export function revokeSession(db: Db, token: string) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

// httpOnly keeps the token away from page scripts (XSS); SameSite=Lax blocks
// cross-site POSTs (CSRF); Secure is switched on behind HTTPS.
export function setSessionCookie(res: Response, token: string, expiresAt: Date, secure: boolean) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, expires: expiresAt, path: "/" });
}
