// Resend: the Admin setup that creates a workspace's webhook connection (I5.2, I5.3), the central status page (I5.1, I5.4),
// and the behaviour of the inbound webhook once connected: a lead only for a NEW sender, misaddressed or self-sent mail
// ignored (not retried forever), HTML turned into text, per-workspace isolation. The real adapter runs; only Resend's
// SDK client underneath it is replaced by a fake (no network).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ResendSdkClient } from "../../integrations/resend/resend-email-adapter.ts";
import { resendSettingsRouter } from "../src/integrations/resend-settings.ts";
import { resendWebhookRouter } from "../src/integrations/resend.ts";
import { integrationsStatusRouter } from "../src/integrations/status.ts";
import { startApp, type Team, type TestApp } from "./helpers.ts";

const inbox = new Map<string, Record<string, unknown>>();
let signature: "valid" | "invalid" = "valid";
const keysSeen: string[] = [];
const fakeClient = (apiKey: string): ResendSdkClient => {
  keysSeen.push(apiKey);
  return {
    emails: { send: async () => ({ data: { id: "re_x" }, error: null }), receiving: { get: async (id: string) => ({ error: null, data: inbox.get(id) }) } },
    webhooks: { verify: ({ payload }: { payload: string }) => { if (signature === "invalid") throw new Error("bad signature"); return JSON.parse(payload); } },
  } as unknown as ResendSdkClient;
};

let app: TestApp;
before(async () => {
  app = await startApp({
    integrations: {
      secretsKey: Buffer.alloc(32, 6), publicBaseUrl: "https://api.test", frontendUrl: "https://app.test",
      mount: (e, ctx) => {
        e.use("/api/v1/webhooks/resend", resendWebhookRouter(ctx, fakeClient));
        e.use("/api/v1", resendSettingsRouter(ctx));
        e.use("/api/v1", integrationsStatusRouter(ctx));
      },
    },
  });
});
after(() => app.close());
beforeEach(() => { inbox.clear(); signature = "valid"; keysSeen.length = 0; delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM_EMAIL; });

