// Shared integration plumbing (I5): encrypted per-workspace secrets, connection records, the
// synchronization history and a bounded, plain-language error model.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { tx, type Db } from "../db.ts";

export type Provider = "twilio" | "stripe" | "google" | "telegram" | "resend";
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// Everything an integration needs from the outside world, injected so a provider outage or a
// test double never leaks into business code (Q14, I5.8).
export interface IntegrationContext {
  db: Db;
  fetch: FetchLike;
  secretsKey: Buffer; // 32 bytes, from SECRETS_KEY / data/secrets.key (never committed)
  publicBaseUrl: string; // https address providers call back (tunnel or deployed host)
  frontendUrl: string;
}

// ----- Secrets at rest (I5.3): AES-256-GCM, stored as base64(iv|tag|ciphertext) -----
export function parseSecretsKey(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes (64 hex characters or base64).");
  return key;
}

export function encryptSecrets(key: Buffer, secrets: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decryptSecrets<T = Record<string, string>>(key: Buffer, blob: string): T {
  const raw = Buffer.from(blob, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
}

// Never show a secret in full: keep only the last four characters.
export const mask = (value: string | undefined | null) => (value ? `••••${value.slice(-4)}` : null);

// ----- Connections -----
export interface Connection {
  id: string;
  workspace_id: string;
  provider: Provider;
  user_id: string | null;
  status: "connected" | "error" | "needs_reconnection";
  config_json: string;
  secrets_enc: string | null;
  webhook_key: string | null;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function getConnection(db: Db, workspaceId: string, provider: Provider, userId: string | null = null): Connection | undefined {
  return db
    .prepare("SELECT * FROM integration_connections WHERE workspace_id = ? AND provider = ? AND ifnull(user_id,'') = ifnull(?,'')")
    .get(workspaceId, provider, userId) as Connection | undefined;
}

export const connectionConfig = <T = Record<string, unknown>>(c: Connection): T => JSON.parse(c.config_json) as T;
export const connectionSecrets = <T = Record<string, string>>(ctx: IntegrationContext, c: Connection): T =>
  c.secrets_enc ? decryptSecrets<T>(ctx.secretsKey, c.secrets_enc) : ({} as T);

export function saveConnection(
  ctx: IntegrationContext,
  workspaceId: string,
  provider: Provider,
  userId: string | null,
  config: Record<string, unknown>,
  secrets: object,
): Connection {
  const { db } = ctx;
  const now = new Date().toISOString();
  const existing = getConnection(db, workspaceId, provider, userId);
  const blob = encryptSecrets(ctx.secretsKey, secrets);
  if (existing) {
    db.prepare("UPDATE integration_connections SET config_json = ?, secrets_enc = ?, status = 'connected', last_error = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(config), blob, now, existing.id);
    return getConnection(db, workspaceId, provider, userId)!;
  }
  db.prepare(
    `INSERT INTO integration_connections (id, workspace_id, provider, user_id, status, config_json, secrets_enc, webhook_key, created_at, updated_at)
     VALUES (?,?,?,?,'connected',?,?,?,?,?)`,
  ).run(randomUUID(), workspaceId, provider, userId, JSON.stringify(config), blob, randomBytes(18).toString("base64url"), now, now);
  return getConnection(db, workspaceId, provider, userId)!;
}

export function findByWebhookKey(db: Db, provider: Provider, key: string): Connection | undefined {
  return db.prepare("SELECT * FROM integration_connections WHERE provider = ? AND webhook_key = ?").get(provider, key) as Connection | undefined;
}

// ----- Synchronization history (I5.4) and health (I5.1) -----
export interface EventInput {
  workspaceId: string;
  provider: Provider;
  direction: "inbound" | "outbound";
  eventType: string;
  externalId?: string | null;
  result: "ok" | "error" | "rejected" | "duplicate";
  detail?: string | null;
}

export function logEvent(db: Db, e: EventInput) {
  db.prepare(
    "INSERT INTO integration_events (id, workspace_id, provider, direction, event_type, external_id, result, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(randomUUID(), e.workspaceId, e.provider, e.direction, e.eventType, e.externalId ?? null, e.result, e.detail?.slice(0, 500) ?? null, new Date().toISOString());
}

export function markSuccess(db: Db, c: Connection) {
  db.prepare("UPDATE integration_connections SET last_success_at = ?, status = CASE WHEN status = 'error' THEN 'connected' ELSE status END, last_error = NULL WHERE id = ?").run(new Date().toISOString(), c.id);
}

export function markFailure(db: Db, c: Connection, message: string, status: "error" | "needs_reconnection" = "error") {
  db.prepare("UPDATE integration_connections SET status = ?, last_error = ? WHERE id = ?").run(status, message.slice(0, 300), c.id);
}

// ----- Calling a provider -----
export class ProviderError extends Error {
  retryable: boolean; // temporary: timeout, rate limit, 5xx. Permanent: rejected credentials, bad input.
  status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

// Calls a provider with a timeout and turns every failure into a ProviderError with a plain
// explanation; a thrown ProviderError never propagates into unrelated platform features (I5.8).
export async function callProvider<T>(
  ctx: IntegrationContext,
  conn: Connection,
  eventType: string,
  request: () => Promise<{ response: Response; parse: (res: Response) => Promise<T> }>,
  describeError: (status: number, body: unknown) => string,
  externalId?: (value: T) => string | null,
): Promise<T> {
  const { db } = ctx;
  try {
    const { response, parse } = await request();
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      throw new ProviderError(describeError(response.status, body), retryable, response.status);
    }
    const value = await parse(response);
    markSuccess(db, conn);
    logEvent(db, { workspaceId: conn.workspace_id, provider: conn.provider, direction: "outbound", eventType, externalId: externalId?.(value) ?? null, result: "ok" });
    return value;
  } catch (err) {
    const pe = err instanceof ProviderError ? err : new ProviderError(`${conn.provider} could not be reached (${(err as Error).message}).`, true);
    markFailure(db, conn, pe.message);
    logEvent(db, { workspaceId: conn.workspace_id, provider: conn.provider, direction: "outbound", eventType, result: "error", detail: pe.message });
    throw pe;
  }
}

export const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
export const withTimeout = (ms = 10_000): AbortSignal => AbortSignal.timeout(ms);

// Durable webhook de-duplication shared by every provider. Runs `work` and records the event id in
// one transaction, so a provider retry (or a crash half-way) never repeats or loses the effect.
// Returns false when the event was already processed.
export function processOnce(db: Db, workspaceId: string, provider: Provider, providerEventId: string, work: () => void): boolean {
  return tx(db, () => {
    const fresh = db.prepare("INSERT OR IGNORE INTO processed_events (workspace_id, provider, external_id, created_at) VALUES (?,?,?,?)").run(workspaceId, provider, providerEventId, new Date().toISOString());
    if (fresh.changes === 0) return false;
    work();
    return true;
  });
}
