// Stage 0 contract: CORS allowlist for the separate frontend, and permissions in auth responses.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";

let server: Server;
let base: string;

describe("cors + session shape", () => {
  before(async () => {
    const app = createApp(openDb(":memory:"), { corsOrigins: ["http://localhost:3000"] });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
        resolve();
      });
    });
  });
  after(() => server.close());

  it("echoes an allowed origin with credentials and answers preflight", async () => {
    const res = await fetch(`${base}/health`, { method: "OPTIONS", headers: { origin: "http://localhost:3000" } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  });

  it("does not grant CORS to an unlisted origin", async () => {
    const res = await fetch(`${base}/health`, { headers: { origin: "http://evil.example" } });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("signup returns availability and the owner's permissions", async () => {
    const res = await fetch(`${base}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "o@example.com", password: "correct-horse-1", name: "Olive Owner", workspaceName: "Acme" }),
    });
    const json = (await res.json()) as { availability: string; permissions: string[] };
    assert.equal(res.status, 201);
    assert.equal(json.availability, "available");
    assert.ok(json.permissions.includes("viewOpportunityValue"));
  });
});
