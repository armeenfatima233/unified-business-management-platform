// Tests for F1.1 (signup/login/logout/persistent session) plus Q1 basics.
// Each test run uses a temporary DB FILE (not :memory:) so persistence is real.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb, type Db } from "../src/db.ts";

let dir: string;
let dbPath: string;
let db: Db;
let server: Server;
let base: string;

const startServer = (database: Db) =>
  new Promise<{ server: Server; base: string }>((resolve) => {
    const s = createApp(database).listen(0, () => {
      const port = (s.address() as { port: number }).port;
      resolve({ server: s, base: `http://127.0.0.1:${port}/api/v1` });
    });
  });

// Minimal client that keeps the session cookie between calls, like a browser would.
function client() {
  let cookie = "";
  return async (method: string, path: string, body?: unknown, urlBase = base) => {
    const res = await fetch(urlBase + path, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, setCookie: set };
  };
}

const signupBody = (email: string) => ({
  email,
  password: "correct-horse-battery",
  name: "Owner One",
  workspaceName: "Acme Plumbing",
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ubmp-test-"));
  dbPath = join(dir, "test.db");
  db = openDb(dbPath);
  ({ server, base } = await startServer(db));
});

after(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth", () => {
  it("signup creates workspace + owner and logs in (cookie is httpOnly)", async () => {
    const api = client();
    const r = await api("POST", "/auth/signup", signupBody("owner@example.com"));
    assert.equal(r.status, 201);
    assert.equal(r.json.baseLevel, "owner");
    assert.match(r.setCookie ?? "", /HttpOnly/i);
    assert.match(r.setCookie ?? "", /SameSite=Lax/i);
    assert.equal(JSON.stringify(r.json).includes("password"), false); // never echo secrets
  });

  it("stores a hash, never the plain password", () => {
    const row = db.prepare("SELECT password_hash FROM users WHERE email = ?").get("owner@example.com") as {
      password_hash: string;
    };
    assert.match(row.password_hash, /^scrypt\$/);
    assert.equal(row.password_hash.includes("correct-horse"), false);
  });

  it("session survives repeated /me calls (refresh) and logout revokes it", async () => {
    const api = client();
    await api("POST", "/auth/signup", signupBody("refresh@example.com"));
    assert.equal((await api("GET", "/auth/me")).status, 200);
    assert.equal((await api("GET", "/auth/me")).status, 200);
    assert.equal((await api("POST", "/auth/logout")).status, 204);
    assert.equal((await api("GET", "/auth/me")).status, 401);
  });

  it("a logged-out token is dead server-side, not just removed from the browser", async () => {
    const api = client();
    const signup = await api("POST", "/auth/signup", signupBody("revoke@example.com"));
    const stolenCookie = signup.setCookie!.split(";")[0]!;
    await api("POST", "/auth/logout");
    const replay = await fetch(base + "/auth/me", { headers: { cookie: stolenCookie } });
    assert.equal(replay.status, 401);
  });

  it("login works with correct password and fails identically for bad password / unknown email", async () => {
    const api = client();
    await api("POST", "/auth/signup", signupBody("login@example.com"));
    const fresh = client();
    const good = await fresh("POST", "/auth/login", { email: "LOGIN@example.com", password: "correct-horse-battery" });
    assert.equal(good.status, 200);
    const wrongPw = await client()("POST", "/auth/login", { email: "login@example.com", password: "wrong-password-1" });
    const noUser = await client()("POST", "/auth/login", { email: "nobody@example.com", password: "wrong-password-1" });
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.deepEqual(wrongPw.json, noUser.json); // no account enumeration
  });

  it("rejects duplicate email (case-insensitive)", async () => {
    const api = client();
    await api("POST", "/auth/signup", signupBody("dup@example.com"));
    const again = await client()("POST", "/auth/signup", signupBody("DUP@example.com"));
    assert.equal(again.status, 409);
  });

  it("rejects invalid input and malformed JSON", async () => {
    const api = client();
    assert.equal((await api("POST", "/auth/signup", { ...signupBody("a@example.com"), password: "short" })).status, 400);
    assert.equal((await api("POST", "/auth/signup", { ...signupBody("not-an-email") })).status, 400);
    assert.equal((await api("POST", "/auth/signup", {})).status, 400);
    const bad = await fetch(base + "/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);
  });

  it("/me without a session is 401", async () => {
    assert.equal((await client()("GET", "/auth/me")).status, 401);
  });

  it("throttles login after repeated failures", async () => {
    await client()("POST", "/auth/signup", signupBody("throttle@example.com"));
    const api = client();
    for (let i = 0; i < 5; i++) {
      const r = await api("POST", "/auth/login", { email: "throttle@example.com", password: "bad-password-x" });
      assert.equal(r.status, 401);
    }
    // Even the correct password is refused while throttled.
    const blocked = await api("POST", "/auth/login", { email: "throttle@example.com", password: "correct-horse-battery" });
    assert.equal(blocked.status, 429);
  });

  it("data and session persist across a restart (new DB connection + new server)", async () => {
    const api = client();
    await api("POST", "/auth/signup", signupBody("persist@example.com"));
    // Simulate a restart: open the same file again with a fresh app instance.
    const db2 = openDb(dbPath);
    const second = await startServer(db2);
    try {
      const me = await api("GET", "/auth/me", undefined, second.base);
      assert.equal(me.status, 200);
      assert.equal(me.json.user.email, "persist@example.com");
    } finally {
      second.server.close();
      db2.close();
    }
  });
});
