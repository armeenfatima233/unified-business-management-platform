// Google Calendar OAuth (I3.1, I3.2, I3.7): GET /api/v1/integrations/google/connect and .../callback.
//
// Each employee connects their own Google account. The OAuth client (id/secret/redirect URI) is environment-level;
// the tokens are stored encrypted per workspace AND per employee in integration_connections, on the server only.
// The OAuth `state` is single-use, stored only as a hash, and bound to the hash of the session that started the flow:
// the callback must arrive with that same session, so a state can never be completed by someone else (CSRF).
import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { audit } from "../audit/audit.ts";
import { tx, type Db } from "../db.ts";
import { HttpError } from "../http.ts";
import { lookupSession, SESSION_COOKIE } from "../auth/sessions.ts";
import { apiError, requireAuth } from "../middleware/requireAuth.ts";
import { loadMember } from "../middleware/requirePermission.ts";
import { loadGoogleModule } from "./adapters.ts";
import { connectionConfig, connectionSecrets, getConnection, logEvent, markSuccess, saveConnection, type IntegrationContext } from "./core.ts";

// ----- Shapes shared with the adapter (integrations/google-calendar/types.ts) -----
export interface GoogleMemberContext { workspaceId: string; memberId: string }
export type GoogleConnectionStatus = "connected" | "revoked" | "reauthorization_required" | "disconnected";
export interface GoogleOAuthStateStore {
  create(stateHash: string, context: GoogleMemberContext, sessionBindingHash: string, expiresAt: Date): Promise<void>;
  consume(stateHash: string, sessionBindingHash: string): Promise<GoogleMemberContext | null>;
}
export interface GoogleConnectionStore {
  getCredentials(context: GoogleMemberContext): Promise<Record<string, unknown> | null>;
  saveCredentials(context: GoogleMemberContext, credentials: Record<string, unknown>): Promise<void>;
  setStatus(context: GoogleMemberContext, status: GoogleConnectionStatus): Promise<void>;
  deleteCredentials(context: GoogleMemberContext): Promise<void>;
}
export interface GoogleAppointmentLinkStore {
  setGoogleEventId(context: GoogleMemberContext, references: { appointmentId: string }, eventId: string): Promise<void>;
  clearGoogleEventId(context: GoogleMemberContext, references: { appointmentId: string }): Promise<void>;
}
export interface GoogleOAuthPort {
  createAuthorizationUrl(context: GoogleMemberContext, sessionBinding: string): Promise<string>;
  completeAuthorization(code: string, state: string, sessionBinding: string): Promise<GoogleMemberContext>;
  disconnect(context: GoogleMemberContext): Promise<void>;
}

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ----- Stores backed by the core database -----
export function createOAuthStateStore(db: Db): GoogleOAuthStateStore {
  return {
    async create(stateHash, context, sessionBindingHash, expiresAt) {
      db.prepare("DELETE FROM google_oauth_states WHERE expires_at < ?").run(new Date().toISOString()); // expired starts are not kept
      db.prepare("INSERT INTO google_oauth_states (state_hash, workspace_id, user_id, session_binding_hash, expires_at) VALUES (?,?,?,?,?)").run(
        stateHash, context.workspaceId, context.memberId, sessionBindingHash, expiresAt.toISOString(),
      );
    },
    // Atomic return-and-delete: a state works once, only for the same session, only before it expires.
    async consume(stateHash, sessionBindingHash) {
      return tx(db, () => {
        const row = db.prepare("SELECT workspace_id, user_id, session_binding_hash, expires_at FROM google_oauth_states WHERE state_hash = ?").get(stateHash) as
          | { workspace_id: string; user_id: string; session_binding_hash: string; expires_at: string } | undefined;
        if (!row) return null;
        if (new Date(row.expires_at).getTime() < Date.now()) { db.prepare("DELETE FROM google_oauth_states WHERE state_hash = ?").run(stateHash); return null; }
        if (!sameHash(row.session_binding_hash, sessionBindingHash)) return null; // another session cannot use it, and cannot burn it either
        db.prepare("DELETE FROM google_oauth_states WHERE state_hash = ?").run(stateHash);
        return { workspaceId: row.workspace_id, memberId: row.user_id };
      });
    },
  };
}

const RECONNECT_TEXT: Record<string, string> = {
  revoked: "Google access was revoked or expired. Reconnect Google Calendar.",
  reauthorization_required: "Google did not return a refresh token. Reconnect Google Calendar and approve access again.",
};

