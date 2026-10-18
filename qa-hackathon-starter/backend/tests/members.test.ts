// Tests for F1.2-F1.6 (levels, invitations, configurable permissions, server-side
// enforcement, workspace isolation) and F3.2 (availability).
import assert from "node:assert/strict";
import cookieParser from "cookie-parser";
import express from "express";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.ts";
import { maskValue } from "../src/auth/permissions.ts";
import { openDb, type Db } from "../src/db.ts";
import { requireAuth } from "../src/middleware/requireAuth.ts";
import { requirePermission } from "../src/middleware/requirePermission.ts";

let db: Db;
let server: Server;
let guarded: Server;
let base: string;
let guardedBase: string;

const listen = (app: express.Express) =>
  new Promise<{ server: Server; url: string }>((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, url: `http://127.0.0.1:${(s.address() as { port: number }).port}` }));
  });

// Keeps a session cookie between calls, like a browser.
function client() {
  let cookie = "";
  return async (method: string, path: string, body?: unknown) => {
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
async function signupOwner(email: string, workspaceName: string) {
  const api = client();
  const r = await api("POST", "/auth/signup", { email, password: PASSWORD, name: `Owner ${workspaceName}`, workspaceName });
  assert.equal(r.status, 201);
  return { api, id: r.json.user.id as string };
}
async function invite(owner: ReturnType<typeof client>, email: string, baseLevel: "admin" | "user") {
  const inv = await owner("POST", "/members/invitations", { email, baseLevel });
  assert.equal(inv.status, 201);
  const api = client();
  const acc = await api("POST", "/auth/accept-invitation", { token: inv.json.token, name: email.split("@")[0], password: PASSWORD });
  assert.equal(acc.status, 201);
  return { api, id: acc.json.user.id as string, token: inv.json.token as string, accepted: acc };
}

before(async () => {
  db = openDb(":memory:");
  ({ server, url: base } = await listen(createApp(db)).then((r) => ({ server: r.server, url: `${r.url}/api/v1` })));
  // A throwaway route protected by requirePermission, to prove the middleware rejects server-side (F1.5).
  const app = express();
  app.use(cookieParser());
  app.get("/export", requireAuth(db), requirePermission(db, "crmExport"), (_req, res) => res.json({ ok: true }));
  const g = await listen(app);
  guarded = g.server;
  guardedBase = g.url;
});

after(() => {
  server.close();
  guarded.close();
  db.close();
});

describe("invitations and levels (F1.2)", () => {
  it("Owner invites a User who joins the same workspace; token is single-use", async () => {
    const { api: owner } = await signupOwner("o1@example.com", "Alpha");
    const user = await invite(owner, "u1@example.com", "user");
    assert.equal(user.accepted.json.baseLevel, "user");
    assert.equal(user.accepted.json.workspace.name, "Alpha");
    const again = await client()("POST", "/auth/accept-invitation", { token: user.token, name: "X", password: PASSWORD });
    assert.equal(again.status, 400);
    assert.equal(again.json.error.code, "INVALID_INVITATION");
    const row = db.prepare("SELECT token_hash FROM invitations WHERE email = ?").get("u1@example.com") as { token_hash: string };
    assert.notEqual(row.token_hash, user.token); // only a hash is stored
  });

  it("a plain User cannot invite; an Admin cannot invite an Admin", async () => {
    const { api: owner } = await signupOwner("o2@example.com", "Beta");
    const user = await invite(owner, "u2@example.com", "user");
    const admin = await invite(owner, "a2@example.com", "admin");
    assert.equal((await user.api("POST", "/members/invitations", { email: "x@example.com", baseLevel: "user" })).status, 403);
    assert.equal((await admin.api("POST", "/members/invitations", { email: "y@example.com", baseLevel: "admin" })).status, 403);
    assert.equal((await admin.api("POST", "/members/invitations", { email: "z@example.com", baseLevel: "user" })).status, 201);
  });

  it("an expired or replaced invitation is rejected", async () => {
    const { api: owner } = await signupOwner("o3@example.com", "Gamma");
    const first = await owner("POST", "/members/invitations", { email: "late@example.com", baseLevel: "user" });
    const second = await owner("POST", "/members/invitations", { email: "late@example.com", baseLevel: "user" });
    const old = await client()("POST", "/auth/accept-invitation", { token: first.json.token, name: "L", password: PASSWORD });
    assert.equal(old.status, 400); // re-inviting invalidated the first link
    db.prepare("UPDATE invitations SET expires_at = ? WHERE email = ?").run(new Date(Date.now() - 1000).toISOString(), "late@example.com");
    const expired = await client()("POST", "/auth/accept-invitation", { token: second.json.token, name: "L", password: PASSWORD });
    assert.equal(expired.status, 400);
  });

  it("rejects invalid input and an already-registered email", async () => {
    const { api: owner } = await signupOwner("o4@example.com", "Delta");
    assert.equal((await owner("POST", "/members/invitations", { email: "nope", baseLevel: "user" })).status, 400);
    assert.equal((await owner("POST", "/members/invitations", { email: "o4@example.com", baseLevel: "user" })).status, 409);
    assert.equal((await owner("POST", "/members/invitations", { email: "q@example.com", baseLevel: "owner" })).status, 400);
    assert.equal((await client()("POST", "/members/invitations", { email: "q@example.com", baseLevel: "user" })).status, 401);
  });

  it("an Admin cannot modify the Owner; only the Owner assigns levels", async () => {
    const { api: owner, id: ownerId } = await signupOwner("o5@example.com", "Epsilon");
    const admin = await invite(owner, "a5@example.com", "admin");
    const user = await invite(owner, "u5@example.com", "user");
    assert.equal((await admin.api("PUT", `/members/${ownerId}/permissions`, { permissions: [] })).status, 403);
    assert.equal((await admin.api("PATCH", `/members/${user.id}/role`, { baseLevel: "admin" })).status, 403);
    assert.equal((await owner("PATCH", `/members/${ownerId}/role`, { baseLevel: "user" })).status, 403);
    const promoted = await owner("PATCH", `/members/${user.id}/role`, { baseLevel: "admin" });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.json.baseLevel, "admin");
  });
});

describe("configurable permissions (F1.3, F1.5)", () => {
  it("Owner grants and removes permissions and it applies immediately", async () => {
    const { api: owner } = await signupOwner("o6@example.com", "Zeta");
    const user = await invite(owner, "u6@example.com", "user");
    assert.equal((await user.api("GET", "/auth/me")).json.permissions.includes("crmExport"), false);
    const granted = await owner("PUT", `/members/${user.id}/permissions`, { permissions: ["crmView", "crmExport", "viewAuditLog"] });
    assert.equal(granted.status, 200);
    assert.deepEqual(granted.json.permissions, ["crmView", "crmExport", "viewAuditLog"]);
    assert.equal((await user.api("GET", "/auth/me")).json.permissions.includes("crmExport"), true); // same session, no re-login
    const removed = await owner("PUT", `/members/${user.id}/permissions`, { permissions: ["crmView"] });
    assert.deepEqual(removed.json.permissions, ["crmView"]);
  });

  it("an Admin can manage a User's permissions but not another Admin's", async () => {
    const { api: owner } = await signupOwner("o7@example.com", "Eta");
    const admin = await invite(owner, "a7@example.com", "admin");
    const admin2 = await invite(owner, "b7@example.com", "admin");
    const user = await invite(owner, "u7@example.com", "user");
    assert.equal((await admin.api("PUT", `/members/${user.id}/permissions`, { permissions: ["crmView", "crmDelete"] })).status, 200);
    assert.equal((await admin.api("PUT", `/members/${admin2.id}/permissions`, { permissions: [] })).status, 403);
  });

  it("rejects unknown permission names", async () => {
    const { api: owner } = await signupOwner("o8@example.com", "Theta");
    const user = await invite(owner, "u8@example.com", "user");
    assert.equal((await owner("PUT", `/members/${user.id}/permissions`, { permissions: ["godMode"] })).status, 400);
  });

  it("requirePermission rejects a direct API call without the capability (hiding a button is not enough)", async () => {
    const { api: owner } = await signupOwner("o9@example.com", "Iota");
    const user = await invite(owner, "u9@example.com", "user");
    // Same DB, so the user's cookie from the main app is valid on the guarded app.
    assert.equal((await fetch(`${guardedBase}/export`)).status, 401);
    const cookieClient = (() => {
      let cookie = "";
      return async () => {
        if (!cookie) {
          const res = await fetch(`${base}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "u9@example.com", password: PASSWORD }),
          });
          cookie = res.headers.get("set-cookie")!.split(";")[0]!;
        }
        return fetch(`${guardedBase}/export`, { headers: { cookie } });
      };
    })();
    assert.equal((await cookieClient()).status, 403);
    await owner("PUT", `/members/${user.id}/permissions`, { permissions: ["crmView", "crmExport"] });
    assert.equal((await cookieClient()).status, 200);
  });

  it("maskValue hides opportunity value without viewOpportunityValue (F1.4)", () => {
    assert.equal(maskValue(84000, ["crmView"]), null);
    assert.equal(maskValue(84000, ["crmView", "viewOpportunityValue"]), 84000);
  });
});

describe("workspace isolation (F1.6)", () => {
  it("a guessed member id from another workspace is a 404 and changes nothing", async () => {
    const { api: ownerA } = await signupOwner("oa@example.com", "Workspace A");
    const { api: ownerB } = await signupOwner("ob@example.com", "Workspace B");
    const userA = await invite(ownerA, "ua@example.com", "user");
    assert.equal((await ownerB("PUT", `/members/${userA.id}/permissions`, { permissions: [] })).status, 404);
    assert.equal((await ownerB("PATCH", `/members/${userA.id}/role`, { baseLevel: "admin" })).status, 404);
    assert.equal((await ownerB("PATCH", `/members/${userA.id}/availability`, { availability: "offline" })).status, 404);
    const list = await ownerB("GET", "/members");
    assert.equal(list.json.items.length, 1);
    assert.equal(list.json.items.some((m: { id: string }) => m.id === userA.id), false);
    const row = db.prepare("SELECT base_level, availability FROM memberships WHERE user_id = ?").get(userA.id) as { base_level: string; availability: string };
    assert.deepEqual({ ...row }, { base_level: "user", availability: "available" });
  });
});

describe("availability (F3.2)", () => {
  it("a user sets their own status; only Owner/Admin set others'", async () => {
    const { api: owner } = await signupOwner("ov@example.com", "Kappa");
    const u1 = await invite(owner, "v1@example.com", "user");
    const u2 = await invite(owner, "v2@example.com", "user");
    const own = await u1.api("PATCH", "/members/me/availability", { availability: "on_leave" });
    assert.equal(own.status, 200);
    assert.equal((await u1.api("PATCH", `/members/${u2.id}/availability`, { availability: "offline" })).status, 403);
    assert.equal((await owner("PATCH", `/members/${u2.id}/availability`, { availability: "busy" })).status, 200);
    assert.equal((await u1.api("PATCH", "/members/me/availability", { availability: "asleep" })).status, 400);
    const me = await u1.api("GET", "/auth/me");
    assert.equal(me.json.availability, "on_leave");
  });
});
