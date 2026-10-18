// Resend inbound webhook: workspace from the key, signature required, durable de-duplication, and the CRM effects
// of a received email (contact by sender, email conversation, lead for an unknown sender).
// Most tests replace the adapter with a labelled stand-in that follows its contract (verify -> de-duplicate -> call
// the handlers); the last suite runs the REAL adapter with real Svix signatures when integrations/resend is present.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createEventDeduplicator, createInboundHandlers, htmlToText, parseAddress, resendSettingsRouter, resendWebhookRouter,
  type IncomingEmail, type ResendPortFactory, type ResendWebhookPort,
} from "../src/integrations/resend.ts";
import { integrationsStatusRouter } from "../src/integrations/status.ts";
import { startApp, type Team, type TestApp } from "./helpers.ts";

let app: TestApp;
let behaviour: { failNext: boolean; unconfigured: boolean } = { failNext: false, unconfigured: false };

// Stand-in for ResendEmailAdapter.handleWebhook (the real one is tested at the bottom).
const standIn: ResendPortFactory = async (ctx, conn) => {
  if (behaviour.unconfigured) return null;
  const dedup = createEventDeduplicator(ctx.db, conn.workspace_id);
  const handlers = createInboundHandlers(ctx, conn);
  const port: ResendWebhookPort = {
    async handleWebhook(raw, headers) {
      if (headers["svix-signature"] !== "v1,valid") { const e = new Error("bad signature"); e.name = "ResendWebhookAuthenticationError"; throw e; }
      const event = JSON.parse(raw);
      const id = headers["svix-id"]!;
      if (event.type !== "email.received") return { kind: "ignored", providerEventId: id };
      const email: IncomingEmail = { providerEmailId: event.data.email_id, providerMessageId: event.data.message_id, from: event.data.from, to: event.data.to ?? [], receivedFor: event.data.received_for ?? event.data.to ?? [], subject: event.data.subject ?? "", text: event.data.text ?? null, html: event.data.html ?? null, receivedAt: new Date(event.data.created_at) };
      const processed = await dedup.processOnce(id, async () => {
        if (behaviour.failNext) { behaviour.failNext = false; throw new Error("database unavailable"); }
        await handlers.onIncomingEmail(email);
      });
      return { kind: processed ? "processed" : "duplicate", providerEventId: id };
    },
  };
  return port;
};

before(async () => {
  app = await startApp({
    integrations: {
      publicBaseUrl: "https://hooks.example", secretsKey: Buffer.alloc(32, 5),
      mount: (expressApp, ctx) => {
        expressApp.use("/api/v1/webhooks/resend", resendWebhookRouter(ctx, standIn));
        expressApp.use("/api/v1", resendSettingsRouter(ctx));
        expressApp.use("/api/v1", integrationsStatusRouter(ctx));
      },
    },
  });
});
after(() => app.close());

