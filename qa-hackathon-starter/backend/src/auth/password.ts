// Password hashing (Q1). scrypt is built into Node, memory-hard, and needs no
// dependency. Stored format: "scrypt$<salt hex>$<hash hex>".
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16); // unique salt per user defeats rainbow tables
  const hash = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  // Constant-time compare so response timing does not leak how many bytes matched.
  return timingSafeEqual(actual, expected);
}

// A real hash of a throwaway password. Login verifies against it when the email
// is unknown, so "no such user" costs the same time as "wrong password".
export const DUMMY_HASH = await hashPassword(randomBytes(8).toString("hex"));
