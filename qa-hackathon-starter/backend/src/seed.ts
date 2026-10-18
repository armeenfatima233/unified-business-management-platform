// Sample data for a fresh checkout (Q13): `npm run seed` creates a demo workspace through the real
// API rules (not by writing rows directly), so the data is exactly what the product itself would
// produce. Safe to run twice: it stops if the demo owner already exists.
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

const DEMO = { email: "demo@ubmp.test", password: "demo-password-1234", name: "Ava Morgan", workspaceName: "Northstar Growth (demo)" };
const TEAM = [
  { email: "noah@ubmp.test", name: "Noah Williams" },
  { email: "priya@ubmp.test", name: "Priya Shah" },
  { email: "liam@ubmp.test", name: "Liam Chen" },
];

const dbPath = process.env.DB_PATH ?? "./data/app.db";
const db = openDb(dbPath);

if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(DEMO.email)) {
  console.log(`Demo data already exists in ${dbPath} (log in as ${DEMO.email}).`);
  db.close();
  process.exit(0);
}

const server = createApp(db).listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

function session() {
  let cookie = "";
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return json;
  };
}

try {
  const owner = session();
  const signup = await owner("POST", "/auth/signup", DEMO);
  const ownerId = signup.user.id as string;

  const members: { id: string; api: ReturnType<typeof session> }[] = [];
  for (const m of TEAM) {
    const inv = await owner("POST", "/members/invitations", { email: m.email, baseLevel: "user" });
    const api = session();
    const joined = await api("POST", "/auth/accept-invitation", { token: inv.token, name: m.name, password: DEMO.password });
    members.push({ id: joined.user.id, api });
  }
  // Noah is a manager: a permission set, not a fourth level (F1.3).
  await owner("PUT", `/members/${members[0]!.id}/permissions`, {
    permissions: ["crmView", "crmCreate", "crmEdit", "crmDelete", "crmExport", "manageAssignmentRules", "viewAuditLog", "viewOpportunityValue"],
  });
  await members[2]!.api("PATCH", "/members/me/availability", { availability: "busy" });

  // Short windows so the escalation chain can be watched in a demo (F3.4, F3.5).
  await owner("PUT", "/settings/lead-routing", {
    ackWindowSeconds: 60, maxOpenLeads: 8, escalationLevels: 3, idleSeconds: 86400, levelWindowSeconds: [],
    backupUserId: members[1]!.id, managerUserId: members[0]!.id,
  });

  const sales = (await owner("GET", "/pipelines")).items[0];
  const stage = (p: { stages: { id: string; name: string }[] }, name: string) => p.stages.find((s) => s.name === name)!.id;
  const support = await owner("POST", "/pipelines", { name: "Support" });

  const roof = await owner("POST", "/custom-fields", { entityType: "opportunity", pipelineId: sales.id, name: "Roof size (m2)", fieldType: "number" });
  const property = await owner("POST", "/custom-fields", { entityType: "opportunity", pipelineId: sales.id, name: "Property type", fieldType: "dropdown", options: ["Residential", "Commercial"] });
  await owner("POST", "/custom-fields", { entityType: "opportunity", pipelineId: sales.id, name: "Financing needed", fieldType: "checkbox" });
  await owner("POST", "/custom-fields", { entityType: "opportunity", pipelineId: sales.id, name: "Site survey date", fieldType: "date" });
  await owner("POST", "/custom-fields", { entityType: "opportunity", pipelineId: support.id, name: "Ticket priority", fieldType: "dropdown", options: ["Low", "Normal", "High"] });
  await owner("PUT", `/stages/${stage(sales, "Proposal")}/required-fields`, { fieldIds: [roof.id, property.id] }); // F2.4

  const people = [
    { name: "Maya Patel", company: "Northstar Solar", phone: "+14155550187", email: "maya@northstarsolar.example", tags: ["priority"] },
    { name: "Jonas Weber", company: "Weber Roofing", phone: "+14155550142", email: "jonas@weberroofing.example", tags: [] },
    { name: "Elena Rossi", company: "Rossi Clinics", phone: "+14155550163", email: "elena@rossiclinics.example", tags: ["priority", "clinic"] },
    { name: "Omar Haddad", company: "Haddad Estates", phone: "+14155550119", email: "omar@haddadestates.example", tags: ["real-estate"] },
  ];
  const deals: [string, number, string][] = [["Rooftop expansion", 84000, "Proposal"], ["Warehouse retrofit", 52000, "Qualified"], ["Clinic solar plan", 120000, "New"], ["Estate portfolio", 18000, "Won"]];
  for (const [i, p] of people.entries()) {
    const company = await owner("POST", "/companies", { name: p.company });
    const { contact } = await owner("POST", "/contacts", { name: p.name, email: p.email, phone: p.phone, tags: p.tags, companyId: company.id, ownerId: ownerId });
    const [name, value, stageName] = deals[i]!;
    const gated = stageName === "Proposal" ? { customFields: { [roof.id]: 420, [property.id]: "Commercial" } } : {};
    await owner("POST", "/opportunities", { contactId: contact.id, pipelineId: sales.id, stageId: stage(sales, stageName), name, value, ...gated });
  }
  await owner("POST", "/saved-filters", { entity: "contact", name: "Priority contacts", criteria: { tag: "priority" } });

  // Three leads from the public web form, plus one manual entry (F3.1).
  const form = await owner("GET", "/settings/public-form");
  for (const [name, phone] of [["Sofia Alvarez", "+14155550201"], ["Tariq Mahmood", "+14155550202"], ["Hana Kim", "+14155550203"]] as const) {
    await fetch(`${base}/public/leads/${form.publicKey}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, phone, message: "Interested in a quote" }) });
  }
  await owner("POST", "/leads", { contact: { name: "Walk-in Customer", phone: "+14155550204" }, message: "Came into the office" });

  console.log(`Demo workspace created in ${dbPath}.`);
  console.log(`  Owner login:   ${DEMO.email} / ${DEMO.password}`);
  console.log(`  Team logins:   ${TEAM.map((m) => m.email).join(", ")}  (same password)`);
  console.log(`  Public form:   POST /api/v1/public/leads/${form.publicKey}`);
} finally {
  server.close();
  db.close();
}