let n = 0;
function payload(over: Record<string, unknown> = {}, id = `em_${++n}`) {
  return { type: "email.received", created_at: new Date().toISOString(), data: { email_id: id, message_id: `<${id}@mail>`, created_at: new Date().toISOString(), from: "Maya Patel <maya@northstar.example>", to: ["inbox@hooks.example"], received_for: ["inbox@hooks.example"], subject: "Quote for rooftop solar", text: "Hi, could you send a quote?", ...over } };
}
const post = (key: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${app.base}/webhooks/resend/${key}`, { method: "POST", headers: { "content-type": "application/json", "svix-id": `msg_${++n}`, "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,valid", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function connected(extra: Record<string, unknown> = {}) {
  const t = await app.team(1);
  await t.owner("PUT", "/settings/lead-routing", { ackWindowSeconds: 600, maxOpenLeads: 8, escalationLevels: 3, idleSeconds: 86400, levelWindowSeconds: [], backupUserId: null, managerUserId: t.ownerId });
  const r = await t.owner("PUT", "/integrations/resend", { webhookSecret: "whsec_test_secret_123", ...extra });
  assert.equal(r.status, 201, r.text);
  return { t, key: String(r.json.webhookUrl).split("/").pop()!, setup: r.json };
}
const counts = (t: Team) => ({
  contacts: (app.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE workspace_id = ?").get(t.workspaceId) as any).n as number,
  messages: (app.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ?").get(t.workspaceId) as any).n as number,
  leads: (app.db.prepare("SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ?").get(t.workspaceId) as any).n as number,
  conversations: (app.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE workspace_id = ?").get(t.workspaceId) as any).n as number,
});

describe("setting up the webhook (Admin only, secrets never shown)", () => {
  it("gives the workspace a webhook URL with its own key, masks the secret, audits it, and refuses ordinary users", async () => {
    const { t, setup } = await connected({ receivingAddress: "Inbox@hooks.example" });
    assert.match(setup.webhookUrl, /^https:\/\/hooks\.example\/api\/v1\/webhooks\/resend\/[\w-]{20,}$/);
    assert.equal(setup.signingSecret, "••••_123");
    assert.equal(setup.receivingAddress, "inbox@hooks.example");
    assert.ok(!JSON.stringify(setup).includes("whsec_test_secret_123"));
    assert.equal((await t.users[0]!.api("GET", "/integrations/resend")).status, 403);
    assert.equal((await t.users[0]!.api("PUT", "/integrations/resend", { webhookSecret: "whsec_other_secret" })).status, 403);
    assert.equal((await t.owner("PUT", "/integrations/resend", { webhookSecret: "x" })).status, 400);
    const stored = app.db.prepare("SELECT secrets_enc FROM integration_connections WHERE workspace_id = ? AND provider = 'resend'").get(t.workspaceId) as any;
    assert.ok(!stored.secrets_enc.includes("whsec_test_secret_123")); // encrypted at rest
    const audit = (await t.owner("GET", "/audit-events?eventType=integration")).json.items;
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes("whsec_"));
    assert.equal((await t.owner("PUT", "/integrations/resend", { webhookSecret: "whsec_second_secret" })).status, 200); // re-saving keeps the same URL
    assert.equal(((await t.owner("GET", "/integrations/resend")).json.webhookUrl as string), setup.webhookUrl);
  });
});

describe("receiving an email (CRM effects)", () => {
  it("an unknown sender becomes a contact, an email conversation, a message and a lead (source: message)", async () => {
    const { t, key } = await connected();
    const res = await post(key, payload());
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).result, "processed");
    assert.deepEqual(counts(t), { contacts: 1, messages: 1, leads: 1, conversations: 1 });
    const contact = (await t.owner("GET", "/contacts?search=maya")).json.items[0];
    assert.equal(contact.name, "Maya Patel");
    assert.equal(contact.email, "maya@northstar.example");
    const view = (await t.owner("GET", `/contacts/${contact.id}`)).json;
    assert.equal(view.conversations[0].channel, "email");
    assert.match(view.conversations[0].messages[0].body, /Quote for rooftop solar\n\nHi, could you send a quote\?/);
    assert.equal(view.leads[0].source, "message");
    assert.ok(view.activities.some((a: any) => /Email received/.test(a.text)));
    const lead = (await t.owner("GET", "/leads?scope=all")).json.items[0];
    assert.equal(lead.source, "message");
    assert.ok(lead.ownerId); // exactly one accountable owner, as for every lead
  });

  it("a known sender is matched by address: the message joins the same conversation and no second lead is made", async () => {
    const { t, key } = await connected();
    await t.owner("POST", "/contacts", { name: "Existing Contact", email: "maya@northstar.example" });
    await post(key, payload());
    await post(key, payload({ subject: "Follow-up" }));
    assert.deepEqual(counts(t), { contacts: 1, messages: 2, leads: 0, conversations: 1 });
  });

  it("a delivery repeated by the provider (same Svix id) or re-sent under a new id does not create a second message or lead", async () => {
    const { t, key } = await connected();
    const body = payload({}, "em_dup");
    const first = await post(key, body, { "svix-id": "msg_fixed" });
    const again = await post(key, body, { "svix-id": "msg_fixed" });
    assert.equal(((await again.json()) as any).result, "duplicate");
    assert.equal(first.status, 200);
    const resent = await post(key, body, { "svix-id": "msg_other_id" }); // same email, different webhook id
    assert.equal(resent.status, 200);
    assert.deepEqual(counts(t), { contacts: 1, messages: 1, leads: 1, conversations: 1 });
    const kinds = (app.db.prepare("SELECT result FROM integration_events WHERE workspace_id = ? AND provider = 'resend' AND result = 'duplicate'").all(t.workspaceId) as any[]).length;
    assert.ok(kinds >= 1); // the repeat is visible in the synchronisation history
  });

  it("two simultaneous deliveries of the same webhook produce one effect", async () => {
    const { t, key } = await connected();
    const body = payload({}, "em_race");
    const results = await Promise.all([post(key, body, { "svix-id": "msg_race" }), post(key, body, { "svix-id": "msg_race" })]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.deepEqual(counts(t), { contacts: 1, messages: 1, leads: 1, conversations: 1 });
  });

  it("a failure while processing returns 500 and is retryable: nothing is marked processed", async () => {
    const { t, key } = await connected();
    behaviour.failNext = true;
    const body = payload({}, "em_retry");
    const failed = await post(key, body, { "svix-id": "msg_retry" });
    assert.equal(failed.status, 500);
    assert.equal(counts(t).messages, 0);
    const retried = await post(key, body, { "svix-id": "msg_retry" }); // the provider's retry, same id
    assert.equal(retried.status, 200);
    assert.equal(((await retried.json()) as any).result, "processed");
    assert.equal(counts(t).messages, 1);
  });

  it("HTML-only mail is converted to plain text and script content is stored inert", async () => {
    const { t, key } = await connected();
    await post(key, payload({ text: null, html: "<p>Hello <b>team</b></p><script>alert(1)</script><p>Call me &amp; thanks</p>", subject: "" }));
    const body = (app.db.prepare("SELECT body FROM messages WHERE workspace_id = ?").get(t.workspaceId) as any).body as string;
    assert.equal(body, "Hello team\nCall me & thanks");
    assert.ok(!/script/i.test(body));
    assert.equal(htmlToText("<style>p{}</style>x<br>y"), "x\ny");
    assert.deepEqual(parseAddress('"Doe, Jane" <JANE@Example.com>'), { email: "jane@example.com", name: "Doe, Jane" });
    assert.deepEqual(parseAddress("plain@example.com"), { email: "plain@example.com", name: null });
  });

  it("mail not addressed to the workspace's configured inbox, or sent from our own address, is recorded and ignored", async () => {
    const { t, key } = await connected({ receivingAddress: "inbox@hooks.example" });
    await post(key, payload({ to: ["someone-else@hooks.example"], received_for: ["someone-else@hooks.example"] }));
    process.env.RESEND_FROM_EMAIL = "alerts@hooks.example";
    try { await post(key, payload({ from: "Alerts <alerts@hooks.example>" })); } finally { delete process.env.RESEND_FROM_EMAIL; }
    assert.deepEqual(counts(t), { contacts: 0, messages: 0, leads: 0, conversations: 0 });
    const events = app.db.prepare("SELECT result, detail FROM integration_events WHERE workspace_id = ? AND result = 'rejected'").all(t.workspaceId) as any[];
    assert.equal(events.length, 2);
    assert.match(events.map((e) => e.detail).join(" | "), /Not addressed to this workspace's inbox/);
  });
});

describe("authenticity and isolation", () => {
  it("a forged or unsigned request is rejected with 401, recorded, and changes nothing", async () => {
    const { t, key } = await connected();
    const forged = await post(key, payload(), { "svix-signature": "v1,forged" });
    assert.equal(forged.status, 401);
    assert.equal(((await forged.json()) as any).error.code, "INVALID_SIGNATURE");
    const unsigned = await post(key, payload(), { "svix-signature": "" });
    assert.equal(unsigned.status, 401);
    assert.deepEqual(counts(t), { contacts: 0, messages: 0, leads: 0, conversations: 0 });
    const rejected = app.db.prepare("SELECT COUNT(*) AS n FROM integration_events WHERE workspace_id = ? AND result = 'rejected'").get(t.workspaceId) as any;
    assert.equal(rejected.n, 2);
    const shown = (await t.owner("GET", "/integrations/events?result=rejected")).json;
    assert.equal(shown.total, 2); // Admins can see the rejected attempts
  });

  it("an unknown key is 404; a key only ever reaches its own workspace", async () => {
    const a = await connected();
    const b = await connected();
    assert.equal((await post("not-a-real-key", payload())).status, 404);
    await post(a.key, payload({}, "em_iso"));
    assert.equal(counts(a.t).messages, 1);
    assert.equal(counts(b.t).messages, 0);
    assert.equal((await b.t.owner("GET", "/integrations/events")).json.items.every((e: any) => e.type !== "email.received"), true);
  });

  it("with the provider not configured on the server it answers 503 so the provider retries, and says so in the history", async () => {
    const { t, key } = await connected();
    behaviour.unconfigured = true;
    try {
      const res = await post(key, payload());
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as any).error.code, "INTEGRATION_NOT_CONFIGURED");
    } finally { behaviour.unconfigured = false; }
    const status = (await t.owner("GET", "/integrations")).json.items.find((i: any) => i.id === "email-inbound");
    assert.equal(status.status, "connected");
    assert.ok(status.recentErrors.some((e: any) => /not configured on the server/.test(e.detail)));
    assert.match(status.limits, /Receives mail/);
  });
});

// ---- The real adapter with real Svix signatures (needs integrations/resend from feature/integrations + npm install) ----
const adapterUrl = new URL("../../integrations/resend/", import.meta.url);
const adapterDir = fileURLToPath(adapterUrl);
const haveAdapter = existsSync(`${adapterDir}resend-email-adapter.ts`) && existsSync(`${adapterDir}node_modules`);
const SECRET_BYTES = Buffer.from("integration-test-secret-bytes!!");
const SIGNING_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const sign = (id: string, ts: string, body: string) => `v1,${createHmac("sha256", SECRET_BYTES).update(`${id}.${ts}.${body}`).digest("base64")}`;

describe("with the real Resend adapter", { skip: haveAdapter ? false : "integrations/resend not merged or not installed" }, () => {
  it("verifies real Svix signatures, fetches the body, de-duplicates and creates the contact and lead", async () => {
    const { email } = await import("../src/integrations/adapters.ts").then((m) => m.loadResendModules());
    const received: Record<string, any> = {};
    const factory: ResendPortFactory = async (ctx, conn) => {
      const adapter = email.createResendEmailAdapter({ apiKey: "re_test_key", webhookSecret: SIGNING_SECRET, defaultFrom: "alerts@hooks.example", eventDeduplicator: createEventDeduplicator(ctx.db, conn.workspace_id), handlers: createInboundHandlers(ctx, conn) });
      // Only the provider's body-retrieval call is stubbed; signature verification is the SDK's real one.
      (adapter as any).client.emails.receiving.get = async (id: string) => ({ error: null, data: received[id] });
      return adapter as ResendWebhookPort;
    };
    const real = await startApp({ integrations: { publicBaseUrl: "https://hooks.example", secretsKey: Buffer.alloc(32, 5), mount: (e, ctx) => { e.use("/api/v1/webhooks/resend", resendWebhookRouter(ctx, factory)); e.use("/api/v1", resendSettingsRouter(ctx)); e.use("/api/v1", integrationsStatusRouter(ctx)); } } });
    try {
      const t = await real.team(1);
      await t.owner("PUT", "/settings/lead-routing", { ackWindowSeconds: 600, maxOpenLeads: 8, escalationLevels: 3, idleSeconds: 86400, levelWindowSeconds: [], backupUserId: null, managerUserId: t.ownerId });
      const key = String((await t.owner("PUT", "/integrations/resend", { webhookSecret: SIGNING_SECRET })).json.webhookUrl).split("/").pop()!;
      const emailId = "re_email_1";
      received[emailId] = { id: emailId, message_id: "<abc@mail>", from: "Jonas Weber <jonas@weber.example>", to: ["inbox@hooks.example"], cc: [], bcc: [], received_for: ["inbox@hooks.example"], subject: "Roof inspection", text: "Can you inspect on Friday?", html: null, created_at: new Date().toISOString(), attachments: [] };
      const body = JSON.stringify({ type: "email.received", created_at: new Date().toISOString(), data: { email_id: emailId, message_id: "<abc@mail>", created_at: new Date().toISOString(), from: received[emailId].from, to: ["inbox@hooks.example"], received_for: ["inbox@hooks.example"], subject: "Roof inspection", attachments: [] } });
      const send = (sig: string, id = "msg_real_1", ts = String(Math.floor(Date.now() / 1000))) => fetch(`${real.base}/webhooks/resend/${key}`, { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": sig }, body });
      const ts = String(Math.floor(Date.now() / 1000));
      assert.equal((await send("v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "msg_real_1", ts)).status, 401); // forged
      assert.equal((await send(sign("msg_real_1", ts, body + " "), "msg_real_1", ts)).status, 401); // signed for a different body
      assert.equal((await send(sign("msg_real_1", ts, body), "msg_real_1", ts)).status, 200); // genuine
      assert.equal((await send(sign("msg_real_1", ts, body), "msg_real_1", ts)).status, 200); // replay
      const contact = (await t.owner("GET", "/contacts?search=jonas")).json;
      assert.equal(contact.total, 1);
      const view = (await t.owner("GET", `/contacts/${contact.items[0].id}`)).json;
      assert.equal(view.conversations[0].messages.length, 1);
      assert.match(view.conversations[0].messages[0].body, /Roof inspection\n\nCan you inspect on Friday\?/);
      assert.equal(view.leads.length, 1);
      assert.equal((await t.owner("GET", "/integrations/events?result=rejected")).json.total, 2);
    } finally { real.close(); }
  });
});
