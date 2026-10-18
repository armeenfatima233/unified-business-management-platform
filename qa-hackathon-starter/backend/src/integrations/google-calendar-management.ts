// Everything around the Google OAuth routes (./google-calendar.ts) that a calendar needs to be usable:
// connection status (an Admin sees every employee's, I3.7), disconnecting, and free/busy lookups for the booking screen
// (I3.4). Mounted under the same prefix as the OAuth routes: /api/v1/integrations/google/calendar.
import { Router } from "express";
import { z } from "zod";
import {
  GoogleCalendarConflictError, GoogleCalendarConnectionError, GoogleCalendarProviderError, GoogleCalendarRevokedError,
  type GoogleCalendarSdk,
} from "../../../integrations/google-calendar/google-calendar-adapter.ts";
import { audit } from "../audit/audit.ts";
import { HttpError, validationMessage } from "../http.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { loadMember, requirePermission } from "../middleware/requirePermission.ts";
import { connectionConfig, getConnection, logEvent, type IntegrationContext } from "./core.ts";
import { googleCalendarAdapter, memberContext, oauthConfiguration, type GoogleCalendarEnvironment } from "./google-calendar.ts";
import { isIanaZone } from "./text.ts";

export type CalendarState = "connected" | "needs_reconnection" | "not_connected";

// A connection with no stored tokens (never connected, or disconnected) is "not connected".
export function calendarState(ctx: IntegrationContext, workspaceId: string, userId: string): { state: CalendarState; lastError: string | null; lastSuccessAt: string | null; account: string | null } {
  const conn = getConnection(ctx.db, workspaceId, "google", userId);
  if (!conn || !conn.secrets_enc) return { state: "not_connected", lastError: null, lastSuccessAt: null, account: null };
  return { state: conn.status === "connected" ? "connected" : "needs_reconnection", lastError: conn.last_error, lastSuccessAt: conn.last_success_at, account: connectionConfig<{ email?: string }>(conn).email ?? null };
}

// Turns the adapter's typed errors into plain-language responses.
export function calendarError(err: unknown): unknown {
  if (err instanceof GoogleCalendarConflictError) return new HttpError(409, "CALENDAR_OVERLAP", "That time overlaps something already in the calendar. Pick another time.");
  if (err instanceof GoogleCalendarRevokedError || err instanceof GoogleCalendarConnectionError) return new HttpError(409, "CALENDAR_NEEDS_RECONNECTION", "This calendar connection expired or was revoked and needs to be reconnected.");
  if (err instanceof GoogleCalendarProviderError) return new HttpError(502, "PROVIDER_ERROR", "Google Calendar is temporarily unavailable. Try again in a moment.");
  if (err instanceof TypeError) return new HttpError(400, "VALIDATION_ERROR", err.message);
  return err;
}

export function adapterFor(ctx: IntegrationContext, environment: GoogleCalendarEnvironment, sdk?: GoogleCalendarSdk) {
  try {
    return googleCalendarAdapter(ctx, oauthConfiguration(environment), sdk);
  } catch {
    throw new HttpError(503, "INTEGRATION_NOT_CONFIGURED", "Google Calendar is not configured on the server (client id, secret and redirect URI).");
  }
}

const isoWithOffset = z.string().datetime({ offset: true });
const busySchema = z.object({ userId: z.string().max(64).optional(), from: isoWithOffset, to: isoWithOffset, timeZone: z.string().default("UTC").refine(isIanaZone, "timeZone must be an IANA zone such as America/New_York.") });

export function googleCalendarManagementRouter(ctx: IntegrationContext, environment: GoogleCalendarEnvironment = process.env, sdk?: GoogleCalendarSdk) {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  // My connection; Admins also get every employee's so they can see who can and cannot be booked (I3.7).
  router.get("/status", (req, res) => {
    const { workspaceId, userId } = req.session!;
    const employees = req.member!.baseLevel === "user" ? undefined
      : (db.prepare("SELECT m.user_id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.removed_at IS NULL ORDER BY u.name").all(workspaceId) as { user_id: string; name: string }[])
          .map((m) => ({ userId: m.user_id, name: m.name, ...calendarState(ctx, workspaceId, m.user_id) }));
    res.json({ ...calendarState(ctx, workspaceId, userId), serverConfigured: Boolean(environment.GOOGLE_CALENDAR_CLIENT_ID && environment.GOOGLE_CALENDAR_CLIENT_SECRET && environment.GOOGLE_CALENDAR_REDIRECT_URI), employees });
  });

  // Disconnect my own account: revoke at Google, delete the stored tokens (I3.1).
  router.delete("/", async (req, res) => {
    const { workspaceId, userId } = req.session!;
    if (calendarState(ctx, workspaceId, userId).state === "not_connected") return void res.status(204).end();
    try {
      await adapterFor(ctx, environment, sdk).disconnect(memberContext(workspaceId, userId)); // revokes, then deletes the tokens
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Google could not be reached: the tokens are still removed locally so the employee is not stuck connected.
      db.prepare("UPDATE integration_connections SET secrets_enc = NULL, status = 'error', last_error = NULL WHERE workspace_id = ? AND provider = 'google' AND user_id = ?").run(workspaceId, userId);
      logEvent(db, { workspaceId, provider: "google", direction: "outbound", eventType: "disconnect", result: "error", detail: "Google could not be reached to revoke access; the stored tokens were deleted." });
    }
    audit(db, { workspaceId, actorId: userId, action: "integration.disconnected", targetType: "integration", targetId: "google" });
    logEvent(db, { workspaceId, provider: "google", direction: "outbound", eventType: "disconnect", result: "ok", detail: "Employee disconnected their Google Calendar." });
    res.status(204).end();
  });

  // Busy periods for one employee, so the booking screen can show or avoid clashes (I3.4).
  router.get("/busy", requirePermission(db, "crmView"), async (req, res) => {
    const parsed = busySchema.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, "VALIDATION_ERROR", validationMessage(parsed.error));
    const { workspaceId, userId } = req.session!;
    const target = parsed.data.userId ?? userId;
    const name = (db.prepare("SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ? AND m.removed_at IS NULL").get(workspaceId, target) as { name: string } | undefined)?.name;
    if (!name) throw new HttpError(404, "NOT_FOUND", "Employee not found.");
    const cal = calendarState(ctx, workspaceId, target);
    if (cal.state === "not_connected") throw new HttpError(409, "CALENDAR_NOT_CONNECTED", `${name} has not connected a Google Calendar, so they cannot be booked yet.`);
    if (cal.state === "needs_reconnection") throw new HttpError(409, "CALENDAR_NEEDS_RECONNECTION", `${name}'s Google Calendar connection expired or was revoked and needs to be reconnected.`);
    try {
      const busy = await adapterFor(ctx, environment, sdk).getFreeBusy(memberContext(workspaceId, target), { start: new Date(parsed.data.from).toISOString(), end: new Date(parsed.data.to).toISOString(), timeZone: parsed.data.timeZone });
      res.json({ userId: target, timeZone: parsed.data.timeZone, busy });
    } catch (err) {
      logEvent(db, { workspaceId, provider: "google", direction: "outbound", eventType: "free_busy", result: "error", detail: (err as Error).name });
      throw calendarError(err);
    }
  });

  return router;
}