export function createConnectionStore(ctx: IntegrationContext): GoogleConnectionStore {
  const { db } = ctx;
  return {
    async getCredentials(c) {
      const conn = getConnection(db, c.workspaceId, "google", c.memberId);
      return conn?.secrets_enc ? connectionSecrets<Record<string, unknown>>(ctx, conn) : null;
    },
    async saveCredentials(c, credentials) {
      saveConnection(ctx, c.workspaceId, "google", c.memberId, {}, credentials); // encrypted at rest, scoped to workspace + employee
    },
    async setStatus(c, status) {
      const conn = getConnection(db, c.workspaceId, "google", c.memberId);
      if (!conn) return; // "disconnected" arrives after the row is deleted
      if (status === "connected") db.prepare("UPDATE integration_connections SET status = 'connected', last_error = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), conn.id);
      else if (status === "disconnected") db.prepare("DELETE FROM integration_connections WHERE id = ?").run(conn.id);
      else {
        db.prepare("UPDATE integration_connections SET status = 'needs_reconnection', last_error = ?, updated_at = ? WHERE id = ?").run(RECONNECT_TEXT[status] ?? "Reconnect Google Calendar.", new Date().toISOString(), conn.id);
        logEvent(db, { workspaceId: c.workspaceId, provider: "google", direction: "outbound", eventType: "token", result: "error", detail: RECONNECT_TEXT[status] ?? status });
      }
    },
    async deleteCredentials(c) {
      db.prepare("DELETE FROM integration_connections WHERE workspace_id = ? AND provider = 'google' AND user_id = ?").run(c.workspaceId, c.memberId);
    },
  };
}

// Saves the Google event id on an appointment that was already validated and stored by the CRM (I3.3, I3.6).
export function createAppointmentLinkStore(db: Db): GoogleAppointmentLinkStore {
  return {
    async setGoogleEventId(c, ref, eventId) {
      db.prepare("UPDATE appointments SET google_event_id = ? WHERE workspace_id = ? AND id = ?").run(eventId, c.workspaceId, ref.appointmentId);
    },
    async clearGoogleEventId(c, ref) {
      db.prepare("UPDATE appointments SET google_event_id = NULL WHERE workspace_id = ? AND id = ?").run(c.workspaceId, ref.appointmentId);
    },
  };
}

// ----- The real adapter, built once from the environment -----
export const googleRedirectUri = (ctx: IntegrationContext) => process.env.GOOGLE_CALENDAR_REDIRECT_URI || `${ctx.publicBaseUrl}/api/v1/integrations/google/callback`;
export const googleConfigured = () => Boolean(process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET);

const adapters = new WeakMap<IntegrationContext, Promise<any | null>>();
export function getGoogleAdapter(ctx: IntegrationContext): Promise<any | null> {
  let adapter = adapters.get(ctx);
  if (!adapter) {
    adapter = (async () => {
      if (!googleConfigured()) return null;
      try {
        const mod = await loadGoogleModule();
        return new mod.GoogleCalendarAdapter({
          configuration: { clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID, clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET, redirectUri: googleRedirectUri(ctx) },
          oauthStateStore: createOAuthStateStore(ctx.db), connectionStore: createConnectionStore(ctx), appointmentLinkStore: createAppointmentLinkStore(ctx.db),
        });
      } catch (err) {
        console.warn("[google] adapter unavailable:", (err as Error).message);
        return null;
      }
    })();
    adapters.set(ctx, adapter);
  }
  return adapter;
}

// ----- Routes -----
export type GooglePortProvider = (ctx: IntegrationContext) => Promise<GoogleOAuthPort | null>;

const view = (c: ReturnType<typeof getConnection>) => ({
  status: c ? (c.status === "connected" ? "connected" : "needs_reconnection") : "not_connected",
  account: c ? ((connectionConfig<{ email?: string }>(c).email) ?? null) : null,
  lastSuccessAt: c?.last_success_at ?? null,
  lastError: c?.last_error ?? null,
});

export function googleOAuthRouter(ctx: IntegrationContext, getPort: GooglePortProvider = getGoogleAdapter) {
  const { db } = ctx;
  const router = Router();
  const guard = [requireAuth(db), loadMember(db)]; // route-level: mounted at /api/v1, must not intercept other paths
  const notConfigured = () => new HttpError(503, "INTEGRATION_NOT_CONFIGURED", "Google Calendar is not configured on the server (GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET), or its adapter is not installed.");
  const back = (outcome: string, extra = "") => `${ctx.frontendUrl.replace(/\/$/, "")}/?google=${outcome}${extra}`;

  // Start: returns the consent URL (or redirects to it with ?redirect=1). The state is bound to this session.
  router.get("/integrations/google/connect", ...guard, async (req, res) => {
    const port = await getPort(ctx);
    if (!port) throw notConfigured();
    const { workspaceId, userId } = req.session!;
    const url = await port.createAuthorizationUrl({ workspaceId, memberId: userId }, String(req.cookies?.[SESSION_COOKIE] ?? ""));
    if (req.query.redirect === "1") return void res.redirect(url);
    res.json({ url, redirectUri: googleRedirectUri(ctx) });
  });

  // Callback: Google sends the browser back here with ?code&state. The session cookie identifies who is completing it.
  router.get("/integrations/google/callback", async (req, res) => {
    if (typeof req.query.error === "string") return void res.redirect(back("denied"));
    const code = req.query.code, state = req.query.state;
    if (typeof code !== "string" || typeof state !== "string") return void res.redirect(back("error", "&reason=missing_parameters"));
    const token = req.cookies?.[SESSION_COOKIE];
    const session = typeof token === "string" ? lookupSession(db, token) : null;
    if (!session) return void res.redirect(back("error", "&reason=signin_required")); // the state alone never authorises anything
    const port = await getPort(ctx);
    if (!port) return void res.redirect(back("error", "&reason=not_configured"));
    try {
      const context = await port.completeAuthorization(code, state, token as string);
      if (context.workspaceId !== session.workspaceId || context.memberId !== session.userId) throw Object.assign(new Error("session mismatch"), { name: "GoogleCalendarOAuthStateError" });
      tx(db, () => {
        const conn = getConnection(db, context.workspaceId, "google", context.memberId);
        if (conn) markSuccess(db, conn);
        logEvent(db, { workspaceId: context.workspaceId, provider: "google", direction: "outbound", eventType: "oauth_connect", result: "ok", detail: "Employee connected their Google Calendar." });
        audit(db, { workspaceId: context.workspaceId, actorId: context.memberId, action: "integration.connected", targetType: "integration", targetId: "google" });
      });
      res.redirect(back("connected"));
    } catch (err) {
      const name = (err as Error).name;
      logEvent(db, { workspaceId: session.workspaceId, provider: "google", direction: "outbound", eventType: "oauth_connect", result: "error", detail: name === "GoogleCalendarOAuthStateError" ? "The sign-in link was invalid, expired or already used." : "Google did not complete the sign-in." });
      res.redirect(back("error", `&reason=${name === "GoogleCalendarOAuthStateError" ? "state" : "oauth"}`));
    }
  });

  // My connection, and for Admins everyone's (I3.7).
  router.get("/integrations/google/status", ...guard, (req, res) => {
    const { workspaceId, userId } = req.session!;
    const employees = req.member!.baseLevel === "user" ? undefined
      : (db.prepare("SELECT m.user_id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.removed_at IS NULL ORDER BY u.name").all(workspaceId) as { user_id: string; name: string }[])
          .map((m) => ({ userId: m.user_id, name: m.name, ...view(getConnection(db, workspaceId, "google", m.user_id)) }));
    res.json({ ...view(getConnection(db, workspaceId, "google", userId)), serverConfigured: googleConfigured(), redirectUri: googleRedirectUri(ctx), employees });
  });

  // Disconnect my own account: revokes at Google (best effort) and deletes the stored tokens.
  router.delete("/integrations/google", ...guard, async (req, res) => {
    const { workspaceId, userId } = req.session!;
    const port = await getPort(ctx);
    if (port) await port.disconnect({ workspaceId, memberId: userId }).catch(() => undefined);
    if (getConnection(db, workspaceId, "google", userId)) db.prepare("DELETE FROM integration_connections WHERE workspace_id = ? AND provider = 'google' AND user_id = ?").run(workspaceId, userId); // tokens go even if Google was unreachable
    audit(db, { workspaceId, actorId: userId, action: "integration.disconnected", targetType: "integration", targetId: "google" });
    res.status(204).end();
  });

  return router;
}
