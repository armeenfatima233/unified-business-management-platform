// I4 / F3.9: an actual escalation produces an outside alert, with the right content and link, to the right
// person, with failures recorded and retryable. The email provider boundary is replaced by a clearly labelled
// stub (EscalationAlertSender); the real adapter is exercised in resend-alert.integration.test.ts when present.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFailureRecorder, createRecipientResolver, dispatchAlerts, type EscalationAlertInput, type EscalationAlertSender,
} from "../src/integrations/alerts.ts";
import type { IntegrationContext } from "../src/integrations/core.ts";
import { runLeadTick } from "../src/leads/worker.ts";
import { startApp, type Team, type TestApp } from "./helpers.ts";

let app: TestApp;
let ctx: IntegrationContext;
before(async () => {
  app = await startApp();
  ctx = { db: app.db, fetch: globalThis.fetch as never, secretsKey: Buffer.alloc(32, 1), publicBaseUrl: "https://hooks.example", frontendUrl: "https://app.example" };
});
after(() => app.close());

const rules = (t: Team) => t.owner("PUT", "/settings/lead-routing", { ackWindowSeconds: 600, maxOpenLeads: 8, escalationLevels: 3, idleSeconds: 86400, levelWindowSeconds: [], backupUserId: null, managerUserId: t.ownerId });
let phone = 5553000;
const submit = (t: Team) => app.client()("POST", `/public/leads/${t.publicKey}`, { name: "Maya Patel", phone: `+1415${phone++}`, message: "Interested" });
const expire = (leadId: string) => app.db.prepare("UPDATE leads SET deadline_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), leadId);
const lastLead = async (t: Team) => ((await t.owner("GET", "/leads?scope=all")).json.items as any[])[0];

// Stub of the provider boundary: records what the core asked it to send.
function stubSender(behaviour: "ok" | "fail" = "ok") {
  const sent: EscalationAlertInput[] = [];
  const sender: EscalationAlertSender = {
    async sendEscalationAlert(alert) {
      sent.push(alert);
      if (behaviour === "fail") { const e = new Error("x") as Error & { attempts: number; providerErrorName: string }; e.name = "EscalationAlertDeliveryError"; e.attempts = 3; e.providerErrorName = "rate_limit_exceeded"; throw e; }
      return { providerEmailId: `email_${sent.length}`, attempts: 1 };
    },
  };
  return { sender, sent };
}

async function escalated(users = 2) {
  const t = await app.team(users);
  await rules(t);
  await submit(t);
  const lead = await lastLead(t);
  expire(lead.id);
  assert.equal(runLeadTick(app.db, Date.now(), t.workspaceId), 1);
  const now = (await t.owner("GET", `/leads/${lead.id}`)).json;
  return { t, lead, now };
}

describe("an escalation triggers an outside alert (F3.9, I4.1, I4.2)", () => {
  it("queues one alert for the new owner in the escalation transaction, and the dispatcher sends it with full context", async () => {
    const { t, lead, now } = await escalated();
    const rows = app.db.prepare("SELECT id, user_id, status, channel, reason FROM delivery_attempts WHERE lead_id = ?").all(lead.id) as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, now.ownerId);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].channel, "email");

    const { sender, sent } = stubSender();
    assert.equal(await dispatchAlerts(ctx, async () => sender), 1);
    assert.equal(sent.length, 1);
    const alert = sent[0]!;
    assert.equal(alert.alertId, rows[0].id);
    assert.equal(alert.workspaceId, t.workspaceId);
    assert.equal(alert.employeeId, now.ownerId);
    assert.equal(alert.leadId, lead.id);
    assert.equal(alert.leadName, "Maya Patel");
    assert.equal(alert.leadSource, "Web form");
    assert.match(alert.reason, /Not acknowledged within 600 seconds by /);
    assert.equal(alert.directLink, `https://app.example/?lead=${lead.id}`); // absolute https link that opens the lead
    const after = app.db.prepare("SELECT status, attempts, last_error FROM delivery_attempts WHERE id = ?").get(rows[0].id) as any;
    assert.deepEqual({ ...after }, { status: "sent", attempts: 1, last_error: null });
    assert.equal(await dispatchAlerts(ctx, async () => sender), 0); // nothing left to send: an alert goes out once
    assert.equal(sent.length, 1);
  });

  it("alerts the person who actually received the lead after each escalation, not the previous owner", async () => {
    const t = await app.team(3);
    await rules(t);
    await submit(t);
    const lead = await lastLead(t);
    const { sender, sent } = stubSender();
    const owners: string[] = [];
    for (let i = 0; i < 2; i++) { expire(lead.id); runLeadTick(app.db, Date.now(), t.workspaceId); owners.push((await t.owner("GET", `/leads/${lead.id}`)).json.ownerId); await dispatchAlerts(ctx, async () => sender); }
    assert.deepEqual(sent.map((s) => s.employeeId), owners);
    assert.notEqual(owners[0], owners[1]);
  });

  it("a person who goes On leave triggers an alert for whoever inherits their lead", async () => {
    const t = await app.team(2);
    await rules(t);
    await t.owner("PATCH", `/members/${t.ownerId}/availability`, { availability: "busy" });
    await t.owner("PATCH", `/members/${t.users[1]!.id}/availability`, { availability: "busy" });
    await submit(t); // goes to users[0]
    await t.owner("PATCH", `/members/${t.users[1]!.id}/availability`, { availability: "available" });
    await t.users[0]!.api("PATCH", "/members/me/availability", { availability: "on_leave" });
    const { sender, sent } = stubSender();
    await dispatchAlerts(ctx, async () => sender);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.employeeId, t.users[1]!.id);
    assert.match(sent[0]!.reason, /is now on leave/);
  });
});

