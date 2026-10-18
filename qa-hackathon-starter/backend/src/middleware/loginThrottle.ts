// Login throttling (Q1). Counts failed attempts per email+IP in the DB so the
// limit survives restarts and cannot be reset by hitting another server process.
import type { Db } from "../db.ts";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

const keyFor = (email: string, ip: string) => `${email}|${ip}`;

export function isThrottled(db: Db, email: string, ip: string): boolean {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND created_at > ?")
    .get(keyFor(email, ip), since) as { n: number };
  return row.n >= MAX_FAILURES;
}

export function recordFailure(db: Db, email: string, ip: string) {
  db.prepare("INSERT INTO login_failures (key, created_at) VALUES (?,?)").run(
    keyFor(email, ip),
    new Date().toISOString(),
  );
}

// A successful login clears the counter so honest typos do not accumulate.
export function clearFailures(db: Db, email: string, ip: string) {
  db.prepare("DELETE FROM login_failures WHERE key = ?").run(keyFor(email, ip));
}
