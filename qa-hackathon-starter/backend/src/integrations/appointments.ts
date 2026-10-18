// Appointments (I3.3-I3.6): booked from a contact or opportunity into the employee's real Google Calendar through the
// Google adapter. The CRM row is the source of truth for the customer record; the Google event id links the two.
//
// Time zones (I3.5): every instant is stored in UTC together with the IANA zone it was booked in; input must carry an
// explicit UTC offset (an offset-free local time is ambiguous around daylight saving, so it is refused); responses give
// both the UTC instant and the wall-clock time in the zone the viewer asks for.
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { GoogleCalendarSdk } from "../../../integrations/google-calendar/google-calendar-adapter.ts";
import { GoogleCalendarLinkPersistenceError, GoogleCalendarProviderError } from "../../../integrations/google-calendar/google-calendar-adapter.ts";
import { audit } from "../audit/audit.ts";
import { logActivity } from "../crm/common.ts";
import { tx, type Db } from "../db.ts";
import { publish } from "../events/bus.ts";
import { HttpError, paginate, validationMessage } from "../http.ts";
import { recordLeadAction } from "../leads/service.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { loadMember, requirePermission } from "../middleware/requirePermission.ts";
import type { IntegrationContext } from "./core.ts";
import { logEvent } from "./core.ts";
import { adapterFor, calendarError, calendarState } from "./google-calendar-management.ts";
import { memberContext, type GoogleCalendarEnvironment } from "./google-calendar.ts";
import { isIanaZone, localTime } from "./text.ts";

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/, "startsAt must be an ISO time with an explicit offset, e.g. 2026-11-02T14:30:00-05:00.");
const zone = z.string().refine(isIanaZone, "timezone must be an IANA zone such as America/New_York.");
const createSchema = z.object({
  contactId: z.string().min(1).max(64),
  opportunityId: z.string().max(64).nullish(),
  userId: z.string().max(64).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  startsAt: iso,
  durationMinutes: z.number().int().min(5).max(1440),
  timezone: zone,
});
const patchSchema = z.object({ startsAt: iso.optional(), durationMinutes: z.number().int().min(5).max(1440).optional(), timezone: zone.optional() })
  .refine((v) => v.startsAt !== undefined || v.durationMinutes !== undefined || v.timezone !== undefined, { message: "Send a new startsAt, durationMinutes or timezone." });

interface Row { id: string; workspace_id: string; contact_id: string; opportunity_id: string | null; user_id: string; title: string; starts_at: string; ends_at: string; timezone: string; google_event_id: string | null; status: "confirmed" | "cancelled"; created_at: string }