describe("recipient resolution (I4.3)", () => {
  it("uses the address the employee configured, falls back to their account email, and ignores removed members", async () => {
    const t = await app.team(1);
    const resolver = createRecipientResolver(app.db);
    const u = t.users[0]!;
    assert.deepEqual(await resolver.resolveRecipient(t.workspaceId, u.id), { email: u.email }); // account email by default
    const view = await u.api("GET", "/me/notification-destination");
    assert.equal(view.json.usingAccountEmail, true);
    assert.equal((await u.api("PUT", "/me/notification-destination", { email: "not-an-email" })).status, 400);
    assert.equal((await u.api("PUT", "/me/notification-destination", { email: "Alerts@Example.com" })).status, 200);
    assert.deepEqual(await resolver.resolveRecipient(t.workspaceId, u.id), { email: "alerts@example.com" });
    assert.equal(await resolver.resolveRecipient("some-other-workspace", u.id), null); // scoped to the workspace
    assert.equal((await u.api("DELETE", "/me/notification-destination")).status, 204);
    assert.deepEqual(await resolver.resolveRecipient(t.workspaceId, u.id), { email: u.email });
    await t.owner("DELETE", `/members/${u.id}`);
    assert.equal(await resolver.resolveRecipient(t.workspaceId, u.id), null);
  });
});

describe("failures are recorded, visible to Admins, and retryable (I4.4, I5.4, I5.8)", () => {
  it("a delivery failure leaves a failed alert with a plain reason; an Admin sees it and can retry it", async () => {
    const { t, lead } = await escalated();
    const failing = stubSender("fail");
    await dispatchAlerts(ctx, async () => failing.sender);
    const row = app.db.prepare("SELECT id, status, attempts, last_error FROM delivery_attempts WHERE lead_id = ?").get(lead.id) as any;
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 3);
    assert.match(row.last_error, /after 3 attempts \(rate_limit_exceeded\)/);

    const list = await t.owner("GET", "/notifications/alerts?status=failed");
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 1);
    assert.equal(list.json.items[0].lead, "Maya Patel");
    assert.equal(list.json.items[0].status, "failed");
    assert.equal((await t.users[0]!.api("GET", "/notifications/alerts")).status, 403); // Admins/managers of integrations only
    assert.equal((await t.users[0]!.api("POST", `/notifications/alerts/${row.id}/retry`)).status, 403);

    const ok = stubSender();
    assert.equal((await t.owner("POST", `/notifications/alerts/${row.id}/retry`)).status, 200);
    await dispatchAlerts(ctx, async () => ok.sender);
    assert.equal(ok.sent.length, 1);
    assert.equal((app.db.prepare("SELECT status FROM delivery_attempts WHERE id = ?").get(row.id) as any).status, "sent");
    assert.equal((await t.owner("POST", `/notifications/alerts/${row.id}/retry`)).status, 409); // sent alerts are not retried
    assert.ok((await t.owner("GET", "/audit-events?eventType=notification.retried")).json.items.length === 1);
  });

  it("failures reported by the adapter are persisted by the failure recorder (attempt history)", async () => {
    const { t, lead } = await escalated();
    const alert = app.db.prepare("SELECT id, user_id FROM delivery_attempts WHERE lead_id = ?").get(lead.id) as any;
    const recorder = createFailureRecorder(app.db);
    await recorder.recordFailure({ alertId: alert.id, workspaceId: t.workspaceId, employeeId: alert.user_id, leadId: lead.id, attempt: 1, occurredAt: new Date(), errorName: "ResendTransportError", providerStatusCode: null, retryable: true, finalAttempt: false });
    await recorder.recordFailure({ alertId: alert.id, workspaceId: t.workspaceId, employeeId: alert.user_id, leadId: lead.id, attempt: 2, occurredAt: new Date(), errorName: "ResendApiError", providerStatusCode: 503, retryable: true, finalAttempt: false });
    const events = app.db.prepare("SELECT result, detail FROM integration_events WHERE external_id = ? ORDER BY created_at, rowid").all(alert.id) as any[];
    assert.equal(events.length, 2);
    assert.match(events[1].detail, /Attempt 2 failed \(ResendApiError, HTTP 503\); will retry/);
    assert.equal((app.db.prepare("SELECT attempts FROM delivery_attempts WHERE id = ?").get(alert.id) as any).attempts, 2);
    const shown = (await t.owner("GET", "/notifications/alerts")).json.items[0];
    assert.equal(shown.history.length, 2); // the attempt history is part of what Admins see
  });

  it("with no email provider configured the alert is failed with an explanation instead of silently dropped", async () => {
    const { t, lead } = await escalated();
    await dispatchAlerts(ctx, async () => null);
    const row = app.db.prepare("SELECT status, last_error FROM delivery_attempts WHERE lead_id = ?").get(lead.id) as any;
    assert.equal(row.status, "failed");
    assert.match(row.last_error, /not configured on the server/);
    assert.equal((await t.owner("GET", "/notifications/alerts?status=failed")).json.total, 1);
  });

  it("a non-https FRONTEND_URL fails the alert with a fixable message (the adapter requires an https link)", async () => {
    const { lead } = await escalated();
    const strict: EscalationAlertSender = { async sendEscalationAlert() { throw new TypeError("Escalation alert link must be an absolute HTTPS URL"); } };
    await dispatchAlerts(ctx, async () => strict);
    const row = app.db.prepare("SELECT status, last_error FROM delivery_attempts WHERE lead_id = ?").get(lead.id) as any;
    assert.equal(row.status, "failed");
    assert.match(row.last_error, /Set FRONTEND_URL to the public https address/);
  });

  it("an alert for another workspace is invisible and cannot be retried across workspaces", async () => {
    const a = await escalated();
    const b = await app.team(0);
    const alert = app.db.prepare("SELECT id FROM delivery_attempts WHERE lead_id = ?").get(a.lead.id) as any;
    await dispatchAlerts(ctx, async () => null);
    assert.equal((await b.owner("GET", "/notifications/alerts")).json.total, 0);
    assert.equal((await b.owner("POST", `/notifications/alerts/${alert.id}/retry`)).status, 404);
  });
});

