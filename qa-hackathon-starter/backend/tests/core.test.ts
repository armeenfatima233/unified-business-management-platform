// Core hardening: member removal without orphans (Q4), CSRF origin check and response headers (Q3),
// and the durable webhook de-duplication helper that integrations build on (Q5).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { processOnce } from "../src/integrations/core.ts";
import { startApp, type Team, type TestApp } from "./helpers.ts";

let app: TestApp;
before(async () => { app = await startApp({ corsOrigins: ["http://localhost:3000"] }); });
after(() => app.close());

const rules = (t: Team, patch: Record<string, unknown> = {}) =>
  t.owner("PUT", "/settings/lead-routing", { ackWindowSeconds: 600, maxOpenLeads: 8, escalationLevels: 3, idleSeconds: 86400, levelWindowSeconds: [], backupUserId: null, managerUserId: t.ownerId, ...patch });
let phone = 5552000;
const submit = (t: Team) => app.client()("POST", `/public/leads/${t.publicKey}`, { name: "Maya Patel", phone: `+1415${phone++}` });

describe("removing a member leaves no orphaned or contradictory data (Q4)", () => {
  it("moves their open leads, clears ownership and routing roles, ends their sessions and keeps history", async () => {
    const t = await app.team(2);
    const [a, b] = t.users as [Team["users"][number], Team["users"][number]];
    await rules(t, { backupUserId: a.id });
    await t.owner("PATCH", `/members/${t.ownerId}/availability`, { availability: "offline" });
    await t.owner("PATCH", `/members/${b.id}/availability`, { availability: "busy" });
    await submit(t); await submit(t); // both go to `a`, the only Available person
    const mine = (await a.api("GET", "/leads?scope=mine")).json.items as any[];
    assert.equal(mine.length, 2);
    await a.api("POST", `/leads/${mine[0].id}/acknowledge`); // one acknowledged, one not
    const contact = (await t.owner("POST", "/contacts", { name: "Owned", email: "o@x.co", phone: "+14155559001", ownerId: a.id })).json.contact;
    await t.owner("PATCH", `/members/${b.id}/availability`, { availability: "available" });
    await t.owner("PATCH", `/members/${t.ownerId}/availability`, { availability: "available" });

    assert.equal((await t.owner("DELETE", `/members/${a.id}`)).status, 204);

    const leads = (await t.owner("GET", "/leads?scope=all")).json.items as any[];
    assert.equal(leads.length, 2);
    assert.ok(leads.every((l) => l.ownerId !== a.id), "no open lead still belongs to the removed person");
    assert.equal(new Set(leads.map((l) => l.id)).size, 2); // each lead still has exactly one owner
    assert.equal((await t.owner("GET", `/contacts/${contact.id}`)).json.contact.ownerId, null);
    assert.equal((await t.owner("GET", "/settings/lead-routing")).json.backupUserId, null); // routing no longer names them
    assert.equal((await a.api("GET", "/auth/me")).status, 401); // signed out everywhere immediately
    assert.equal((await app.client()("POST", "/auth/login", { email: a.email, password: "correct-horse-battery" })).status, 403); // no workspace left
    const members = (await t.owner("GET", "/members")).json.items as any[];
    assert.ok(!members.some((m) => m.id === a.id));
    // history is intact: the audit trail still names them, and the removal is recorded
    const audit = (await t.owner("GET", "/audit-events?eventType=member.removed")).json.items;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].after.reassignedLeads, 2);
    assert.ok((await t.owner("GET", "/audit-events?eventType=lead")).json.items.some((e: any) => e.type === "lead.created"));
    // the removed person receives no new leads
    for (let i = 0; i < 4; i++) await submit(t);
    assert.ok(((await t.owner("GET", "/leads?scope=all")).json.items as any[]).every((l) => l.ownerId !== a.id));
  });

  it("an Admin cannot remove an Owner or another Admin; nobody removes themselves; strangers get 404", async () => {
    const t = await app.team(1);
    const other = await app.team(1);
    const inv = await t.owner("POST", "/members/invitations", { email: "adm-core@example.com", baseLevel: "admin" });
    const admin = app.client();
    const acc = await admin("POST", "/auth/accept-invitation", { token: inv.json.token, name: "Admin", password: "correct-horse-battery" });
    assert.equal((await admin("DELETE", `/members/${t.ownerId}`)).status, 403);
    assert.equal((await admin("DELETE", `/members/${acc.json.user.id}`)).status, 400);
    assert.equal((await t.users[0]!.api("DELETE", `/members/${acc.json.user.id}`)).status, 403);
    assert.equal((await other.owner("DELETE", `/members/${t.users[0]!.id}`)).status, 404); // another workspace's member
    assert.equal((await admin("DELETE", `/members/${t.users[0]!.id}`)).status, 204); // an Admin may remove a User
  });

  it("when the removed person was the manager fallback, the Owner takes over so a lead always has an owner", async () => {
    const t = await app.team(1);
    await rules(t, { managerUserId: t.users[0]!.id });
    await t.owner("DELETE", `/members/${t.users[0]!.id}`);
    assert.equal((await t.owner("GET", "/settings/lead-routing")).json.managerUserId, t.ownerId);
    await t.owner("PATCH", `/members/${t.ownerId}/availability`, { availability: "busy" });
    await submit(t); // nobody eligible -> manager fallback = Owner
    assert.equal(((await t.owner("GET", "/leads?scope=all")).json.items as any[])[0].ownerId, t.ownerId);
  });
});

