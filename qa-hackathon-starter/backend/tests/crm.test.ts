// Tests for F2 (CRM), F1.4 (value protection), Q3/Q4 (input safety, integrity, concurrency).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startApp, type Api, type Team, type TestApp } from "./helpers.ts";

let app: TestApp;
before(async () => { app = await startApp(); });
after(() => app.close());

async function pipelineOf(t: Team, name = "Sales") {
  const list = (await t.owner("GET", "/pipelines")).json.items as any[];
  return list.find((p) => p.name === name) ?? list[0];
}
const stageId = (p: any, name: string) => p.stages.find((s: any) => s.name === name).id as string;
async function mkContact(api: Api, extra: Record<string, unknown> = {}) {
  const r = await api("POST", "/contacts", { name: "Maya Patel", email: "maya@northstar.co", phone: "+14155550187", ...extra });
  assert.equal(r.status, 201, r.text);
  return r.json.contact as any;
}
async function mkOpp(api: Api, contactId: string, pipelineId: string, extra: Record<string, unknown> = {}) {
  const r = await api("POST", "/opportunities", { contactId, pipelineId, name: "Rooftop expansion", value: 84000, ...extra });
  assert.equal(r.status, 201, r.text);
  return r.json.opportunity as any;
}

describe("relationships and customer view (F2.1, F2.7, F2.8)", () => {
  it("a contact belongs to a company, has many opportunities, and its page shows everything with history", async () => {
    const t = await app.team(1);
    const company = (await t.owner("POST", "/companies", { name: "Northstar Solar" })).json;
    const contact = await mkContact(t.owner, { companyId: company.id });
    const p = await pipelineOf(t);
    const o1 = await mkOpp(t.owner, contact.id, p.id, { name: "Deal A" });
    await mkOpp(t.owner, contact.id, p.id, { name: "Deal B", value: 500 });
    await t.owner("POST", `/contacts/${contact.id}/notes`, { text: "Asked for financing options" });
    await t.owner("POST", `/opportunities/${o1.id}/move`, { stageId: stageId(p, "Qualified") });
    const view = (await t.owner("GET", `/contacts/${contact.id}`)).json;
    assert.equal(view.contact.company.name, "Northstar Solar");
    assert.equal(view.opportunities.length, 2);
    for (const key of ["conversations", "payments", "appointments", "activities", "leads"]) assert.ok(Array.isArray(view[key]), key);
    const types = view.activities.map((a: any) => a.type);
    assert.ok(types.includes("note") && types.includes("stage_change") && types.includes("opportunity") && types.includes("created"));
    const times = view.activities.map((a: any) => a.at);
    assert.deepEqual([...times].sort().reverse(), times); // newest first, with who and when
    assert.equal(view.activities.find((a: any) => a.type === "note").actor, "Owner");
    const companyView = (await t.owner("GET", `/companies/${company.id}`)).json;
    assert.equal(companyView.contacts.length, 1);
  });

  it("cannot delete a contact or company that still has linked records (no orphans)", async () => {
    const t = await app.team(0);
    const company = (await t.owner("POST", "/companies", { name: "Acme" })).json;
    const contact = await mkContact(t.owner, { companyId: company.id });
    const p = await pipelineOf(t);
    await mkOpp(t.owner, contact.id, p.id);
    const delCompany = await t.owner("DELETE", `/companies/${company.id}`);
    assert.equal(delCompany.status, 409);
    const delContact = await t.owner("DELETE", `/contacts/${contact.id}`);
    assert.equal(delContact.status, 409);
    assert.equal(delContact.json.error.details.opportunities, 1);
    const lone = await mkContact(t.owner, { name: "Lone", email: "lone@x.co", phone: "+14155550100" });
    assert.equal((await t.owner("DELETE", `/contacts/${lone.id}`)).status, 204);
    assert.equal((await t.owner("GET", `/contacts/${lone.id}`)).status, 404);
  });
});

