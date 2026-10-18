// Google Calendar features on top of the lead's adapter: connection status (Admins see everyone's), disconnect, free/busy,
// and booking / rescheduling / cancelling appointments with clash detection and correct time zones (I3.1-I3.7).
// The REAL adapter runs; only Google's SDK underneath it is replaced by a controllable fake (no network, no real account).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { GoogleCalendarSdk } from "../../integrations/google-calendar/google-calendar-adapter.ts";
import { saveConnection, type IntegrationContext } from "../src/integrations/core.ts";
import { appointmentsRouter } from "../src/integrations/appointments.ts";
import { googleCalendarManagementRouter } from "../src/integrations/google-calendar-management.ts";
import { googleCalendarOAuthRouter } from "../src/integrations/google-calendar.ts";
import { integrationsStatusRouter } from "../src/integrations/status.ts";
import { localTime } from "../src/integrations/text.ts";
import { startApp, type Team, type TestApp } from "./helpers.ts";

// ----- Fake Google -----
interface FakeEvent { id: string; body: any }
const google = {
  busy: [] as { start: string; end: string }[],
  events: new Map<string, FakeEvent>(),
  inserts: [] as any[], patches: [] as any[], deletes: [] as string[],
  revoked: 0, next: 1,
  failWith: null as null | { status: number; message?: string },   // makes every calendar call fail
  failDeleteWith: null as null | number,
  revokeFails: false, refreshRevoked: false,
};
const overlaps = (aS: string, aE: string, bS: string, bE: string) => Date.parse(aS) < Date.parse(bE) && Date.parse(bS) < Date.parse(aE);
const httpError = (status: number, message = "boom") => Object.assign(new Error(message), { response: { status } });

const sdk: GoogleCalendarSdk = {
  createOAuthClient: () => ({
    generateAuthUrl: (o) => `https://accounts.google.test/authorize?state=${o.state}`,
    getToken: async () => ({ tokens: { access_token: "a", refresh_token: "r", expiry_date: Date.now() + 3_600_000 } }),
    setCredentials: () => undefined,
    refreshAccessToken: async () => { if (google.refreshRevoked) throw Object.assign(new Error("invalid_grant"), { response: { status: 400, data: { error: "invalid_grant" } } }); return { credentials: { access_token: "refreshed" } }; },
    revokeCredentials: async () => { if (google.revokeFails) throw httpError(500); google.revoked++; },
  }),
  createCalendarApi: () => ({
    queryFreeBusy: async ({ requestBody }) => {
      if (google.failWith) throw httpError(google.failWith.status, google.failWith.message);
      const all = [...google.busy, ...[...google.events.values()].map((e) => ({ start: e.body.start.dateTime, end: e.body.end.dateTime }))];
      return { data: { calendars: { primary: { busy: all.filter((b) => overlaps(requestBody.timeMin, requestBody.timeMax, b.start, b.end)) } } } };
    },
    listEvents: async ({ timeMin, timeMax }) => {
      if (google.failWith) throw httpError(google.failWith.status);
      return { data: { items: [...google.events.values()].filter((e) => overlaps(timeMin, timeMax, e.body.start.dateTime, e.body.end.dateTime)).map((e) => ({ id: e.id, status: "confirmed", start: e.body.start, end: e.body.end })) } };
    },
    insertEvent: async ({ requestBody }) => {
      if (google.failWith) throw httpError(google.failWith.status);
      const id = `evt_${google.next++}`; google.events.set(id, { id, body: requestBody }); google.inserts.push(requestBody);
      return { data: { id, htmlLink: `https://calendar.google.test/${id}` } };
    },
    patchEvent: async ({ eventId, requestBody }) => {
      if (google.failWith) throw httpError(google.failWith.status);
      const e = google.events.get(eventId); if (!e) throw httpError(404);
      e.body = { ...e.body, ...requestBody }; google.patches.push({ eventId, requestBody });
      return { data: { id: eventId, htmlLink: `https://calendar.google.test/${eventId}` } };
    },
    deleteEvent: async ({ eventId }) => {
      if (google.failDeleteWith) throw httpError(google.failDeleteWith);
      if (google.failWith) throw httpError(google.failWith.status);
      google.events.delete(eventId); google.deletes.push(eventId);
    },
  }),
};
const environment = { GOOGLE_CALENDAR_CLIENT_ID: "client", GOOGLE_CALENDAR_CLIENT_SECRET: "secret", GOOGLE_CALENDAR_REDIRECT_URI: "https://api.test/api/v1/integrations/google/calendar/oauth/callback" };