describe("request hardening (Q3)", () => {
  const post = (origin?: string) =>
    fetch(`${app.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ email: "nobody@example.com", password: "x" }) });

  it("refuses a state-changing request from a foreign origin but allows the frontend and non-browser callers", async () => {
    assert.equal((await post("http://evil.example")).status, 403);
    assert.equal((await post("http://localhost:3000")).status, 401); // reached the handler (bad credentials)
    assert.equal((await post()).status, 401); // no Origin header: provider webhooks, scripts
    assert.equal((await fetch(`${app.base}/health`, { headers: { origin: "http://evil.example" } })).status, 200); // reads are not state-changing
  });

  it("sends security headers and does not advertise the framework", async () => {
    const res = await fetch(`${app.base}/health`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  it("returns the shared error shape for unknown routes and oversized or malformed bodies", async () => {
    const missing = await fetch(`${app.base}/nope`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as any).error.code, "NOT_FOUND");
    const big = await fetch(`${app.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.co", password: "x".repeat(400_000) }) });
    assert.equal(big.status, 413);
    assert.equal(((await big.json()) as any).error.code, "PAYLOAD_TOO_LARGE");
    const bad = await fetch(`${app.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(bad.status, 400);
  });
});

describe("durable webhook de-duplication helper (Q5)", () => {
  it("runs the work once per provider event id, rolls back with it, and is scoped per workspace and provider", async () => {
    const t = await app.team(0);
    const other = await app.team(0);
    let runs = 0;
    assert.equal(processOnce(app.db, t.workspaceId, "resend", "evt_1", () => { runs++; }), true);
    assert.equal(processOnce(app.db, t.workspaceId, "resend", "evt_1", () => { runs++; }), false); // provider retry
    assert.equal(runs, 1);
    assert.equal(processOnce(app.db, other.workspaceId, "resend", "evt_1", () => { runs++; }), true); // different workspace
    assert.equal(processOnce(app.db, t.workspaceId, "twilio", "evt_1", () => { runs++; }), true); // different provider
    assert.equal(runs, 3);
    // a failure inside the work leaves no ledger row, so the provider's retry is processed
    assert.throws(() => processOnce(app.db, t.workspaceId, "resend", "evt_2", () => { throw new Error("boom"); }), /boom/);
    assert.equal(processOnce(app.db, t.workspaceId, "resend", "evt_2", () => { runs++; }), true);
    assert.equal(runs, 4);
  });
});

describe("opening a database created before the CRM existed", () => {
  it("adds missing tables/columns and gives old workspaces a form key, pipeline and routing rules", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const { openDb } = await import("../src/db.ts");
    const dir = mkdtempSync(join(tmpdir(), "ubmp-legacy-"));
    const path = join(dir, "legacy.db");
    // The first-release schema: workspaces without public_key, memberships without removed_at, nothing else.
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE memberships (workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
        base_level TEXT NOT NULL CHECK (base_level IN ('owner','admin','user')), availability TEXT NOT NULL DEFAULT 'available', created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id));
      INSERT INTO workspaces VALUES ('w1','Old Co','2026-01-01T00:00:00Z');
      INSERT INTO users VALUES ('u1','old@example.com','Old Owner','x','2026-01-01T00:00:00Z');
      INSERT INTO memberships VALUES ('w1','u1','owner','available','2026-01-01T00:00:00Z');`);
    legacy.close();
    const db = openDb(path);
    const ws = db.prepare("SELECT public_key FROM workspaces WHERE id = 'w1'").get() as { public_key: string };
    assert.match(ws.public_key, /^[0-9a-f]{32}$/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pipelines WHERE workspace_id = 'w1'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM stages WHERE workspace_id = 'w1'").get() as { n: number }).n, 5);
    assert.equal((db.prepare("SELECT manager_user_id AS m FROM lead_routing_rules WHERE workspace_id = 'w1'").get() as { m: string }).m, "u1");
    db.close();
    openDb(path).close(); // opening again is a no-op (idempotent)
    rmSync(dir, { recursive: true, force: true });
  });
});
