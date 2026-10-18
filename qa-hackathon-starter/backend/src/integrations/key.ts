// Where the key that encrypts provider secrets at rest comes from (I5.3): SECRETS_KEY in the environment,
// otherwise a random key generated once and kept next to the database file (data/ is never committed).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSecretsKey } from "./core.ts";

export function loadSecretsKey(envValue: string | undefined, dbPath: string): Buffer {
  if (envValue) return parseSecretsKey(envValue);
  const file = join(dirname(dbPath), "secrets.key");
  if (existsSync(file)) return parseSecretsKey(readFileSync(file, "utf8").trim());
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  return key;
}
