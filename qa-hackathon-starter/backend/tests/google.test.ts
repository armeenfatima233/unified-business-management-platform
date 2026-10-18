// Google Calendar OAuth: the state is single-use and bound to the session that started it; tokens are encrypted per
// workspace and employee; a revoked grant shows "needs reconnection". Most tests use a labelled stand-in for the
// adapter's two OAuth methods; the last suite runs the REAL adapter (with a stubbed Google SDK, no network) when present.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAppointmentLinkStore, createConnectionStore, createOAuthStateStore, googleOAuthRouter, type GoogleMemberContext, type GoogleOAuthPort,
} from "../src/integrations/googleCalendar.ts";
import { decryptSecrets, type IntegrationContext } from "../src/integrations/core.ts";
import { integrationsStatusRouter } from "../src/integrations/status.ts";
import { startApp, type TestApp } from "./helpers.ts";

let app: TestApp;
let ctxRef: IntegrationContext;
const calls: { method: string; args: unknown[] }[] = [];
let port: GoogleOAuthPort | null;
let completeResult: () => Promise<GoogleMemberContext>;

// Stand-in for the adapter's OAuth methods.
const standIn: GoogleOAuthPort = {
  async createAuthorizationUrl(context, binding) { calls.push({ method: "create", args: [context, binding] }); return `https://accounts.google.com/o/oauth2/v2/auth?state=STATE_FOR_${context.memberId}`; },
  async completeAuthorization(code, state, binding) { calls.push({ method: "complete", args: [code, state, binding] }); return completeResult(); },
  async disconnect(context) { calls.push({ method: "disconnect", args: [context] }); },
};

before(async () => {
  app = await startApp({
    integrations: {
      publicBaseUrl: "https://hooks.example", frontendUrl: "https://app.example", secretsKey: Buffer.alloc(32, 9),
      mount: (expressApp, ctx) => {
        ctxRef = ctx;
        expressApp.use("/api/v1", googleOAuthRouter(ctx, async () => port));
        expressApp.use("/api/v1", integrationsStatusRouter(ctx));
      },
    },
  });
});
after(() => app.close());

