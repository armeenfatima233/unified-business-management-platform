// Shared test helpers: an in-process server on a throwaway database and a cookie-keeping client.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { openDb, type Db } from "../src/db.ts";

export type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any; text: string }>;

export interface TestApp { db: Db; server: Server; base: string; close(): void; client(): Api; team(n: number): Promise<Team>; }
export interface Member { api: Api; id: string; email: string; }
export interface Team { owner: Api; ownerId: string; workspaceId: string; publicKey: string; users: Member[]; }

export async function startApp(options: Parameters<typeof createApp>[1] = {}): Promise<TestApp> {
  const db = openDb(":memory:");
  let base = "";
  const server = await new Promise<Server>((resolve) => {
    const s = createApp(db, options).listen(0, () => {
      base = `http://127.0.0.1:${(s.address() as { port: number }).port}/api/v1`;
      resolve(s);
    });
  });
  const client = (): Api => {
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
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* csv etc. */ }
      return { status: res.status, json, text };
    };
  };
  let counter = 0;
  const PASSWORD = "correct-horse-battery";
  // A workspace with an Owner and `n` plain users.
  const team = async (n: number): Promise<Team> => {
    counter++;
    const owner = client();
    const signup = await owner("POST", "/auth/signup", { email: `owner${counter}@example.com`, password: PASSWORD, name: "Owner", workspaceName: `WS${counter}` });
    assert.equal(signup.status, 201);
    const users: Member[] = [];
    for (let i = 0; i < n; i++) {
      const email = `u${counter}_${i}@example.com`;
      const inv = await owner("POST", "/members/invitations", { email, baseLevel: "user" });
      const api = client();
      const acc = await api("POST", "/auth/accept-invitation", { token: inv.json.token, name: `User ${i}`, password: PASSWORD });
      users.push({ api, id: acc.json.user.id, email });
    }
    const form = await owner("GET", "/settings/public-form");
    return { owner, ownerId: signup.json.user.id, workspaceId: signup.json.workspace.id, publicKey: form.json.publicKey, users };
  };
  return { db, server, get base() { return base; }, close: () => { server.close(); db.close(); }, client, team } as TestApp;
}