let app: TestApp;
let ctx: IntegrationContext;
before(async () => {
  app = await startApp({
    integrations: {
      secretsKey: Buffer.alloc(32, 4), publicBaseUrl: "https://api.test", frontendUrl: "https://app.test",
      mount: (e, c) => {
        ctx = c;
        e.use("/api/v1/integrations/google/calendar", googleCalendarOAuthRouter(c, environment, sdk));
        e.use("/api/v1/integrations/google/calendar", googleCalendarManagementRouter(c, environment, sdk));
        e.use("/api/v1/appointments", appointmentsRouter(c, environment, sdk));
        e.use("/api/v1", integrationsStatusRouter(c));
      },
    },
  });
});
after(() => app.close());
beforeEach(() => {
  google.busy = []; google.events.clear(); google.inserts = []; google.patches = []; google.deletes = [];
  google.revoked = 0; google.next = 1; google.failWith = null; google.failDeleteWith = null; google.revokeFails = false; google.refreshRevoked = false;
});

const connect = (t: Team, userId: string) => saveConnection(ctx, t.workspaceId, "google", userId, { email: "g@example.com" }, { access_token: "ya29.A", refresh_token: "1//R", expiry_date: Date.now() + 3_600_000 });
async function setup(users = 1) {
  const t = await app.team(users);
  connect(t, t.ownerId);
  for (const u of t.users) connect(t, u.id);
  const contact = (await t.owner("POST", "/contacts", { name: "Maya Patel", email: "maya@x.co", phone: "+14155550123" })).json.contact;
  return { t, contact };
}
const body = (contactId: string, over: Record<string, unknown> = {}) => ({ contactId, title: "Proposal review", startsAt: "2026-11-02T14:30:00-05:00", durationMinutes: 45, timezone: "America/New_York", ...over });
const count = (t: Team, status = "confirmed") => (app.db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE workspace_id = ? AND status = ?").get(t.workspaceId, status) as any).n as number;

describe("connection status and disconnect (I3.1, I3.7)", () => {
  it("a user sees their own state; an Admin sees every employee's, including who needs to reconnect", async () => {
    const t = await app.team(2);
    const [a, b] = t.users as [Team["users"][number], Team["users"][number]];
    assert.equal((await a.api("GET", "/integrations/google/calendar/status")).json.state, "not_connected");
    connect(t, a.id); connect(t, b.id);
    app.db.prepare("UPDATE integration_connections SET status = 'needs_reconnection', last_error = 'Google access was revoked or expired. Reconnect Google Calendar.' WHERE user_id = ?").run(b.id);
    const mine = (await a.api("GET", "/integrations/google/calendar/status")).json;
    assert.equal(mine.state, "connected");
    assert.equal(mine.employees, undefined); // ordinary users do not see colleagues
    const admin = (await t.owner("GET", "/integrations/google/calendar/status")).json;
    const byName = Object.fromEntries(admin.employees.map((e: any) => [e.name, e]));
    assert.equal(byName["User 0"].state, "connected");
    assert.equal(byName["User 1"].state, "needs_reconnection");
    assert.match(byName["User 1"].lastError, /Reconnect Google Calendar/);
    assert.equal(byName["Owner"].state, "not_connected");
    assert.equal((await t.owner("GET", "/integrations")).json.items.find((i: any) => i.id === "calendar").status, "needs_reconnection");
  });

  it("disconnecting revokes access at Google, deletes the stored tokens, is audited, and is safe to repeat", async () => {
    const { t } = await setup(1);
    const u = t.users[0]!;
    assert.equal((await u.api("DELETE", "/integrations/google/calendar")).status, 204);
    assert.equal(google.revoked, 1);
    const row = app.db.prepare("SELECT secrets_enc FROM integration_connections WHERE user_id = ? AND provider = 'google'").get(u.id) as any;
    assert.equal(row.secrets_enc, null); // the tokens are gone
    assert.equal((await u.api("GET", "/integrations/google/calendar/status")).json.state, "not_connected");
    assert.equal((await t.owner("GET", "/audit-events?eventType=integration.disconnected")).json.items.length, 1);
    assert.equal((await u.api("DELETE", "/integrations/google/calendar")).status, 204); // already disconnected
    assert.equal(google.revoked, 1);
  });

  it("if Google cannot be reached the tokens are still removed locally and the failure is recorded", async () => {
    const { t } = await setup(1);
    google.revokeFails = true;
    assert.equal((await t.users[0]!.api("DELETE", "/integrations/google/calendar")).status, 204);
    assert.equal((app.db.prepare("SELECT secrets_enc FROM integration_connections WHERE user_id = ? AND provider = 'google'").get(t.users[0]!.id) as any).secrets_enc, null);
    const events = (await t.owner("GET", "/integrations/events?provider=google&result=error")).json;
    assert.ok(events.total >= 1);
  });
});

describe("free/busy (I3.4)", () => {
  it("returns an employee's busy periods for a window, and explains when they cannot be looked up", async () => {
    const { t } = await setup(1);
    google.busy = [{ start: "2026-11-02T19:00:00Z", end: "2026-11-02T20:00:00Z" }, { start: "2026-11-05T10:00:00Z", end: "2026-11-05T11:00:00Z" }];
    const res = await t.owner("GET", `/integrations/google/calendar/busy?from=${encodeURIComponent("2026-11-02T00:00:00-05:00")}&to=${encodeURIComponent("2026-11-03T00:00:00-05:00")}&timeZone=America/New_York`);
    assert.equal(res.status, 200);
    assert.equal(res.json.busy.length, 1);
    assert.equal(res.json.busy[0].start, "2026-11-02T19:00:00Z");
    const q = (extra: string) => t.owner("GET", `/integrations/google/calendar/busy?from=2026-11-02T00:00:00Z&to=2026-11-03T00:00:00Z${extra}`);
    assert.equal((await q("&userId=nobody")).status, 404);
    assert.equal((await t.owner("GET", "/integrations/google/calendar/busy?from=yesterday&to=tomorrow")).status, 400);
    assert.equal((await q("&timeZone=Mars/Base")).status, 400);
    const stranger = await app.team(1); // an employee in another workspace is invisible
    assert.equal((await q(`&userId=${stranger.users[0]!.id}`)).status, 404);
    const unconnected = await app.team(1);
    const blocked = await unconnected.owner("GET", "/integrations/google/calendar/busy?from=2026-11-02T00:00:00Z&to=2026-11-03T00:00:00Z");
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, "CALENDAR_NOT_CONNECTED");
  });
});