let n = 0;
function mail(over: Record<string, unknown> = {}) {
  const id = `re_${++n}`;
  inbox.set(id, { id, message_id: `<${id}@mail>`, from: "Riley Example <riley@example.com>", to: ["inbound@example.test"], cc: [], bcc: [], received_for: ["inbound@example.test"], subject: "Interested in pricing", text: "Please contact me.", html: null, created_at: "2026-10-18T08:00:00.000Z", attachments: [], ...over });
  return id;
}
async function send(key: string, emailId: string, svixId = `evt_${++n}`) {
  const e = inbox.get(emailId)!;
  const res = await fetch(`${app.base}/webhooks/resend/${key}`, { method: "POST", headers: { "content-type": "application/json", "svix-id": svixId, "svix-timestamp": "1792310400", "svix-signature": "v1,x" }, body: JSON.stringify({ type: "email.received", created_at: "2026-10-18T08:00:00.000Z", data: { email_id: emailId, message_id: e.message_id, from: e.from, to: e.to, cc: [], bcc: [], received_for: e.received_for, subject: e.subject, created_at: e.created_at } }) });
  return { status: res.status, json: (await res.json()) as any };
}
async function connected(body: Record<string, unknown> = {}) {
  const t = await app.team(1);
  await t.owner("PUT", "/settings/lead-routing", { ackWindowSeconds: 600, maxOpenLeads: 8, escalationLevels: 3, idleSeconds: 86400, levelWindowSeconds: [], backupUserId: null, managerUserId: t.ownerId });
  const r = await t.owner("PUT", "/integrations/resend", { apiKey: "re_test_key_1234", webhookSecret: "whsec_secret_5678", inboundAddress: "inbound@example.test", fromEmail: "sales@example.test", ...body });
  assert.equal(r.status, 201, r.text);
  return { t, key: String(r.json.webhookUrl).split("/").pop()!, setup: r.json };
}
const counts = (t: Team) => ({
  contacts: (app.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE workspace_id = ?").get(t.workspaceId) as any).n as number,
  conversations: (app.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE workspace_id = ?").get(t.workspaceId) as any).n as number,
  messages: (app.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ?").get(t.workspaceId) as any).n as number,
  leads: (app.db.prepare("SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ?").get(t.workspaceId) as any).n as number,
});

describe("workspace setup (Admin only, secrets never shown)", () => {
  it("creates the connection and its webhook URL, masks and encrypts the secrets, audits without them, and keeps the URL on update", async () => {
    const { t, setup, key } = await connected();
    assert.match(setup.webhookUrl, /^https:\/\/api\.test\/api\/v1\/webhooks\/resend\/[\w-]{20,}$/);
    assert.equal(setup.signingSecret, "••••5678");
    assert.equal(setup.apiKey, "••••1234");
    assert.equal(setup.inboundAddress, "inbound@example.test");
    assert.equal(setup.status, "connected");
    assert.ok(!JSON.stringify(setup).includes("whsec_secret_5678") && !JSON.stringify(setup).includes("re_test_key_1234"));
    const stored = app.db.prepare("SELECT secrets_enc FROM integration_connections WHERE workspace_id = ? AND provider = 'resend'").get(t.workspaceId) as any;
    assert.ok(!stored.secrets_enc.includes("whsec_") && !stored.secrets_enc.includes("re_test"));
    const again = await t.owner("PUT", "/integrations/resend", { webhookSecret: "whsec_rotated_9999" }); // key omitted: the saved one is kept
    assert.equal(again.status, 200);
    assert.equal(String(again.json.webhookUrl).split("/").pop(), key);
    assert.equal(again.json.apiKey, "••••1234");
    assert.equal(again.json.signingSecret, "••••9999");
    assert.equal((await t.owner("GET", "/integrations/resend")).json.signingSecret, "••••9999");
    const audit = (await t.owner("GET", "/audit-events?eventType=integration")).json.items;
    assert.equal(audit.length, 2);
    assert.ok(!JSON.stringify(audit).includes("whsec_") && !JSON.stringify(audit).includes("re_test"));
  });

  it("is limited to people who may manage integrations, validates input, and can be removed", async () => {
    const { t, key } = await connected();
    assert.equal((await t.users[0]!.api("GET", "/integrations/resend")).status, 403);
    assert.equal((await t.users[0]!.api("PUT", "/integrations/resend", { webhookSecret: "whsec_other_secret" })).status, 403);
    assert.equal((await t.users[0]!.api("GET", "/integrations")).status, 403);
    assert.equal((await t.owner("PUT", "/integrations/resend", { webhookSecret: "short" })).status, 400);
    assert.equal((await t.owner("PUT", "/integrations/resend", { webhookSecret: "whsec_secret_5678", inboundAddress: "not-an-email" })).status, 400);
    const fresh = await app.team(0); // no saved key and none on the server: refused with an explanation
    const refused = await fresh.owner("PUT", "/integrations/resend", { webhookSecret: "whsec_secret_5678" });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error.message, /API key/);
    process.env.RESEND_API_KEY = "re_server_wide_key";
    assert.equal((await fresh.owner("PUT", "/integrations/resend", { webhookSecret: "whsec_secret_5678" })).status, 201); // the server-wide key is enough
    assert.equal((await t.owner("DELETE", "/integrations/resend")).status, 204);
    assert.equal((await send(key, mail())).status, 404); // the old URL stops working
    assert.equal((await t.owner("GET", "/integrations/resend")).json.status, "not_connected");
    assert.equal((await t.owner("DELETE", "/integrations/resend")).status, 404);
  });
});

describe("receiving mail through a connection made from the setup screen", () => {
  it("a new sender becomes a contact, an email conversation, a message and a lead; a repeat by the same sender adds no second lead", async () => {
    const { t, key } = await connected();
    const first = await send(key, mail());
    assert.equal(first.status, 200);
    assert.equal(first.json.kind, "processed");
    assert.deepEqual(counts(t), { contacts: 1, conversations: 1, messages: 1, leads: 1 });
    const reply = await send(key, mail({ subject: "Re: Interested in pricing", text: "One more question." }));
    assert.equal(reply.status, 200);
    assert.deepEqual(counts(t), { contacts: 1, conversations: 1, messages: 2, leads: 1 }); // joins the conversation, no extra lead
    const lead = (app.db.prepare("SELECT source, owner_id FROM leads WHERE workspace_id = ?").get(t.workspaceId) as any);
    assert.equal(lead.source, "message");
    assert.ok(lead.owner_id); // exactly one accountable owner
    const view = (await t.owner("GET", `/contacts?search=riley`)).json.items[0];
    assert.equal(view.name, "Riley Example");
    assert.equal(view.email, "riley@example.com");
  });

  it("the same webhook delivered twice is reported as a duplicate and adds nothing", async () => {
    const { t, key } = await connected();
    const id = mail();
    assert.equal((await send(key, id, "evt_same")).json.kind, "processed");
    assert.equal((await send(key, id, "evt_same")).json.kind, "duplicate");
    assert.deepEqual(counts(t), { contacts: 1, conversations: 1, messages: 1, leads: 1 });
    assert.ok((await t.owner("GET", "/integrations/events?result=duplicate")).json.total >= 1);
  });

  it("a forged signature is rejected with 401 and nothing is created", async () => {
    const { t, key } = await connected();
    signature = "invalid";
    const res = await send(key, mail());
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, "INVALID_SIGNATURE");
    assert.deepEqual(counts(t), { contacts: 0, conversations: 0, messages: 0, leads: 0 });
  });

  it("mail for another inbox, or sent from our own address, is recorded and ignored with 200 so the provider stops retrying", async () => {
    const { t, key } = await connected();
    const wrong = await send(key, mail({ to: ["someone-else@example.test"], received_for: ["someone-else@example.test"] }));
    assert.equal(wrong.status, 200);
    const own = await send(key, mail({ from: "Sales <sales@example.test>" }));
    assert.equal(own.status, 200);
    assert.deepEqual(counts(t), { contacts: 0, conversations: 0, messages: 0, leads: 0 });
    const rejected = (await t.owner("GET", "/integrations/events?provider=resend&result=rejected")).json;
    assert.equal(rejected.total, 2);
    assert.match(rejected.items.map((e: any) => e.detail).join(" | "), /Not addressed to this workspace's inbox/);
    assert.match(rejected.items.map((e: any) => e.detail).join(" | "), /own address/);
  });

  it("HTML-only mail is stored as plain text and never as markup", async () => {
    const { t, key } = await connected();
    await send(key, mail({ text: null, html: "<p>Hello <b>team</b></p><script>alert(1)</script><p>Call me &amp; thanks</p>", subject: "" }));
    const body = (app.db.prepare("SELECT body FROM messages WHERE workspace_id = ?").get(t.workspaceId) as any).body as string;
    assert.equal(body, "Hello team\nCall me & thanks");
  });

  it("each workspace has its own URL and secret: a key only reaches its own workspace", async () => {
    const a = await connected();
    const b = await connected({ inboundAddress: "inbound@example.test" });
    assert.notEqual(a.key, b.key);
    await send(a.key, mail());
    assert.equal(counts(a.t).messages, 1);
    assert.equal(counts(b.t).messages, 0);
    assert.equal((await send("not-a-real-key", mail())).status, 404);
  });

  it("falls back to the server-wide API key when the workspace did not store its own", async () => {
    process.env.RESEND_API_KEY = "re_server_wide_key";
    const t = await app.team(0);
    const r = await t.owner("PUT", "/integrations/resend", { webhookSecret: "whsec_secret_5678" });
    const key = String(r.json.webhookUrl).split("/").pop()!;
    assert.equal(r.json.apiKey, "from the server environment");
    assert.equal((await send(key, mail())).status, 200);
    assert.deepEqual(keysSeen, ["re_server_wide_key"]);
  });
});

describe("central status page and synchronisation history (I5.1, I5.4, I5.6)", () => {
  it("lists each integration with its status, last success, recent errors and what it can and cannot do", async () => {
    const { t, key } = await connected();
    await send(key, mail());
    signature = "invalid";
    await send(key, mail()); // a rejected attempt shows up as an error
    signature = "valid";
    const items = (await t.owner("GET", "/integrations")).json.items as any[];
    assert.deepEqual(items.map((i) => i.id), ["email-inbound", "calendar", "notifications"]);
    const email = items.find((i) => i.id === "email-inbound");
    assert.equal(email.status, "connected");
    assert.equal(email.details.inboundAddress, "inbound@example.test");
    assert.ok(email.lastSuccessAt);
    assert.match(email.limits, /Attachment contents are not downloaded/);
    assert.equal(items.find((i) => i.id === "calendar").status, "not_connected");
    const events = (await t.owner("GET", "/integrations/events?provider=resend&pageSize=5")).json;
    assert.ok(events.total >= 2);
    assert.ok(events.items.every((e: any) => e.provider === "resend" && e.at && e.result));
  });
});