const getRow = (db: Db, workspaceId: string, id: string) => db.prepare("SELECT * FROM appointments WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as Row | undefined;

function view(db: Db, a: Row, viewerZone?: string) {
  const names = db.prepare("SELECT c.name AS contact, u.name AS employee FROM contacts c, users u WHERE c.id = ? AND u.id = ?").get(a.contact_id, a.user_id) as { contact: string; employee: string };
  const zoneForDisplay = viewerZone ?? a.timezone;
  return {
    id: a.id, title: a.title, contactId: a.contact_id, contact: names.contact, opportunityId: a.opportunity_id, userId: a.user_id, employee: names.employee,
    startsAt: a.starts_at, endsAt: a.ends_at, timezone: a.timezone, displayTimezone: zoneForDisplay,
    startsAtLocal: localTime(a.starts_at, zoneForDisplay), endsAtLocal: localTime(a.ends_at, zoneForDisplay),
    status: a.status, synced: a.google_event_id !== null, createdAt: a.created_at,
  };
}

export function appointmentsRouter(ctx: IntegrationContext, environment: GoogleCalendarEnvironment = process.env, sdk?: GoogleCalendarSdk) {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(db), loadMember(db));

  const log = (workspaceId: string, eventType: string, result: "ok" | "error", detail?: string, externalId?: string) =>
    logEvent(db, { workspaceId, provider: "google", direction: "outbound", eventType, externalId: externalId ?? null, result, detail });

  router.get("/", requirePermission(db, "crmView"), (req, res) => {
    const { workspaceId } = req.session!;
    const { page, pageSize, offset } = paginate(req.query);
    const where = ["workspace_id = ?"]; const args: (string | number)[] = [workspaceId];
    const from = typeof req.query.from === "string" && req.query.from ? (req.query.from === "now" ? new Date() : new Date(req.query.from)) : null;
    if (from && !Number.isNaN(from.getTime())) { where.push("starts_at >= ?"); args.push(from.toISOString()); }
    const to = typeof req.query.to === "string" && req.query.to ? new Date(req.query.to) : null;
    if (to && !Number.isNaN(to.getTime())) { where.push("starts_at <= ?"); args.push(to.toISOString()); }
    for (const [param, col] of [["userId", "user_id"], ["contactId", "contact_id"], ["status", "status"]] as const) {
      if (typeof req.query[param] === "string" && req.query[param]) { where.push(`${col} = ?`); args.push(req.query[param] as string); }
    }
    const viewerZone = typeof req.query.timezone === "string" && req.query.timezone ? req.query.timezone : undefined;
    if (viewerZone && !isIanaZone(viewerZone)) throw new HttpError(400, "VALIDATION_ERROR", "timezone must be an IANA zone such as America/New_York.");
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n;
    const rows = db.prepare(`SELECT * FROM appointments WHERE ${where.join(" AND ")} ORDER BY starts_at LIMIT ? OFFSET ?`).all(...args, pageSize, offset) as unknown as Row[];
    res.json({ items: rows.map((r) => view(db, r, viewerZone)), page, pageSize, total });
  });

  router.get("/:id", requirePermission(db, "crmView"), (req, res) => {
    const a = getRow(db, req.session!.workspaceId, String(req.params.id));
    if (!a) throw new HttpError(404, "NOT_FOUND", "Appointment not found.");
    res.json(view(db, a, typeof req.query.timezone === "string" && isIanaZone(req.query.timezone) ? req.query.timezone : undefined));
  });

  // Book (I3.3, I3.4): refuses a clash, and an employee whose calendar is not usable cannot be booked (I3.7).
  router.post("/", requirePermission(db, "crmEdit"), async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "VALIDATION_ERROR", validationMessage(parsed.error));
    const { workspaceId, userId: actor } = req.session!;
    const d = parsed.data;
    const employeeId = d.userId ?? actor;
    const employee = db.prepare("SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ? AND m.removed_at IS NULL").get(workspaceId, employeeId) as { name: string } | undefined;
    if (!employee) throw new HttpError(404, "NOT_FOUND", "Employee not found.");
    if (!db.prepare("SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ?").get(workspaceId, d.contactId)) throw new HttpError(404, "NOT_FOUND", "Contact not found.");
    if (d.opportunityId && !db.prepare("SELECT 1 FROM opportunities WHERE workspace_id = ? AND id = ? AND contact_id = ?").get(workspaceId, d.opportunityId, d.contactId)) throw new HttpError(400, "VALIDATION_ERROR", "That opportunity does not belong to this contact.");
    const cal = calendarState(ctx, workspaceId, employeeId);
    if (cal.state === "not_connected") throw new HttpError(409, "CALENDAR_NOT_CONNECTED", `${employee.name} has not connected a Google Calendar, so they cannot be booked yet.`);
    if (cal.state === "needs_reconnection") throw new HttpError(409, "CALENDAR_NEEDS_RECONNECTION", `${employee.name}'s Google Calendar connection expired or was revoked and needs to be reconnected.`);
    const adapter = adapterFor(ctx, environment, sdk);

    const start = new Date(d.startsAt);
    if (Number.isNaN(start.getTime())) throw new HttpError(400, "VALIDATION_ERROR", "startsAt is not a valid time.");
    const startIso = start.toISOString();
    const endIso = new Date(start.getTime() + d.durationMinutes * 60_000).toISOString();
    const id = randomUUID();
    // The CRM row is created first because the adapter links the Google event id onto an existing, authorised appointment.
    db.prepare("INSERT INTO appointments (id, workspace_id, contact_id, opportunity_id, user_id, title, starts_at, ends_at, timezone, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      id, workspaceId, d.contactId, d.opportunityId ?? null, employeeId, d.title, startIso, endIso, d.timezone, new Date().toISOString(),
    );
    try {
      await adapter.createAppointment(memberContext(workspaceId, employeeId), { appointmentId: id, contactId: d.contactId, ...(d.opportunityId ? { opportunityId: d.opportunityId } : {}) }, {
        summary: d.title, ...(d.description ? { description: d.description } : {}), start: startIso, end: endIso, timeZone: d.timezone,
      });
    } catch (err) {
      if (err instanceof GoogleCalendarLinkPersistenceError) {
        db.prepare("UPDATE appointments SET google_event_id = ? WHERE id = ?").run(err.eventId, id); // the event exists in Google: reconcile instead of retrying a create
      } else {
        db.prepare("DELETE FROM appointments WHERE id = ?").run(id); // nothing was created in Google, so nothing stays here
        log(workspaceId, "create_event", "error", err instanceof Error ? err.name : "error");
        throw calendarError(err);
      }
    }
    tx(db, () => {
      logActivity(db, { workspaceId, contactId: d.contactId, opportunityId: d.opportunityId, type: "appointment", text: `Appointment "${d.title}" booked with ${employee.name} for ${localTime(startIso, d.timezone)}.`, actorId: actor });
      audit(db, { workspaceId, actorId: actor, action: "appointment.created", targetType: "appointment", targetId: id, after: { employeeId, startsAt: startIso, endsAt: endIso, timezone: d.timezone } });
      recordLeadAction(db, workspaceId, d.contactId, actor); // booking counts as acknowledgement
    });
    log(workspaceId, "create_event", "ok", undefined, id);
    publish(workspaceId, { type: "leadUpdated", title: "Appointment booked", detail: `${d.title} with ${employee.name}.`, tone: "success" });
    res.status(201).json(view(db, getRow(db, workspaceId, id)!));
  });

  // Reschedule (I3.6): the same clash check applies, ignoring the event being moved.
  router.patch("/:id", requirePermission(db, "crmEdit"), async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "VALIDATION_ERROR", validationMessage(parsed.error));
    const { workspaceId, userId: actor } = req.session!;
    const a = getRow(db, workspaceId, String(req.params.id));
    if (!a) throw new HttpError(404, "NOT_FOUND", "Appointment not found.");
    if (a.status === "cancelled") throw new HttpError(409, "APPOINTMENT_CANCELLED", "This appointment was cancelled.");
    if (!a.google_event_id) throw new HttpError(409, "NOT_SYNCED", "This appointment is not linked to a Google Calendar event. Cancel it and book again.");
    const d = parsed.data;
    const minutes = d.durationMinutes ?? Math.round((new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60_000);
    const start = d.startsAt ? new Date(d.startsAt) : new Date(a.starts_at);
    if (Number.isNaN(start.getTime())) throw new HttpError(400, "VALIDATION_ERROR", "startsAt is not a valid time.");
    const startIso = start.toISOString();
    const endIso = new Date(start.getTime() + minutes * 60_000).toISOString();
    const tz = d.timezone ?? a.timezone;
    const adapter = adapterFor(ctx, environment, sdk);
    try {
      await adapter.rescheduleAppointment(memberContext(workspaceId, a.user_id), { appointmentId: a.id, contactId: a.contact_id, ...(a.opportunity_id ? { opportunityId: a.opportunity_id } : {}) }, a.google_event_id, { start: startIso, end: endIso, timeZone: tz });
    } catch (err) {
      if (!(err instanceof GoogleCalendarLinkPersistenceError)) { log(workspaceId, "update_event", "error", err instanceof Error ? err.name : "error"); throw calendarError(err); }
    }
    tx(db, () => {
      db.prepare("UPDATE appointments SET starts_at = ?, ends_at = ?, timezone = ? WHERE id = ?").run(startIso, endIso, tz, a.id);
      logActivity(db, { workspaceId, contactId: a.contact_id, opportunityId: a.opportunity_id, type: "appointment", text: `Appointment "${a.title}" rescheduled to ${localTime(startIso, tz)}.`, actorId: actor });
      audit(db, { workspaceId, actorId: actor, action: "appointment.rescheduled", targetType: "appointment", targetId: a.id, before: { startsAt: a.starts_at, endsAt: a.ends_at, timezone: a.timezone }, after: { startsAt: startIso, endsAt: endIso, timezone: tz } });
    });
    log(workspaceId, "update_event", "ok", undefined, a.id);
    res.json(view(db, getRow(db, workspaceId, a.id)!));
  });

  // Cancel (I3.6): removes the Google event, keeps the appointment on the record as cancelled.
  router.delete("/:id", requirePermission(db, "crmEdit"), async (req, res) => {
    const { workspaceId, userId: actor } = req.session!;
    const a = getRow(db, workspaceId, String(req.params.id));
    if (!a) throw new HttpError(404, "NOT_FOUND", "Appointment not found.");
    if (a.status === "cancelled") return void res.json(view(db, a)); // cancelling twice changes nothing
    if (a.google_event_id) {
      try {
        await adapterFor(ctx, environment, sdk).cancelAppointment(memberContext(workspaceId, a.user_id), { appointmentId: a.id, contactId: a.contact_id, ...(a.opportunity_id ? { opportunityId: a.opportunity_id } : {}) }, a.google_event_id);
      } catch (err) {
        const alreadyGone = err instanceof GoogleCalendarProviderError && (err.statusCode === 404 || err.statusCode === 410); // deleted in Google already: fine
        if (!alreadyGone && !(err instanceof GoogleCalendarLinkPersistenceError)) { log(workspaceId, "delete_event", "error", err instanceof Error ? err.name : "error"); throw calendarError(err); }
      }
    }
    tx(db, () => {
      db.prepare("UPDATE appointments SET status = 'cancelled', google_event_id = NULL WHERE id = ?").run(a.id);
      logActivity(db, { workspaceId, contactId: a.contact_id, opportunityId: a.opportunity_id, type: "appointment", text: `Appointment "${a.title}" cancelled.`, actorId: actor });
      audit(db, { workspaceId, actorId: actor, action: "appointment.cancelled", targetType: "appointment", targetId: a.id, before: { status: "confirmed" }, after: { status: "cancelled" } });
    });
    log(workspaceId, "delete_event", "ok", undefined, a.id);
    res.json(view(db, getRow(db, workspaceId, a.id)!));
  });

  return router;
}