describe("booking an appointment (I3.3, I3.4, I3.5)", () => {
  it("creates the event in the employee's calendar and the appointment on the customer record, stored in UTC with its zone", async () => {
    const { t, contact } = await setup(1);
    const opp = (await t.owner("POST", "/opportunities", { contactId: contact.id, pipelineId: (await t.owner("GET", "/pipelines")).json.items[0].id, name: "Rooftop deal", value: 1000 })).json.opportunity;
    const res = await t.owner("POST", "/appointments", body(contact.id, { opportunityId: opp.id, description: "Walk the roof" }));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.startsAt, "2026-11-02T19:30:00.000Z"); // 14:30 at UTC-5 is 19:30 UTC
    assert.equal(res.json.endsAt, "2026-11-02T20:15:00.000Z");
    assert.equal(res.json.timezone, "America/New_York");
    assert.equal(res.json.startsAtLocal, "2026-11-02 14:30 UTC-05:00");
    assert.equal(res.json.synced, true);
    // what Google was asked to create
    assert.equal(google.inserts.length, 1);
    assert.deepEqual(google.inserts[0].start, { dateTime: "2026-11-02T19:30:00.000Z", timeZone: "America/New_York" });
    assert.equal(google.inserts[0].summary, "Proposal review");
    assert.equal(google.inserts[0].description, "Walk the roof");
    // the event id is linked on the CRM row, and the record shows it everywhere it should
    const row = app.db.prepare("SELECT google_event_id, user_id FROM appointments WHERE id = ?").get(res.json.id) as any;
    assert.equal(row.google_event_id, "evt_1");
    const view = (await t.owner("GET", `/contacts/${contact.id}`)).json;
    assert.equal(view.appointments.length, 1);
    assert.ok(view.activities.some((a: any) => /Appointment "Proposal review" booked/.test(a.text)));
    assert.equal((await t.owner("GET", `/opportunities/${opp.id}`)).json.appointments.length, 1);
    assert.equal((await t.owner("GET", "/audit-events?eventType=appointment.created")).json.items.length, 1);
    assert.ok((await t.owner("GET", "/integrations/events?provider=google")).json.items.some((e: any) => e.type === "create_event" && e.result === "ok"));
  });

  it("shows the same instant correctly in any viewer's time zone, including across a daylight-saving change", async () => {
    const { t, contact } = await setup(0);
    const a = (await t.owner("POST", "/appointments", body(contact.id, { startsAt: "2026-03-08T09:00:00-04:00", timezone: "America/New_York" }))).json; // the morning clocks went forward
    assert.equal(a.startsAt, "2026-03-08T13:00:00.000Z");
    const list = (await t.owner("GET", "/appointments?timezone=Asia/Karachi")).json.items;
    assert.equal(list[0].startsAtLocal, "2026-03-08 18:00 UTC+05:00");
    assert.equal(list[0].displayTimezone, "Asia/Karachi");
    assert.equal(list[0].timezone, "America/New_York"); // the booking zone is kept
    assert.equal(localTime("2026-01-15T12:00:00Z", "America/New_York"), "2026-01-15 07:00 UTC-05:00");
    assert.equal(localTime("2026-07-15T12:00:00Z", "America/New_York"), "2026-07-15 08:00 UTC-04:00"); // same zone, different offset in summer
    assert.equal((await t.owner("GET", "/appointments?timezone=Mars/Base")).status, 400);
  });

  it("refuses a time that clashes with the calendar and leaves nothing behind, but allows back-to-back bookings", async () => {
    const { t, contact } = await setup(0);
    google.busy = [{ start: "2026-11-02T19:00:00Z", end: "2026-11-02T19:45:00Z" }]; // an existing meeting 14:00-14:45 local
    const clash = await t.owner("POST", "/appointments", body(contact.id));
    assert.equal(clash.status, 409);
    assert.equal(clash.json.error.code, "CALENDAR_OVERLAP");
    assert.equal(google.inserts.length, 0);
    assert.equal(count(t), 0); // no half-saved appointment
    const touching = await t.owner("POST", "/appointments", body(contact.id, { startsAt: "2026-11-02T14:45:00-05:00" })); // starts exactly when the meeting ends
    assert.equal(touching.status, 201);
    const again = await t.owner("POST", "/appointments", body(contact.id, { startsAt: "2026-11-02T15:00:00-05:00" })); // overlaps the one just booked
    assert.equal(again.status, 409);
    assert.equal(count(t), 1);
  });

  it("rejects ambiguous or invalid input before touching Google", async () => {
    const { t, contact } = await setup(0);
    const bad = async (over: Record<string, unknown>, status = 400) => assert.equal((await t.owner("POST", "/appointments", body(contact.id, over))).status, status, JSON.stringify(over));
    await bad({ startsAt: "2026-11-02T14:30:00" }); // no offset: ambiguous around daylight saving
    await bad({ startsAt: "next tuesday" });
    await bad({ timezone: "Mars/Base" });
    await bad({ durationMinutes: 0 });
    await bad({ durationMinutes: 5000 });
    await bad({ title: "" });
    await bad({ contactId: "nobody" }, 404);
    await bad({ userId: "nobody" }, 404);
    assert.equal((await t.owner("POST", "/appointments", { ...body(contact.id), opportunityId: "nope" })).status, 400);
    assert.equal(google.inserts.length, 0);
    assert.equal(count(t), 0);
  });

  it("an employee without a working calendar cannot be booked, and the reason is stated", async () => {
    const { t, contact } = await setup(2);
    const [a, b] = t.users as [Team["users"][number], Team["users"][number]];
    app.db.prepare("UPDATE integration_connections SET secrets_enc = NULL WHERE user_id = ? AND provider = 'google'").run(a.id); // disconnected
    app.db.prepare("UPDATE integration_connections SET status = 'needs_reconnection' WHERE user_id = ? AND provider = 'google'").run(b.id);
    const none = await t.owner("POST", "/appointments", body(contact.id, { userId: a.id }));
    assert.equal(none.status, 409);
    assert.equal(none.json.error.code, "CALENDAR_NOT_CONNECTED");
    assert.match(none.json.error.message, /User 0 has not connected a Google Calendar/);
    const stale = await t.owner("POST", "/appointments", body(contact.id, { userId: b.id }));
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "CALENDAR_NEEDS_RECONNECTION");
    assert.match(stale.json.error.message, /User 1/);
    assert.equal(count(t), 0);
    // booking another employee who IS connected works, on their calendar
    const ok = await t.owner("POST", "/appointments", body(contact.id, { userId: t.ownerId }));
    assert.equal(ok.status, 201);
    assert.equal(ok.json.userId, t.ownerId);
  });

  it("a revoked grant discovered while booking is reported, flagged for reconnection and nothing is saved", async () => {
    const { t, contact } = await setup(0);
    google.failWith = { status: 401 };
    google.refreshRevoked = true;
    const res = await t.owner("POST", "/appointments", body(contact.id));
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "CALENDAR_NEEDS_RECONNECTION");
    assert.equal(count(t), 0);
    const status = (await t.owner("GET", "/integrations/google/calendar/status")).json;
    assert.equal(status.state, "needs_reconnection");
    assert.match(status.lastError, /revoked or expired/);
  });

  it("a Google outage gives a clear error and leaves no appointment; the rest of the CRM keeps working", async () => {
    const { t, contact } = await setup(0);
    google.failWith = { status: 503 };
    const res = await t.owner("POST", "/appointments", body(contact.id));
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, "PROVIDER_ERROR");
    assert.equal(count(t), 0);
    assert.equal((await t.owner("GET", `/contacts/${contact.id}`)).status, 200);
    assert.equal((await t.owner("POST", `/contacts/${contact.id}/notes`, { text: "still works" })).status, 201);
    assert.ok((await t.owner("GET", "/integrations/events?provider=google&result=error")).json.total >= 1);
    google.failWith = null;
    assert.equal((await t.owner("POST", "/appointments", body(contact.id))).status, 201); // recovers by itself
  });

  it("enforces permissions and workspace isolation", async () => {
    const { t, contact } = await setup(1);
    const other = await setup(0);
    const u = t.users[0]!.api;
    await t.owner("PUT", `/members/${t.users[0]!.id}/permissions`, { permissions: ["crmView"] });
    assert.equal((await u("POST", "/appointments", body(contact.id))).status, 403);
    assert.equal((await u("GET", "/appointments")).status, 200);
    assert.equal((await other.t.owner("POST", "/appointments", body(contact.id))).status, 404); // another workspace's contact
    const mine = (await t.owner("POST", "/appointments", body(contact.id))).json;
    assert.equal((await other.t.owner("GET", `/appointments/${mine.id}`)).status, 404);
    assert.equal((await other.t.owner("PATCH", `/appointments/${mine.id}`, { durationMinutes: 30 })).status, 404);
    assert.equal((await other.t.owner("DELETE", `/appointments/${mine.id}`)).status, 404);
    assert.equal((await other.t.owner("GET", "/appointments")).json.total, 0);
    assert.equal((await app.client()("GET", "/appointments")).status, 401);
  });
});