// Runs only when the Resend adapter (integrations/resend, from feature/integrations) is present: the REAL
// ResendEscalationAlertAdapter, with only the outgoing HTTP call to Resend stubbed, against this backend's database.
const adapterUrl = new URL("../../integrations/resend/", import.meta.url);
const adapterDir = fileURLToPath(adapterUrl);
const haveAdapter = existsSync(`${adapterDir}escalation-alert-adapter.ts`) && existsSync(`${adapterDir}node_modules`);
describe("with the real Resend alert adapter", { skip: haveAdapter ? false : "integrations/resend not merged or not installed" }, () => {
  it("sends an escalation email through the adapter, retrying a transient failure with one idempotency key", async () => {
    const { ResendEscalationAlertAdapter } = await import(new URL("escalation-alert-adapter.ts", adapterUrl).href);
    const { ResendApiError } = await import(new URL("resend-email-adapter.ts", adapterUrl).href);
    const { t, lead, now } = await escalated();
    const calls: { email: any; opts: any }[] = [];
    let failFirst = true;
    const sender = { async sendEmail(email: any, opts: any) { calls.push({ email, opts }); if (failFirst) { failFirst = false; throw new ResendApiError("rate_limit_exceeded", 429); } return { providerEmailId: "re_123" }; } };
    const adapter = new ResendEscalationAlertAdapter({ sender, recipientResolver: createRecipientResolver(app.db), failureRecorder: createFailureRecorder(app.db), wait: async () => undefined });
    await dispatchAlerts(ctx, async () => adapter);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.opts.idempotencyKey, calls[1]!.opts.idempotencyKey);
    const member = app.db.prepare("SELECT email FROM users WHERE id = ?").get(now.ownerId) as any;
    assert.equal(calls[1]!.email.to, member.email);
    assert.match(calls[1]!.email.subject, /Lead escalation: Maya Patel/);
    assert.match(calls[1]!.email.text, new RegExp(`View lead: https://app.example/\\?lead=${lead.id}`));
    assert.match(calls[1]!.email.text, /Source: Web form/);
    assert.equal((app.db.prepare("SELECT status, attempts FROM delivery_attempts WHERE lead_id = ?").get(lead.id) as any).status, "sent");
    assert.equal((await t.owner("GET", "/notifications/alerts")).json.items[0].history.length >= 2, true); // the 429 and the success are both on record
  });
});
