// Tests for F3 (lead capture, assignment, acknowledgement, escalation, absence, recovery,
// no-duplicate action) and F4 (audit). Time is controlled by passing `nowMs` to the worker tick
// instead of sleeping, so the escalation chain is exercised deterministically.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb, type Db } from "../src/db.ts";
import { escalateLead } from "../src/leads/service.ts";
import { runLeadTick } from "../src/leads/worker.ts";

let db: Db;
let server: Server;
let base: string;
let dir: string;

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;

function client(): Api {
  let cookie = "";
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

const PASSWORD = "correct-horse-battery";
let counter = 0;

interface Team { owner: Api; ownerId: string; publicKey: string; workspaceId: string; users: { api: Api; id: string }[]; }

// A workspace with an Owner and `n` plain users, all Available.
async function team(n: number): Promise<Team> {
  counter++;
  const owner = client();
  const signup = await owner("POST", "/auth/signup", { email: `owner${counter}@example.com`, password: PASSWORD, name: "Owner", workspaceName: `WS${counter}` });
  assert.equal(signup.status, 201);
  const users: Team["users"] = [];
  for (let i = 0; i < n; i++) {
    const inv = await owner("POST", "/members/invitations", { email: `u${counter}_${i}@example.com`, baseLevel: "user" });
    const api = client();
    const acc = await api("POST", "/auth/accept-invitation", { token: inv.json.token, name: `User ${i}`, password: PASSWORD });
    users.push({ api, id: acc.json.user.id });
  }
  const form = await owner("GET", "/settings/public-form");
  return { owner, ownerId: signup.json.user.id, publicKey: form.json.publicKey, workspaceId: signup.json.workspace.id, users };
}

const setRules = (t: Team, patch: Record<string, unknown> = {}) =>
  t.owner("PUT", "/settings/lead-routing", {
    ackWindowSeconds: 5, maxOpenLeads: 8, escalationLevels: 3, idleSeconds: 86400, levelWindowSeconds: [],
    backupUserId: null, managerUserId: t.ownerId, ...patch,
  });

let phone = 5550000;
const submit = (t: Team, extra: Record<string, unknown> = {}) =>
  client()("POST", `/public/leads/${t.publicKey}`, { name: "Maya Patel", phone: `+1415${phone++}`, message: "Interested in solar", ...extra });
const leadsOf = async (api: Api, scope = "all") => (await api("GET", `/leads?scope=${scope}`)).json.items as any[];
// Makes a lead's acknowledgement window already over, as if the time had passed (the worker uses the real clock).
const expire = (leadId: string) => db.prepare("UPDATE leads SET deadline_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), leadId);
const tick = (t: Team) => runLeadTick(db, Date.now(), t.workspaceId); // scoped so other tests' leads are untouched

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ubmp-leads-"));
  db = openDb(join(dir, "leads.db"));
  await new Promise<void>((resolve) => {
    server = createApp(db).listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("lead capture and assignment (F3.1-F3.3)", () => {
  it("a public form submission becomes a lead with source web_form and exactly one owner", async () => {
    const t = await team(2);
    await setRules(t);
    const r = await submit(t, { source: "manual" }); // a client-supplied source must be ignored
    assert.equal(r.status, 201);
    const [lead] = await leadsOf(t.owner);
    assert.equal(lead.source, "web_form");
    assert.ok(lead.ownerId);
    assert.equal(lead.status, "needs_acknowledgement");
    assert.ok(lead.secondsRemaining > 0 && lead.secondsRemaining <= 5);
  });

  it("rejects an unknown form key and invalid input", async () => {
    const t = await team(0);
    assert.equal((await client()("POST", "/public/leads/not-a-real-key", { name: "A", phone: "+14155550101" })).status, 404);
    assert.equal((await client()("POST", `/public/leads/${t.publicKey}`, { name: "A" })).status, 400);
    assert.equal((await client()("POST", `/public/leads/${t.publicKey}`, { phone: "+14155550101" })).status, 400);
  });

  it("manual entry creates a lead labelled manual", async () => {
    const t = await team(1);
    await setRules(t);
    const r = await t.owner("POST", "/leads", { contact: { name: "Sam", phone: "+14155559999" }, message: "Called in" });
    assert.equal(r.status, 201);
    assert.equal(r.json.source, "manual");
  });

  it("distributes round-robin and never gives leads to non-Available employees", async () => {
    const t = await team(3);
    await setRules(t);
    await t.owner("PATCH", `/members/${t.users[0]!.id}/availability`, { availability: "on_leave" });
    await t.owner("PATCH", `/members/${t.users[1]!.id}/availability`, { availability: "busy" });
    await t.owner("PATCH", `/members/${t.ownerId}/availability`, { availability: "offline" });
    for (let i = 0; i < 4; i++) await submit(t);
    const owners = new Set((await leadsOf(t.owner)).map((l) => l.ownerId));
    assert.deepEqual([...owners], [t.users[2]!.id]); // only the Available user
  });

  it("rotates fairly among Available employees", async () => {
    const t = await team(2);
    await setRules(t);
    for (let i = 0; i < 6; i++) await submit(t);
    const counts = new Map<string, number>();
    for (const l of await leadsOf(t.owner)) counts.set(l.ownerId, (counts.get(l.ownerId) ?? 0) + 1);
    assert.deepEqual([...counts.values()].sort(), [2, 2, 2]); // owner + 2 users, equal shares
  });

  it("respects the maximum open leads per employee", async () => {
    const t = await team(1);
    await setRules(t, { maxOpenLeads: 1 });
    await t.owner("PATCH", `/members/${t.ownerId}/availability`, { availability: "offline" });
    await submit(t);
    await submit(t); // the only Available user is at capacity -> manager fallback (D06)
    const leads = await leadsOf(t.owner);
    const full = leads.filter((l) => l.ownerId === t.users[0]!.id);
    assert.equal(full.length, 1);
    const fallback = leads.find((l) => l.ownerId === t.ownerId);
    assert.ok(fallback, "second lead goes to the manager fallback");
    assert.equal(fallback.attentionReason, "No eligible employee");
  });

  it("with nobody eligible the lead still has exactly one owner and appears in the recovery queue (D06, F3.7)", async () => {
    const t = await team(1);
    await setRules(t);
    await t.owner("PATCH", `/members/${t.users[0]!.id}/availability`, { availability: "offline" });
    await t.owner("PATCH", `/members/${t.ownerId}/availability`, { availability: "busy" });
    await submit(t);
    const [lead] = await leadsOf(t.owner);
    assert.equal(lead.ownerId, t.ownerId);
    const recovery = (await t.owner("GET", "/leads/recovery")).json.items;
    assert.ok(recovery[0].recoveryReasons.includes("No eligible employee"));
  });
});

describe("acknowledgement (F3.4)", () => {
  it("the owner acknowledges once; repeating it does not change first response; others cannot", async () => {
    const t = await team(2);
    await setRules(t);
    await submit(t);
    const lead = (await leadsOf(t.owner))[0];
    const ownerApi = lead.ownerId === t.ownerId ? t.owner : t.users.find((u) => u.id === lead.ownerId)!.api;
    const stranger = t.users.find((u) => u.id !== lead.ownerId)!.api;
    assert.equal((await stranger("POST", `/leads/${lead.id}/acknowledge`)).status, 403);
    const first = await ownerApi("POST", `/leads/${lead.id}/acknowledge`);
    assert.equal(first.status, 200);
    const second = await ownerApi("POST", `/leads/${lead.id}/acknowledge`);
    assert.equal(second.json.acknowledgedAt, first.json.acknowledgedAt);
    const detail = (await t.owner("GET", `/leads/${lead.id}`)).json;
    assert.equal(detail.status, "acknowledged");
    assert.equal(detail.secondsRemaining, null);
    const acks = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'lead.acknowledged' AND target_id = ?").get(lead.id) as { n: number };
    assert.equal(acks.n, 1);
  });

  it("an acknowledged lead is not escalated when its window passes", async () => {
    const t = await team(1);
    await setRules(t);
    await submit(t);
    const lead = (await leadsOf(t.owner))[0];
    const ownerApi = lead.ownerId === t.ownerId ? t.owner : t.users[0]!.api;
    await ownerApi("POST", `/leads/${lead.id}/acknowledge`);
    expire(lead.id);
    assert.equal(tick(t), 0);
  });
});

describe("escalation chain (F3.5, F3.8)", () => {
  it("moves next eligible employee -> backup -> manager, then stops", async () => {
    const t = await team(3); // users 0,1,2 ; owner is the manager
    const backup = t.users[2]!.id;
    await setRules(t, { backupUserId: backup, escalationLevels: 3 });
    // keep the manager and the backup out of the first rotation so the chain order is visible
    await t.owner("PATCH", `/members/${t.ownerId}/availability`, { availability: "busy" });
    await t.owner("PATCH", `/members/${backup}/availability`, { availability: "busy" });
    await submit(t);
    const first = (await leadsOf(t.owner))[0];
    const history = () => (db.prepare("SELECT to_user_id, reason FROM lead_assignment_history WHERE lead_id = ? ORDER BY rowid").all(first.id) as { to_user_id: string; reason: string }[]);
    assert.equal(history().length, 1);
    // everyone comes back so the backup is eligible by the time it is needed
    await t.owner("PATCH", `/members/${backup}/availability`, { availability: "available" });
    expire(first.id);
    assert.equal(tick(t), 1); // level 1: next eligible employee (not the first owner)
    let lead = (await t.owner("GET", `/leads/${first.id}`)).json;
    assert.notEqual(lead.ownerId, first.ownerId);
    assert.equal(lead.escalationCount, 1);
    expire(first.id);
    assert.equal(tick(t), 1); // level 2: designated backup
    lead = (await t.owner("GET", `/leads/${first.id}`)).json;
    assert.equal(lead.ownerId, backup);
    expire(first.id);
    assert.equal(tick(t), 1); // level 3: manager
    lead = (await t.owner("GET", `/leads/${first.id}`)).json;
    assert.equal(lead.ownerId, t.ownerId);
    assert.equal(lead.escalationCount, 3);
    expire(first.id);
    assert.equal(tick(t), 0); // chain finished: no more movement
    lead = (await t.owner("GET", `/leads/${first.id}`)).json;
    assert.equal(lead.ownerId, t.ownerId);
    assert.ok(lead.recoveryReasons.includes("Escalated 3 times"));
    const reasons = history().map((h) => h.reason);
    assert.deepEqual(reasons.slice(1), ["escalation", "escalation", "escalation"]);
  });

  it("two timers expiring together escalate the lead only once", async () => {
    const t = await team(3);
    await setRules(t);
    await submit(t);
    const lead = (await leadsOf(t.owner))[0];
    expire(lead.id);
    const results = [escalateLead(db, t.workspaceId, lead.id), escalateLead(db, t.workspaceId, lead.id)];
    assert.deepEqual(results.sort(), ["escalated", "skipped"]);
    const detail = (await t.owner("GET", `/leads/${lead.id}`)).json;
    assert.equal(detail.escalationCount, 1);
    const owners = db.prepare("SELECT COUNT(DISTINCT owner_id) AS n FROM leads WHERE id = ?").get(lead.id) as { n: number };
    assert.equal(owners.n, 1);
  });

  it("an escalation overdue while the server was down is processed after restart (durable timers)", async () => {
    const t = await team(2);
    await setRules(t);
    await submit(t);
    const before = (await leadsOf(t.owner))[0];
    expire(before.id);
    // simulate a restart: a brand new connection to the same file, no in-memory state
    const reopened = openDb(join(dir, "leads.db"));
    assert.equal(runLeadTick(reopened, Date.now(), t.workspaceId), 1);
    const row = reopened.prepare("SELECT owner_id, escalation_count FROM leads WHERE id = ?").get(before.id) as { owner_id: string; escalation_count: number };
    assert.notEqual(row.owner_id, before.ownerId);
    assert.equal(row.escalation_count, 1);
    reopened.close();
  });

  it("an escalation queues an external alert for the new owner and is audited with the system as actor", async () => {
    const t = await team(2);
    await setRules(t);
    await submit(t);
    const lead = (await leadsOf(t.owner))[0];
    expire(lead.id);
    tick(t);
    const alert = db.prepare("SELECT user_id, status FROM delivery_attempts WHERE lead_id = ?").get(lead.id) as { user_id: string; status: string };
    const now = (await t.owner("GET", `/leads/${lead.id}`)).json;
    assert.equal(alert.user_id, now.ownerId);
    assert.equal(alert.status, "pending");
    const audit = await t.owner("GET", "/audit-events?eventType=lead.escalated");
    assert.equal(audit.json.items.length, 1);
    assert.equal(audit.json.items[0].actor, "System");
  });
});

describe("absence handling (F3.6, D07)", () => {
  it("setting On leave immediately reassigns unacknowledged leads and flags acknowledged ones", async () => {
    const t = await team(2);
    await setRules(t);
    await t.owner("PATCH", `/members/${t.ownerId}/availability`, { availability: "busy" });
    const a = t.users[0]!;
    await t.owner("PATCH", `/members/${t.users[1]!.id}/availability`, { availability: "busy" });
    await submit(t);
    await submit(t); // both go to user 0 (only Available)
    const mine = await leadsOf(a.api, "mine");
    assert.equal(mine.length, 2);
    await a.api("POST", `/leads/${mine[0].id}/acknowledge`);
    await t.owner("PATCH", `/members/${t.users[1]!.id}/availability`, { availability: "available" });
    const away = await a.api("PATCH", "/members/me/availability", { availability: "on_leave" });
    assert.equal(away.status, 200);
    const all = await leadsOf(t.owner);
    const unack = all.find((l) => l.id === mine[1].id)!;
    const acked = all.find((l) => l.id === mine[0].id)!;
    assert.notEqual(unack.ownerId, a.id); // moved at once
    assert.equal(acked.ownerId, a.id); // kept...
    assert.equal(acked.handoverRequired, true); // ...but visibly flagged
    const back = await a.api("PATCH", "/members/me/availability", { availability: "available" });
    assert.equal(back.status, 200);
    assert.equal((await t.owner("GET", `/leads/${acked.id}`)).json.handoverRequired, false);
  });
});

describe("manual reassignment and recovery queue (F3.7)", () => {
  it("only managers reassign, only to Available people, and every lead keeps one owner", async () => {
    const t = await team(2);
    await setRules(t);
    await submit(t);
    const lead = (await leadsOf(t.owner))[0];
    const target = t.users.find((u) => u.id !== lead.ownerId) ?? t.users[0]!;
    assert.equal((await t.users[0]!.api("POST", `/leads/${lead.id}/reassign`, { assigneeId: target.id })).status, 403);
    await t.owner("PATCH", `/members/${target.id}/availability`, { availability: "offline" });
    assert.equal((await t.owner("POST", `/leads/${lead.id}/reassign`, { assigneeId: target.id })).status, 409);
    await t.owner("PATCH", `/members/${target.id}/availability`, { availability: "available" });
    const ok = await t.owner("POST", `/leads/${lead.id}/reassign`, { assigneeId: target.id });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ownerId, target.id);
    assert.equal(ok.json.history.at(-1).reason, "manual");
    assert.equal(ok.json.escalationCount, 0); // manual reassignment is not counted as an escalation
  });

  it("lists overdue, repeatedly escalated and idle leads, with the reason", async () => {
    const t = await team(2);
    await setRules(t, { idleSeconds: 1 });
    await submit(t);
    await new Promise((r) => setTimeout(r, 1100));
    const queue = (await t.owner("GET", "/leads/recovery")).json.items;
    assert.equal(queue.length, 1);
    assert.ok(queue[0].recoveryReasons.some((r: string) => r.startsWith("No recorded action")));
    const queued = queue[0];
    expire(queued.id);
    tick(t);
    expire(queued.id);
    tick(t);
    const after2 = (await t.owner("GET", "/leads/recovery")).json.items[0];
    assert.ok(after2.recoveryReasons.includes("Escalated 2 times"));
  });
});

describe("isolation and audit (F1.6, F4)", () => {
  it("another workspace cannot read, acknowledge or reassign a lead by guessing its id", async () => {
    const a = await team(1);
    const b = await team(1);
    await setRules(a);
    await submit(a);
    const lead = (await leadsOf(a.owner))[0];
    assert.equal((await b.owner("GET", `/leads/${lead.id}`)).status, 404);
    assert.equal((await b.owner("POST", `/leads/${lead.id}/acknowledge`)).status, 404);
    assert.equal((await b.owner("POST", `/leads/${lead.id}/reassign`, { assigneeId: b.users[0]!.id })).status, 404);
    assert.equal((await leadsOf(b.owner)).length, 0);
  });

  it("the audit log needs the permission, is filterable, and cannot be edited or deleted", async () => {
    const t = await team(1);
    await setRules(t);
    await submit(t);
    assert.equal((await t.users[0]!.api("GET", "/audit-events")).status, 403);
    const all = await t.owner("GET", "/audit-events");
    assert.equal(all.status, 200);
    const types = new Set(all.json.items.map((e: any) => e.type));
    for (const expected of ["workspace.created", "member.invited", "member.joined", "routing_rules.updated", "lead.created", "lead.assigned"]) {
      assert.ok(types.has(expected), `missing ${expected}`);
    }
    const onlyLead = await t.owner("GET", "/audit-events?eventType=lead");
    assert.ok(onlyLead.json.items.length > 0 && onlyLead.json.items.every((e: any) => e.type.startsWith("lead.")));
    const byActor = await t.owner("GET", `/audit-events?actorId=${t.ownerId}`);
    assert.ok(byActor.json.items.every((e: any) => e.actorId === t.ownerId));
    const future = await t.owner("GET", `/audit-events?from=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`);
    assert.equal(future.json.total, 0);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal((await t.owner(method, `/audit-events/${all.json.items[0].id}`, {})).status, 404);
    }
    assert.throws(() => db.prepare("UPDATE audit_events SET action = 'x'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM audit_events").run(), /append-only/);
  });
});

describe("routing settings validation", () => {
  it("rejects bad rules and non-members as manager/backup; needs the permission", async () => {
    const t = await team(1);
    assert.equal((await setRules(t, { escalationLevels: 9 })).status, 400);
    assert.equal((await setRules(t, { ackWindowSeconds: 0 })).status, 400);
    assert.equal((await setRules(t, { backupUserId: "nobody" })).status, 400);
    assert.equal((await t.users[0]!.api("GET", "/settings/lead-routing")).status, 403);
    assert.equal((await setRules(t)).status, 200);
  });
});
