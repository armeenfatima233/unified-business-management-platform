// Tests for F5 (dashboard) and Q12 (every figure matches the records behind it).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { zonedStart } from "../src/dashboard/routes.ts";
import { runLeadTick } from "../src/leads/worker.ts";
import { startApp, type Team, type TestApp } from "./helpers.ts";

let app: TestApp;
before(async () => { app = await startApp(); });
after(() => app.close());

const rules = (t: Team) => t.owner("PUT", "/settings/lead-routing", { ackWindowSeconds: 5, maxOpenLeads: 8, escalationLevels: 3, idleSeconds: 86400, levelWindowSeconds: [], backupUserId: null, managerUserId: t.ownerId });
let phone = 5551000;
const submit = (t: Team) => app.client()("POST", `/public/leads/${t.publicKey}`, { name: "Maya Patel", phone: `+1415${phone++}` });
const expire = (leadId: string) => app.db.prepare("UPDATE leads SET deadline_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), leadId);

describe("time zones", () => {
  it("computes the start of the viewer's day and month in UTC", () => {
    assert.equal(zonedStart("day", "America/Los_Angeles", new Date("2026-10-18T03:00:00Z")).toISOString(), "2026-10-17T07:00:00.000Z");
    assert.equal(zonedStart("month", "America/Los_Angeles", new Date("2026-10-18T03:00:00Z")).toISOString(), "2026-10-01T07:00:00.000Z");
    assert.equal(zonedStart("day", "Asia/Karachi", new Date("2026-10-18T22:00:00Z")).toISOString(), "2026-10-18T19:00:00.000Z");
    assert.equal(zonedStart("day", "UTC", new Date("2026-10-18T22:00:00Z")).toISOString(), "2026-10-18T00:00:00.000Z");
  });
});

describe("dashboard figures (F5.1, F5.2, F5.3)", () => {
  it("shows all eight figures and each matches the records its drill-down opens", async () => {
    const t = await app.team(2);
    await rules(t);
    for (let i = 0; i < 4; i++) await submit(t);
    const all = (await t.owner("GET", "/leads?scope=all")).json.items as any[];
    // acknowledge one (response time), escalate one twice (recovery + escalations)
    const toAck = all[0];
    const ownerOf = (id: string) => (id === t.ownerId ? t.owner : t.users.find((u) => u.id === id)!.api);
    await ownerOf(toAck.ownerId)("POST", `/leads/${toAck.id}/acknowledge`);
    const toEsc = all[1];
    expire(toEsc.id); runLeadTick(app.db, Date.now(), t.workspaceId);
    expire(toEsc.id); runLeadTick(app.db, Date.now(), t.workspaceId);

    const s = (await t.owner("GET", "/dashboard/summary?tz=UTC")).json;
    assert.equal(s.scope, "company");
    for (const key of ["newLeads", "openPipeline", "responseTime", "recovery", "escalations", "availability", "appointments", "payments"]) assert.ok(key in s.metrics, key);
    assert.equal(s.metrics.newLeads.value, 4);
    assert.equal((await t.owner("GET", `/leads?scope=all&createdFrom=${encodeURIComponent(s.metrics.newLeads.since)}`)).json.total, 4);
    assert.equal(s.metrics.escalations.value, 2);
    assert.equal((await t.owner("GET", `/leads?scope=all&escalatedSince=${encodeURIComponent(s.metrics.escalations.since)}`)).json.total, 1); // one lead, two escalations
    assert.equal(s.metrics.recovery.value, (await t.owner("GET", "/leads/recovery")).json.total);
    assert.ok(s.metrics.recovery.value >= 1);
    assert.equal(s.metrics.responseTime.sampleSize, 1);
    assert.ok(s.metrics.responseTime.averageSeconds >= 0);
    assert.equal(s.metrics.availability.total, 3);
    assert.equal(s.metrics.availability.available, 3);
    assert.deepEqual(s.metrics.payments.collected, []); // nothing collected: unpaid is not revenue
  });

  it("open pipeline value is grouped by stage, excludes won/lost, and equals the opportunity list", async () => {
    const t = await app.team(0);
    const p = (await t.owner("GET", "/pipelines")).json.items[0];
    const stage = (name: string) => p.stages.find((s: any) => s.name === name).id;
    const c = (await t.owner("POST", "/contacts", { name: "Buyer", email: "b@x.co", phone: "+14155557000" })).json.contact;
    const mk = (value: number, stageName: string) => t.owner("POST", "/opportunities", { contactId: c.id, pipelineId: p.id, stageId: stage(stageName), name: `${stageName} ${value}`, value });
    await mk(1000, "New"); await mk(2500, "New"); await mk(4000, "Proposal"); await mk(9999, "Won"); await mk(777, "Lost");
    const s = (await t.owner("GET", "/dashboard/summary")).json;
    const byStage = Object.fromEntries(s.metrics.openPipeline.byStage.map((x: any) => [x.stage, x]));
    assert.equal(byStage.New.amount, 3500);
    assert.equal(byStage.New.count, 2);
    assert.equal(byStage.Proposal.amount, 4000);
    assert.ok(!("Won" in byStage) && !("Lost" in byStage));
    assert.equal(s.metrics.openPipeline.total, 7500);
    const list = (await t.owner("GET", `/opportunities?stageId=${stage("New")}`)).json;
    assert.equal(list.items.reduce((sum: number, o: any) => sum + o.value, 0), byStage.New.amount);
  });

  it("amounts are hidden from users without the value permission, even when calling the API directly", async () => {
    const t = await app.team(1);
    const p = (await t.owner("GET", "/pipelines")).json.items[0];
    const c = (await t.owner("POST", "/contacts", { name: "Buyer", email: "b2@x.co", phone: "+14155557001" })).json.contact;
    await t.owner("POST", "/opportunities", { contactId: c.id, pipelineId: p.id, name: "Big", value: 50000 });
    await t.owner("PUT", `/members/${t.users[0]!.id}/permissions`, { permissions: ["crmView"] });
    const s = (await t.users[0]!.api("GET", "/dashboard/summary")).json;
    assert.equal(s.metrics.openPipeline.valueHidden, true);
    assert.equal(s.metrics.openPipeline.total, null);
    assert.ok(!JSON.stringify(s).includes("50000"));
  });
});

describe("role-aware view and customization (F5.4, F5.5)", () => {
  it("a User sees only personal figures; Owner and Admin see company-wide figures", async () => {
    const t = await app.team(2);
    await rules(t);
    await t.owner("PATCH", `/members/${t.ownerId}/availability`, { availability: "offline" });
    for (let i = 0; i < 4; i++) await submit(t);
    const mine = (await t.users[0]!.api("GET", "/leads?scope=mine")).json.total as number;
    const u = (await t.users[0]!.api("GET", "/dashboard/summary")).json;
    assert.equal(u.scope, "personal");
    assert.equal(u.metrics.newLeads.value, mine);
    assert.ok(mine < 4);
    assert.equal(u.metrics.availability.total, 1); // only themselves
    const o = (await t.owner("GET", "/dashboard/summary")).json;
    assert.equal(o.scope, "company");
    assert.equal(o.metrics.newLeads.value, 4);
    // an Admin is company-wide as well
    const inv = await t.owner("POST", "/members/invitations", { email: "admin-dash@example.com", baseLevel: "admin" });
    const admin = app.client();
    await admin("POST", "/auth/accept-invitation", { token: inv.json.token, name: "Admin", password: "correct-horse-battery" });
    assert.equal((await admin("GET", "/dashboard/summary")).json.scope, "company");
  });

  it("hidden figures are remembered per user and unknown widgets are rejected", async () => {
    const t = await app.team(1);
    const put = await t.users[0]!.api("PUT", "/dashboard/preferences", { hidden: ["recovery", "payments", "recovery"] });
    assert.deepEqual(put.json.hidden, ["recovery", "payments"]);
    assert.deepEqual((await t.users[0]!.api("GET", "/dashboard/summary")).json.hidden, ["recovery", "payments"]);
    assert.deepEqual((await t.owner("GET", "/dashboard/preferences")).json.hidden, []); // other users unaffected
    assert.equal((await t.users[0]!.api("PUT", "/dashboard/preferences", { hidden: ["nonsense"] })).status, 400);
    assert.equal((await t.users[0]!.api("GET", "/dashboard/summary?tz=Mars/Base")).status, 400);
  });
});