describe("rescheduling and cancelling (I3.6)", () => {
  it("reschedules in Google and on the record, keeps the history, and refuses a clash", async () => {
    const { t, contact } = await setup(0);
    const a = (await t.owner("POST", "/appointments", body(contact.id))).json;
    const moved = await t.owner("PATCH", `/appointments/${a.id}`, { startsAt: "2026-11-03T10:00:00-05:00" });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.json.startsAt, "2026-11-03T15:00:00.000Z");
    assert.equal(moved.json.endsAt, "2026-11-03T15:45:00.000Z"); // duration kept
    assert.deepEqual(google.patches[0].requestBody.start, { dateTime: "2026-11-03T15:00:00.000Z", timeZone: "America/New_York" });
    assert.equal(google.patches[0].eventId, "evt_1");
    const view = (await t.owner("GET", `/contacts/${contact.id}`)).json;
    assert.ok(view.activities.some((x: any) => /rescheduled to 2026-11-03 10:00 UTC-05:00/.test(x.text)));
    const audit = (await t.owner("GET", "/audit-events?eventType=appointment.rescheduled")).json.items[0];
    assert.equal(audit.before.startsAt, "2026-11-02T19:30:00.000Z");
    assert.equal(audit.after.startsAt, "2026-11-03T15:00:00.000Z");
    // moving it within its own slot is not a clash with itself
    assert.equal((await t.owner("PATCH", `/appointments/${a.id}`, { startsAt: "2026-11-03T10:15:00-05:00" })).status, 200);
    // a clash with another event is refused and the record is untouched
    google.events.set("busy_1", { id: "busy_1", body: { start: { dateTime: "2026-11-04T15:00:00Z" }, end: { dateTime: "2026-11-04T16:00:00Z" } } });
    const clash = await t.owner("PATCH", `/appointments/${a.id}`, { startsAt: "2026-11-04T10:00:00-05:00" });
    assert.equal(clash.status, 409);
    assert.equal(clash.json.error.code, "CALENDAR_OVERLAP");
    assert.equal(((await t.owner("GET", `/appointments/${a.id}`)).json as any).startsAt, "2026-11-03T15:15:00.000Z");
    // duration and zone changes, and empty/invalid requests
    const longer = await t.owner("PATCH", `/appointments/${a.id}`, { durationMinutes: 90, timezone: "Europe/London" });
    assert.equal(longer.json.endsAt, "2026-11-03T16:45:00.000Z");
    assert.equal(longer.json.timezone, "Europe/London");
    assert.equal((await t.owner("PATCH", `/appointments/${a.id}`, {})).status, 400);
    assert.equal((await t.owner("PATCH", `/appointments/${a.id}`, { startsAt: "2026-11-05T10:00:00" })).status, 400);
  });

  it("cancels in Google and on the record; cancelling twice, or an event already deleted in Google, is fine", async () => {
    const { t, contact } = await setup(0);
    const a = (await t.owner("POST", "/appointments", body(contact.id))).json;
    const done = await t.owner("DELETE", `/appointments/${a.id}`);
    assert.equal(done.status, 200);
    assert.equal(done.json.status, "cancelled");
    assert.deepEqual(google.deletes, ["evt_1"]);
    assert.equal((app.db.prepare("SELECT google_event_id AS g FROM appointments WHERE id = ?").get(a.id) as any).g, null);
    assert.ok(((await t.owner("GET", `/contacts/${contact.id}`)).json.activities as any[]).some((x) => /cancelled/.test(x.text)));
    assert.equal((await t.owner("DELETE", `/appointments/${a.id}`)).status, 200); // repeat
    assert.equal(google.deletes.length, 1);
    assert.equal((await t.owner("PATCH", `/appointments/${a.id}`, { durationMinutes: 30 })).status, 409); // a cancelled appointment cannot be moved
    // the slot is free again
    assert.equal((await t.owner("POST", "/appointments", body(contact.id))).status, 201);
    // deleted in Google by hand
    const b = (await t.owner("POST", "/appointments", body(contact.id, { startsAt: "2026-11-09T09:00:00-05:00" }))).json;
    google.failDeleteWith = 404;
    assert.equal((await t.owner("DELETE", `/appointments/${b.id}`)).json.status, "cancelled");
    // a Google outage during cancel keeps the appointment so nothing is left half-cancelled
    google.failDeleteWith = null;
    const c = (await t.owner("POST", "/appointments", body(contact.id, { startsAt: "2026-11-10T09:00:00-05:00" }))).json;
    google.failDeleteWith = 503;
    const outage = await t.owner("DELETE", `/appointments/${c.id}`);
    assert.equal(outage.status, 502);
    assert.equal((await t.owner("GET", `/appointments/${c.id}`)).json.status, "confirmed");
    assert.equal((await t.owner("GET", "/audit-events?eventType=appointment.cancelled")).json.items.length, 2);
  });

  it("an appointment that was never linked to Google cannot be rescheduled but can be cancelled", async () => {
    const { t, contact } = await setup(0);
    app.db.prepare("INSERT INTO appointments (id, workspace_id, contact_id, user_id, title, starts_at, ends_at, timezone, created_at) VALUES ('orphan',?,?,?,?,?,?,?,?)").run(t.workspaceId, contact.id, t.ownerId, "Unsynced", "2026-12-01T15:00:00Z", "2026-12-01T16:00:00Z", "UTC", new Date().toISOString());
    const move = await t.owner("PATCH", "/appointments/orphan", { durationMinutes: 30 });
    assert.equal(move.status, 409);
    assert.equal(move.json.error.code, "NOT_SYNCED");
    assert.equal((await t.owner("GET", "/appointments/orphan")).json.synced, false);
    assert.equal((await t.owner("DELETE", "/appointments/orphan")).json.status, "cancelled");
  });
});