async function cookieFor(email: string, password = "correct-horse-battery") {
  const res = await fetch(`${app.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const get = (path: string, cookie?: string) => fetch(`${app.base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

describe("OAuth state store (session-bound, single use)", () => {
  it("stores only a hash, works once, only for the same session, and never after it expires", async () => {
    const store = createOAuthStateStore(app.db);
    const ctx = { workspaceId: "w1", memberId: "u1" };
    await store.create(sha("state-1"), ctx, sha("session-A"), new Date(Date.now() + 60_000));
    assert.equal(JSON.stringify(app.db.prepare("SELECT * FROM google_oauth_states").all()).includes("state-1"), false); // no raw state at rest
    assert.equal(await store.consume(sha("state-1"), sha("session-B")), null); // someone else's session
    assert.deepEqual(await store.consume(sha("state-1"), sha("session-A")), ctx); // the real owner can still use it (it was not burned)
    assert.equal(await store.consume(sha("state-1"), sha("session-A")), null); // single use
    await store.create(sha("state-2"), ctx, sha("session-A"), new Date(Date.now() - 1000));
    assert.equal(await store.consume(sha("state-2"), sha("session-A")), null); // expired
    assert.equal(await store.consume(sha("never-issued"), sha("session-A")), null);
  });
});

describe("connection store (encrypted, scoped, status mapping)", () => {
  it("encrypts tokens per workspace and employee, maps revoked/reauth to needs-reconnection, and deletes on disconnect", async () => {
    const t = await app.team(2);
    const store = createConnectionStore(ctxRef);
    const me = { workspaceId: t.workspaceId, memberId: t.users[0]!.id };
    const other = { workspaceId: t.workspaceId, memberId: t.users[1]!.id };
    await store.saveCredentials(me, { access_token: "ya29.SECRET-ACCESS", refresh_token: "1//SECRET-REFRESH", expiry_date: 123 });
    const raw = app.db.prepare("SELECT secrets_enc, status, user_id FROM integration_connections WHERE workspace_id = ? AND provider = 'google'").all(t.workspaceId) as any[];
    assert.equal(raw.length, 1);
    assert.ok(!raw[0].secrets_enc.includes("SECRET")); // ciphertext only
    assert.equal(raw[0].user_id, me.memberId);
    assert.deepEqual(decryptSecrets(ctxRef.secretsKey, raw[0].secrets_enc), { access_token: "ya29.SECRET-ACCESS", refresh_token: "1//SECRET-REFRESH", expiry_date: 123 });
    assert.equal(await store.getCredentials(other), null); // another employee has nothing
    assert.equal(await store.getCredentials({ workspaceId: "another-workspace", memberId: me.memberId }), null);
    await store.setStatus(me, "revoked");
    let row = app.db.prepare("SELECT status, last_error FROM integration_connections WHERE user_id = ?").get(me.memberId) as any;
    assert.equal(row.status, "needs_reconnection");
    assert.match(row.last_error, /revoked or expired/);
    await store.saveCredentials(me, { access_token: "ya29.NEW", refresh_token: "1//SECRET-REFRESH" }); // reconnecting clears the warning
    row = app.db.prepare("SELECT status, last_error FROM integration_connections WHERE user_id = ?").get(me.memberId) as any;
    assert.deepEqual({ ...row }, { status: "connected", last_error: null });
    await store.setStatus(me, "reauthorization_required");
    assert.match((app.db.prepare("SELECT last_error FROM integration_connections WHERE user_id = ?").get(me.memberId) as any).last_error, /refresh token/);
    await store.deleteCredentials(me);
    await store.setStatus(me, "disconnected"); // harmless after the row is gone
    assert.equal(await store.getCredentials(me), null);
  });

  it("links and unlinks a Google event id on an appointment, only within its own workspace", async () => {
    const t = await app.team(0);
    const contact = (await t.owner("POST", "/contacts", { name: "Booked Person", email: "bp@example.com" })).json.contact;
    app.db.prepare("INSERT INTO appointments (id, workspace_id, contact_id, user_id, title, starts_at, ends_at, timezone, created_at) VALUES ('ap1',?,?,?,?,?,?,?,?)").run(t.workspaceId, contact.id, t.ownerId, "Visit", "2026-11-02T18:00:00Z", "2026-11-02T19:00:00Z", "America/New_York", new Date().toISOString());
    const links = createAppointmentLinkStore(app.db);
    await links.setGoogleEventId({ workspaceId: "other", memberId: t.ownerId }, { appointmentId: "ap1" }, "evt_x");
    assert.equal((app.db.prepare("SELECT google_event_id AS g FROM appointments WHERE id = 'ap1'").get() as any).g, null); // wrong workspace: untouched
    await links.setGoogleEventId({ workspaceId: t.workspaceId, memberId: t.ownerId }, { appointmentId: "ap1" }, "evt_123");
    assert.equal((app.db.prepare("SELECT google_event_id AS g FROM appointments WHERE id = 'ap1'").get() as any).g, "evt_123");
    await links.clearGoogleEventId({ workspaceId: t.workspaceId, memberId: t.ownerId }, { appointmentId: "ap1" });
    assert.equal((app.db.prepare("SELECT google_event_id AS g FROM appointments WHERE id = 'ap1'").get() as any).g, null);
  });
});

describe("GET /integrations/google/connect and /callback", () => {
  it("connect needs a session, passes the session cookie as the binding, and can return JSON or redirect", async () => {
    const t = await app.team(1);
    port = standIn; calls.length = 0;
    assert.equal((await get("/integrations/google/connect")).status, 401);
    const cookie = await cookieFor(t.users[0]!.email);
    const res = await get("/integrations/google/connect", cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.match(body.url, /^https:\/\/accounts\.google\.com\//);
    assert.equal(body.redirectUri, "https://hooks.example/api/v1/integrations/google/callback");
    const [create] = calls;
    assert.deepEqual(create!.args[0], { workspaceId: t.workspaceId, memberId: t.users[0]!.id }); // identity comes from the session, never the request
    assert.equal(create!.args[1], cookie.split("=")[1]); // the binding is the session token
    const redirect = await get("/integrations/google/connect?redirect=1", cookie);
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get("location")!, /accounts\.google\.com/);
    port = null;
    const off = await get("/integrations/google/connect", cookie);
    assert.equal(off.status, 503);
    assert.equal(((await off.json()) as any).error.code, "INTEGRATION_NOT_CONFIGURED");
  });

  it("the callback completes only for a signed-in session, records the connection and sends the browser back to the app", async () => {
    const t = await app.team(1);
    port = standIn; calls.length = 0;
    const u = t.users[0]!;
    const cookie = await cookieFor(u.email);
    completeResult = async () => ({ workspaceId: t.workspaceId, memberId: u.id });
    await createConnectionStore(ctxRef).saveCredentials({ workspaceId: t.workspaceId, memberId: u.id }, { access_token: "a", refresh_token: "r" });
    // no session: the state alone authorises nothing
    const anon = await get("/integrations/google/callback?code=abc&state=xyz");
    assert.equal(anon.headers.get("location"), "https://app.example/?google=error&reason=signin_required");
    assert.equal(calls.filter((c) => c.method === "complete").length, 0);
    // signed in
    const ok = await get("/integrations/google/callback?code=abc&state=xyz", cookie);
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), "https://app.example/?google=connected");
    const complete = calls.find((c) => c.method === "complete")!;
    assert.deepEqual(complete.args, ["abc", "xyz", cookie.split("=")[1]]);
    const audit = (await t.owner("GET", "/audit-events?eventType=integration.connected")).json.items;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actorId, u.id);
    assert.ok(!JSON.stringify(audit).includes("abc")); // the code never reaches the log
  });

  it("denied consent, missing parameters, a wrong-person state and adapter failures all end on a friendly error redirect", async () => {
    const t = await app.team(2);
    port = standIn;
    const cookie = await cookieFor(t.users[0]!.email);
    assert.equal((await get("/integrations/google/callback?error=access_denied", cookie)).headers.get("location"), "https://app.example/?google=denied");
    assert.match((await get("/integrations/google/callback?code=only", cookie)).headers.get("location")!, /google=error&reason=missing_parameters/);
    completeResult = async () => ({ workspaceId: t.workspaceId, memberId: t.users[1]!.id }); // state belonged to someone else
    assert.match((await get("/integrations/google/callback?code=c&state=s", cookie)).headers.get("location")!, /reason=state/);
    completeResult = async () => { const e = new Error("bad"); e.name = "GoogleCalendarOAuthStateError"; throw e; };
    assert.match((await get("/integrations/google/callback?code=c&state=s", cookie)).headers.get("location")!, /reason=state/);
    completeResult = async () => { const e = new Error("bad"); e.name = "GoogleCalendarOAuthError"; throw e; };
    assert.match((await get("/integrations/google/callback?code=c&state=s", cookie)).headers.get("location")!, /reason=oauth/);
    port = null;
    assert.match((await get("/integrations/google/callback?code=c&state=s", cookie)).headers.get("location")!, /reason=not_configured/);
    const events = app.db.prepare("SELECT COUNT(*) AS n FROM integration_events WHERE workspace_id = ? AND provider = 'google' AND result = 'error'").get(t.workspaceId) as any;
    assert.ok(events.n >= 3); // each failure is in the synchronisation history
  });
});

describe("status and disconnect (I3.7)", () => {
  it("a user sees their own connection, an Admin sees everyone's, and disconnecting removes the stored tokens", async () => {
    const t = await app.team(2);
    port = standIn; calls.length = 0;
    const [a, b] = t.users as [typeof t.users[number], typeof t.users[number]];
    const store = createConnectionStore(ctxRef);
    await store.saveCredentials({ workspaceId: t.workspaceId, memberId: a.id }, { access_token: "A", refresh_token: "RA" });
    await store.saveCredentials({ workspaceId: t.workspaceId, memberId: b.id }, { access_token: "B", refresh_token: "RB" });
    await store.setStatus({ workspaceId: t.workspaceId, memberId: b.id }, "revoked");
    const aCookie = await cookieFor(a.email);
    const mine = (await (await get("/integrations/google/status", aCookie)).json()) as any;
    assert.equal(mine.status, "connected");
    assert.equal(mine.employees, undefined); // ordinary users do not see colleagues
    const adminView = (await t.owner("GET", "/integrations/google/status")).json;
    const states = Object.fromEntries(adminView.employees.map((e: any) => [e.name, e.status]));
    assert.equal(states["User 0"], "connected");
    assert.equal(states["User 1"], "needs_reconnection"); // an employee without a working calendar is visible to Admins
    assert.equal((await t.owner("GET", "/integrations")).json.items.find((i: any) => i.id === "calendar").status, "needs_reconnection");
    const del = await fetch(`${app.base}/integrations/google`, { method: "DELETE", headers: { cookie: aCookie } });
    assert.equal(del.status, 204);
    assert.equal(calls.filter((c) => c.method === "disconnect").length, 1);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM integration_connections WHERE user_id = ? AND provider = 'google'").get(a.id) && (app.db.prepare("SELECT COUNT(*) AS n FROM integration_connections WHERE user_id = ? AND provider = 'google'").get(a.id) as any).n, 0);
    assert.equal(((await (await get("/integrations/google/status", aCookie)).json()) as any).status, "not_connected");
    assert.equal((await t.owner("GET", "/audit-events?eventType=integration.disconnected")).json.items.length, 1);
  });
});

// ---- The real adapter with a stubbed Google SDK (needs integrations/google-calendar + npm install) ----
const adapterUrl = new URL("../../integrations/google-calendar/", import.meta.url);
const adapterDir = fileURLToPath(adapterUrl);
const haveAdapter = existsSync(`${adapterDir}google-calendar-adapter.ts`) && existsSync(`${adapterDir}node_modules`);

describe("with the real Google Calendar adapter", { skip: haveAdapter ? false : "integrations/google-calendar not merged or not installed" }, () => {
  it("runs the whole consent flow: bound state, token exchange, encrypted storage, replay and cross-session attempts fail, disconnect revokes", async () => {
    const { GoogleCalendarAdapter } = await import(new URL("google-calendar-adapter.ts", adapterUrl).href);
    let revoked = 0;
    const sdk = {
      createOAuthClient: ({ clientId, redirectUri }: { clientId: string; redirectUri: string }) => ({
        generateAuthUrl: (o: any) => `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(o.scope.join(" "))}&access_type=${o.access_type}&prompt=${o.prompt}&state=${o.state}`,
        getToken: async (code: string) => { if (code !== "good-code") throw new Error("invalid_grant"); return { tokens: { access_token: "ya29.REAL-ACCESS", refresh_token: "1//REAL-REFRESH", expiry_date: Date.now() + 3_600_000 } }; },
        setCredentials: () => undefined, refreshAccessToken: async () => { throw new Error("not used"); },
        revokeCredentials: async () => { revoked++; },
      }),
      createCalendarApi: () => { throw new Error("not used"); },
    };
    const real = await startApp({
      integrations: {
        publicBaseUrl: "https://hooks.example", frontendUrl: "https://app.example", secretsKey: Buffer.alloc(32, 3),
        mount: (e, ctx) => {
          const adapter = new GoogleCalendarAdapter({ configuration: { clientId: "client-123", clientSecret: "secret-456", redirectUri: "https://hooks.example/api/v1/integrations/google/callback" }, oauthStateStore: createOAuthStateStore(ctx.db), connectionStore: createConnectionStore(ctx), appointmentLinkStore: createAppointmentLinkStore(ctx.db), sdk });
          e.use("/api/v1", googleOAuthRouter(ctx, async () => adapter as GoogleOAuthPort));
        },
      },
    });
    try {
      const t = await real.team(2);
      const login = async (email: string) => { const r = await fetch(`${real.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct-horse-battery" }) }); return r.headers.get("set-cookie")!.split(";")[0]!; };
      const nav = (path: string, cookie?: string, init: RequestInit = {}) => fetch(`${real.base}${path}`, { redirect: "manual", ...init, headers: { ...(cookie ? { cookie } : {}) } });
      const [c0, c1] = [await login(t.users[0]!.email), await login(t.users[1]!.email)];
      const start = (await (await nav("/integrations/google/connect", c0)).json()) as any;
      const url = new URL(start.url);
      assert.equal(url.searchParams.get("client_id"), "client-123");
      assert.equal(url.searchParams.get("access_type"), "offline");
      assert.match(url.searchParams.get("scope")!, /calendar\.events/);
      const state = url.searchParams.get("state")!;
      assert.equal(JSON.stringify(real.db.prepare("SELECT * FROM google_oauth_states").all()).includes(state), false); // only the hash is stored
      // a different signed-in person cannot complete someone else's flow, and cannot burn it
      assert.match((await nav(`/integrations/google/callback?code=good-code&state=${state}`, c1)).headers.get("location")!, /reason=state/);
      assert.equal(real.db.prepare("SELECT COUNT(*) AS n FROM integration_connections WHERE provider = 'google'").get()!.n, 0);
      // no session at all
      assert.match((await nav(`/integrations/google/callback?code=good-code&state=${state}`)).headers.get("location")!, /signin_required/);
      // the genuine owner completes it
      assert.equal((await nav(`/integrations/google/callback?code=good-code&state=${state}`, c0)).headers.get("location"), "https://app.example/?google=connected");
      const stored = real.db.prepare("SELECT secrets_enc, status, user_id FROM integration_connections WHERE provider = 'google'").get() as any;
      assert.equal(stored.user_id, t.users[0]!.id);
      assert.equal(stored.status, "connected");
      assert.ok(!stored.secrets_enc.includes("REAL-ACCESS") && !stored.secrets_enc.includes("REAL-REFRESH"));
      // replay of the same state fails
      assert.match((await nav(`/integrations/google/callback?code=good-code&state=${state}`, c0)).headers.get("location")!, /reason=state/);
      // a failed code exchange is reported without touching the stored connection
      const second = new URL(((await (await nav("/integrations/google/connect", c0)).json()) as any).url).searchParams.get("state")!;
      assert.match((await nav(`/integrations/google/callback?code=bad-code&state=${second}`, c0)).headers.get("location")!, /reason=oauth/);
      assert.equal(real.db.prepare("SELECT status FROM integration_connections WHERE provider = 'google'").get()!.status, "connected");
      // disconnect revokes at Google and deletes the tokens
      assert.equal((await nav("/integrations/google", c0, { method: "DELETE" })).status, 204);
      assert.equal(revoked, 1);
      assert.equal(real.db.prepare("SELECT COUNT(*) AS n FROM integration_connections WHERE provider = 'google'").get()!.n, 0);
    } finally { real.close(); }
  });
});