describe("custom fields and pipelines (F2.2-F2.5)", () => {
  it("an Admin adds the five field types from the API and they show on forms/detail immediately", async () => {
    const t = await app.team(0);
    const p = await pipelineOf(t);
    const defs: Record<string, any> = {};
    for (const [name, fieldType, options] of [["Notes", "text", []], ["Roof size", "number", []], ["Survey date", "date", []], ["Property", "dropdown", ["Residential", "Commercial"]], ["Financed", "checkbox", []]] as const) {
      const r = await t.owner("POST", "/custom-fields", { entityType: "opportunity", pipelineId: p.id, name, fieldType, options });
      assert.equal(r.status, 201, r.text);
      defs[name] = r.json;
    }
    const contact = await mkContact(t.owner);
    const opp = await mkOpp(t.owner, contact.id, p.id, { customFields: { [defs.Notes.id]: "hello", [defs["Roof size"].id]: 120.5, [defs["Survey date"].id]: "2026-11-02", [defs.Property.id]: "Commercial", [defs.Financed.id]: true } });
    const values = Object.fromEntries(opp.customFields.map((f: any) => [f.name, f.value]));
    assert.deepEqual(values, { Notes: "hello", "Roof size": 120.5, "Survey date": "2026-11-02", Property: "Commercial", Financed: true });
    // invalid values are rejected server-side
    for (const [field, value] of [["Roof size", "big"], ["Survey date", "tomorrow"], ["Property", "Castle"], ["Financed", "yes"]] as const) {
      const r = await t.owner("PATCH", `/opportunities/${opp.id}`, { version: 1, customFields: { [defs[field].id]: value } });
      assert.equal(r.status, 400, field);
    }
    assert.equal((await t.owner("PATCH", `/opportunities/${opp.id}`, { version: 1, customFields: { nonexistent: "x" } })).status, 400);
  });

  it("two pipelines show different field sets while sharing the same contact (F2.3)", async () => {
    const t = await app.team(0);
    const sales = await pipelineOf(t);
    const support = (await t.owner("POST", "/pipelines", { name: "Support" })).json;
    const f1 = (await t.owner("POST", "/custom-fields", { entityType: "opportunity", pipelineId: sales.id, name: "Roof size", fieldType: "number" })).json;
    const f2 = (await t.owner("POST", "/custom-fields", { entityType: "opportunity", pipelineId: support.id, name: "Ticket priority", fieldType: "dropdown", options: ["Low", "High"] })).json;
    const contact = await mkContact(t.owner);
    const a = await mkOpp(t.owner, contact.id, sales.id);
    const b = await mkOpp(t.owner, contact.id, support.id, { name: "Ticket" });
    assert.deepEqual(a.customFields.map((f: any) => f.name), ["Roof size"]);
    assert.deepEqual(b.customFields.map((f: any) => f.name), ["Ticket priority"]);
    // a field from the other pipeline cannot be attached
    assert.equal((await t.owner("PATCH", `/opportunities/${a.id}`, { version: 1, customFields: { [f2.id]: "High" } })).status, 400);
    assert.equal((await t.owner("GET", `/custom-fields?entity=opportunity&pipelineId=${sales.id}`)).json.items.length, 1);
    assert.ok(f1.id);
    const view = (await t.owner("GET", `/contacts/${contact.id}`)).json;
    assert.equal(view.opportunities.length, 2); // same contact, both pipelines
  });

  it("moving into a stage is blocked until its required fields are filled (F2.4)", async () => {
    const t = await app.team(0);
    const p = await pipelineOf(t);
    const field = (await t.owner("POST", "/custom-fields", { entityType: "opportunity", pipelineId: p.id, name: "Contract number", fieldType: "text" })).json;
    assert.equal((await t.owner("PUT", `/stages/${stageId(p, "Proposal")}/required-fields`, { fieldIds: [field.id] })).status, 200);
    const contact = await mkContact(t.owner);
    const opp = await mkOpp(t.owner, contact.id, p.id);
    const blocked = await t.owner("POST", `/opportunities/${opp.id}/move`, { stageId: stageId(p, "Proposal") });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.json.error.code, "REQUIRED_FIELDS_MISSING");
    assert.match(blocked.json.error.message, /Contract number/);
    assert.equal((await t.owner("GET", `/opportunities/${opp.id}`)).json.opportunity.stageId, stageId(p, "New")); // unchanged
    const ok = await t.owner("POST", `/opportunities/${opp.id}/move`, { stageId: stageId(p, "Proposal"), customFields: { [field.id]: "C-1001" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.opportunity.stageId, stageId(p, "Proposal"));
    // creating directly into the gated stage is also blocked
    const direct = await t.owner("POST", "/opportunities", { contactId: contact.id, pipelineId: p.id, stageId: stageId(p, "Proposal"), name: "X" });
    assert.equal(direct.status, 422);
  });

  it("stages can be added, renamed, reordered and deleted; deleting an occupied stage is handled safely (F2.5)", async () => {
    const t = await app.team(0);
    const p = await pipelineOf(t);
    const added = (await t.owner("POST", `/pipelines/${p.id}/stages`, { name: "Negotiation", position: 3 })).json.stages;
    assert.deepEqual(added.map((s: any) => s.name), ["New", "Qualified", "Proposal", "Negotiation", "Won", "Lost"]);
    const neg = added.find((s: any) => s.name === "Negotiation");
    await t.owner("PATCH", `/stages/${neg.id}`, { name: "Negotiating" });
    const reordered = await t.owner("PUT", `/pipelines/${p.id}/stages/order`, { stageIds: [...added.map((s: any) => s.id)].reverse() });
    assert.equal(reordered.json.stages[0].name, "Lost");
    assert.equal((await t.owner("PUT", `/pipelines/${p.id}/stages/order`, { stageIds: [neg.id] })).status, 400); // must list every stage
    const contact = await mkContact(t.owner);
    const opp = await mkOpp(t.owner, contact.id, p.id, { stageId: neg.id });
    const refused = await t.owner("DELETE", `/stages/${neg.id}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "STAGE_NOT_EMPTY");
    const moved = await t.owner("DELETE", `/stages/${neg.id}?moveTo=${stageId(p, "Qualified")}`);
    assert.equal(moved.status, 200);
    const after = (await t.owner("GET", `/opportunities/${opp.id}`)).json;
    assert.equal(after.opportunity.stageId, stageId(p, "Qualified")); // not orphaned
    assert.ok(after.activities.some((a: any) => /removed/.test(a.text)));
    assert.equal(moved.json.stages.length, 5);
  });

  it("only Owner/Admin configure the CRM; a User cannot", async () => {
    const t = await app.team(1);
    const p = await pipelineOf(t);
    const u = t.users[0]!.api;
    assert.equal((await u("POST", "/custom-fields", { entityType: "contact", name: "X", fieldType: "text" })).status, 403);
    assert.equal((await u("POST", "/pipelines", { name: "Mine" })).status, 403);
    assert.equal((await u("POST", `/pipelines/${p.id}/stages`, { name: "S" })).status, 403);
    assert.equal((await u("GET", "/pipelines")).status, 200);
  });

  it("a dropdown option in use cannot be removed; deleting a field removes its values and stage requirements", async () => {
    const t = await app.team(0);
    const p = await pipelineOf(t);
    const f = (await t.owner("POST", "/custom-fields", { entityType: "opportunity", name: "Type", fieldType: "dropdown", options: ["A", "B"] })).json;
    const contact = await mkContact(t.owner);
    await mkOpp(t.owner, contact.id, p.id, { customFields: { [f.id]: "A" } });
    assert.equal((await t.owner("PATCH", `/custom-fields/${f.id}`, { options: ["B"] })).status, 409);
    assert.equal((await t.owner("PATCH", `/custom-fields/${f.id}`, { options: ["A", "B", "C"] })).status, 200);
    await t.owner("PUT", `/stages/${stageId(p, "Proposal")}/required-fields`, { fieldIds: [f.id] });
    assert.equal((await t.owner("DELETE", `/custom-fields/${f.id}`)).status, 204);
    const stages = (await t.owner("GET", "/pipelines")).json.items[0].stages;
    assert.deepEqual(stages.find((s: any) => s.name === "Proposal").requiredFieldIds, []);
    const left = app.db.prepare("SELECT COUNT(*) AS n FROM custom_field_values WHERE field_id = ?").get(f.id) as { n: number };
    assert.equal(left.n, 0);
  });
});

describe("filters and saved lists (F2.6)", () => {
  it("combines field, tag, stage and owner criteria, saves them, and the list updates automatically", async () => {
    const t = await app.team(1);
    const p = await pipelineOf(t);
    const field = (await t.owner("POST", "/custom-fields", { entityType: "opportunity", name: "Property", fieldType: "dropdown", options: ["Residential", "Commercial"] })).json;
    const vip = await mkContact(t.owner, { name: "Vip One", email: "v1@x.co", phone: "+14155550201", tags: ["vip"] });
    const plain = await mkContact(t.owner, { name: "Plain Two", email: "p2@x.co", phone: "+14155550202", tags: [] });
    const a = await mkOpp(t.owner, vip.id, p.id, { name: "A", ownerId: t.users[0]!.id, customFields: { [field.id]: "Commercial" } });
    const b = await mkOpp(t.owner, plain.id, p.id, { name: "B", ownerId: t.users[0]!.id, customFields: { [field.id]: "Commercial" } });
    const criteria = { tag: "vip", stageId: stageId(p, "Qualified"), ownerId: t.users[0]!.id, customFields: { [field.id]: "Commercial" } };
    const saved = await t.owner("POST", "/saved-filters", { entity: "opportunity", name: "VIP commercial qualified", criteria });
    assert.equal(saved.status, 201);
    const run = async () => (await t.owner("GET", `/saved-filters/${saved.json.id}/results`)).json;
    assert.equal((await run()).total, 0);
    await t.owner("POST", `/opportunities/${a.id}/move`, { stageId: stageId(p, "Qualified") });
    await t.owner("POST", `/opportunities/${b.id}/move`, { stageId: stageId(p, "Qualified") });
    let result = await run();
    assert.deepEqual(result.items.map((o: any) => o.name), ["A"]); // B lacks the tag
    await t.owner("POST", `/opportunities/${a.id}/move`, { stageId: stageId(p, "Proposal") });
    assert.equal((await run()).total, 0); // stopped matching, list updated with no re-save
    const url = `/opportunities?stageId=${stageId(p, "Qualified")}&cf=${field.id}:Commercial&ownerId=${t.users[0]!.id}`;
    assert.equal((await t.owner("GET", url)).json.total, 1);
    assert.equal((await t.owner("GET", "/saved-filters?entity=opportunity")).json.items.length, 1);
    assert.equal((await t.owner("POST", "/saved-filters", { entity: "opportunity", name: "bad", criteria: { evil: "1" } })).status, 400);
  });

  it("supports search, pagination and a page-size cap on large lists (Q9)", async () => {
    const t = await app.team(0);
    for (let i = 0; i < 30; i++) await mkContact(t.owner, { name: `Person ${i}`, email: `p${i}@bulk.co`, phone: `+1415556${String(1000 + i)}` });
    const page1 = (await t.owner("GET", "/contacts?pageSize=10&page=1")).json;
    const page3 = (await t.owner("GET", "/contacts?pageSize=10&page=3")).json;
    assert.equal(page1.total, 30);
    assert.equal(page1.items.length, 10);
    assert.equal(page3.items.length, 10);
    assert.equal((await t.owner("GET", "/contacts?search=Person%2029")).json.total, 1);
    assert.equal((await t.owner("GET", "/contacts?pageSize=100000")).json.pageSize, 100);
    assert.equal((await t.owner("GET", "/contacts?search=%25")).json.total, 0); // LIKE wildcards are escaped
  });
});

describe("opportunity value protection (F1.4, F1.5)", () => {
  it("a user without viewOpportunityValue never sees it in lists, detail, customer view, exports or audit", async () => {
    const t = await app.team(1);
    const p = await pipelineOf(t);
    const contact = await mkContact(t.owner);
    const opp = await mkOpp(t.owner, contact.id, p.id, { value: 123456 });
    const u = t.users[0]!.api;
    await t.owner("PUT", `/members/${t.users[0]!.id}/permissions`, { permissions: ["crmView", "crmExport", "viewAuditLog"] });
    const list = (await u("GET", "/opportunities")).json.items[0];
    assert.equal(list.value, null);
    assert.equal(list.valueHidden, true);
    assert.equal((await u("GET", `/opportunities/${opp.id}`)).json.opportunity.value, null);
    assert.equal((await u("GET", `/contacts/${contact.id}`)).json.opportunities[0].value, null);
    const csv = await u("GET", "/opportunities/export.csv");
    assert.equal(csv.status, 200);
    assert.ok(!csv.text.includes("123456"));
    assert.ok(csv.text.includes("(hidden)"));
    const audit = await u("GET", "/audit-events?eventType=opportunity");
    assert.ok(!JSON.stringify(audit.json).includes("123456"));
    // the owner still sees it everywhere
    assert.equal((await t.owner("GET", "/opportunities")).json.items[0].value, 123456);
    assert.ok((await t.owner("GET", "/opportunities/export.csv")).text.includes("123456"));
    assert.ok(JSON.stringify((await t.owner("GET", "/audit-events?eventType=opportunity")).json).includes("123456"));
    // activity text never states it
    assert.ok(!JSON.stringify((await u("GET", `/contacts/${contact.id}`)).json.activities).includes("123456"));
  });

  it("an unauthorized user cannot set a value, edit, delete or export via a direct API call", async () => {
    const t = await app.team(1);
    const p = await pipelineOf(t);
    const contact = await mkContact(t.owner);
    const opp = await mkOpp(t.owner, contact.id, p.id);
    const u = t.users[0]!.api; // default User: view/create/edit, no delete/export/value
    assert.equal((await u("POST", "/opportunities", { contactId: contact.id, pipelineId: p.id, name: "N", value: 5 })).status, 403);
    assert.equal((await u("PATCH", `/opportunities/${opp.id}`, { version: 1, value: 1 })).status, 403);
    assert.equal((await u("DELETE", `/opportunities/${opp.id}`)).status, 403);
    assert.equal((await u("DELETE", `/contacts/${contact.id}`)).status, 403);
    assert.equal((await u("GET", "/contacts/export.csv")).status, 403);
    assert.equal((await u("GET", "/opportunities/export.csv")).status, 403);
    await t.owner("PUT", `/members/${t.users[0]!.id}/permissions`, { permissions: ["crmView"] });
    assert.equal((await u("POST", "/contacts", { name: "Nope" })).status, 403); // revoked create
    assert.equal((await client0()("GET", "/contacts")).status, 401);
  });

  function client0() { return app.client(); }
});

describe("workspace isolation and integrity (F1.6, Q2, Q4)", () => {
  it("guessed ids from another workspace never read or change data, and cross-tenant links are refused", async () => {
    const a = await app.team(0);
    const b = await app.team(0);
    const pa = await pipelineOf(a);
    const pb = await pipelineOf(b);
    const contact = await mkContact(a.owner);
    const opp = await mkOpp(a.owner, contact.id, pa.id);
    const company = (await a.owner("POST", "/companies", { name: "A Corp" })).json;
    const field = (await a.owner("POST", "/custom-fields", { entityType: "contact", name: "F", fieldType: "text" })).json;
    const saved = (await a.owner("POST", "/saved-filters", { entity: "contact", name: "L", criteria: {} })).json;
    for (const [method, path, body] of [
      ["GET", `/contacts/${contact.id}`], ["PATCH", `/contacts/${contact.id}`, { version: 1, name: "x" }], ["DELETE", `/contacts/${contact.id}`],
      ["POST", `/contacts/${contact.id}/notes`, { text: "hi" }], ["GET", `/opportunities/${opp.id}`], ["POST", `/opportunities/${opp.id}/move`, { stageId: stageId(pa, "Won") }],
      ["GET", `/companies/${company.id}`], ["DELETE", `/companies/${company.id}`], ["PATCH", `/custom-fields/${field.id}`, { name: "z" }],
      ["PATCH", `/stages/${stageId(pa, "Won")}`, { name: "z" }], ["POST", `/pipelines/${pa.id}/stages`, { name: "z" }], ["GET", `/saved-filters/${saved.id}/results`],
    ] as const) {
      const r = await b.owner(method, path, body);
      assert.equal(r.status, 404, `${method} ${path} -> ${r.status}`);
    }
    // attaching another workspace's records to my own
    const mine = await mkContact(b.owner, { name: "Mine", email: "m@b.co", phone: "+14155550999" });
    assert.equal((await b.owner("POST", "/opportunities", { contactId: contact.id, pipelineId: pb.id, name: "steal" })).status, 400);
    assert.equal((await b.owner("POST", "/opportunities", { contactId: mine.id, pipelineId: pa.id, name: "steal" })).status, 400);
    assert.equal((await b.owner("POST", "/contacts", { name: "C", companyId: company.id })).status, 400);
    assert.equal((await b.owner("POST", "/contacts", { name: "C", ownerId: a.ownerId })).status, 400);
    assert.equal((await b.owner("GET", "/contacts")).json.total, 1);
    assert.equal((await b.owner("GET", "/opportunities")).json.total, 0);
  });

  it("a stale edit is refused instead of silently overwriting (optimistic concurrency)", async () => {
    const t = await app.team(0);
    const contact = await mkContact(t.owner);
    const first = await t.owner("PATCH", `/contacts/${contact.id}`, { version: contact.version, name: "First edit" });
    assert.equal(first.status, 200);
    const stale = await t.owner("PATCH", `/contacts/${contact.id}`, { version: contact.version, name: "Second edit" });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "VERSION_CONFLICT");
    assert.equal((await t.owner("GET", `/contacts/${contact.id}`)).json.contact.name, "First edit");
    assert.equal((await t.owner("PATCH", `/contacts/${contact.id}`, { name: "no version" })).status, 400);
  });
});

describe("input safety (Q3)", () => {
  it("stores script content as inert text, rejects malformed input, and neutralises CSV formulas", async () => {
    const t = await app.team(0);
    const payload = "<script>alert(1)</script>";
    const contact = await mkContact(t.owner, { name: payload, email: "x@y.co", phone: "+14155550301" });
    const res = await t.owner("GET", `/contacts/${contact.id}`);
    assert.equal(res.json.contact.name, payload); // returned as JSON data, never HTML
    assert.match(res.text, /^\{/);
    assert.equal((await t.owner("POST", "/contacts", { name: "", phone: "1" })).status, 400);
    assert.equal((await t.owner("POST", "/contacts", { name: "A".repeat(500) })).status, 400);
    assert.equal((await t.owner("POST", "/contacts", { name: "Z", email: "not-an-email" })).status, 400);
    assert.equal((await t.owner("POST", "/contacts", { name: "Z", tags: "vip" })).status, 400);
    const sqli = await mkContact(t.owner, { name: "x'); DROP TABLE contacts;--", email: "s@y.co", phone: "+14155550302" });
    assert.ok(sqli.id);
    assert.equal((await t.owner("GET", "/contacts?search=%27%29%3B%20DROP")).status, 200);
    await mkContact(t.owner, { name: "=HYPERLINK(\"http://evil\")", email: "f@y.co", phone: "+14155550303" });
    const csv = (await t.owner("GET", "/contacts/export.csv")).text;
    assert.ok(csv.includes("'=HYPERLINK"));
    assert.ok(!/^=/m.test(csv));
  });
});

describe("recorded actions acknowledge leads and reset the clock (glossary)", () => {
  it("a note by the lead owner counts as acknowledgement", async () => {
    const t = await app.team(0);
    await t.owner("PUT", "/settings/lead-routing", { ackWindowSeconds: 600, maxOpenLeads: 8, escalationLevels: 3, idleSeconds: 86400, levelWindowSeconds: [], backupUserId: null, managerUserId: t.ownerId });
    const r = await app.client()("POST", `/public/leads/${t.publicKey}`, { name: "Lead Person", phone: "+14155550400" });
    assert.equal(r.status, 201);
    const lead = (await t.owner("GET", "/leads?scope=mine")).json.items[0];
    assert.equal(lead.status, "needs_acknowledgement");
    await t.owner("POST", `/contacts/${lead.contactId}/notes`, { text: "Called the customer" });
    const after = (await t.owner("GET", `/leads/${lead.id}`)).json;
    assert.equal(after.status, "acknowledged");
    assert.ok(after.firstResponseAt);
  });
});