describe("listing appointments", () => {
  it("filters by time, employee, contact and status, and pages", async () => {
    const { t, contact } = await setup(1);
    const other = (await t.owner("POST", "/contacts", { name: "Other", email: "o@x.co", phone: "+14155550999" })).json.contact;
    for (let i = 0; i < 5; i++) await t.owner("POST", "/appointments", body(contact.id, { startsAt: `2026-11-1${i}T09:00:00-05:00` }));
    await t.owner("POST", "/appointments", body(other.id, { userId: t.users[0]!.id, startsAt: "2026-11-20T09:00:00-05:00" }));
    const first = (await t.owner("GET", "/appointments?pageSize=3")).json;
    assert.equal(first.total, 6);
    assert.equal(first.items.length, 3);
    assert.ok(first.items[0].startsAt < first.items[1].startsAt); // chronological
    assert.equal((await t.owner("GET", `/appointments?contactId=${other.id}`)).json.total, 1);
    assert.equal((await t.owner("GET", `/appointments?userId=${t.users[0]!.id}`)).json.total, 1);
    assert.equal((await t.owner("GET", `/appointments?from=${encodeURIComponent("2026-11-12T00:00:00Z")}&to=${encodeURIComponent("2026-11-15T00:00:00Z")}`)).json.total, 3);
    const cancelled = first.items[0].id;
    await t.owner("DELETE", `/appointments/${cancelled}`);
    assert.equal((await t.owner("GET", "/appointments?status=cancelled")).json.total, 1);
    assert.equal((await t.owner("GET", "/appointments?status=confirmed")).json.total, 5);
  });
});
