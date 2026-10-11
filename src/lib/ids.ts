import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Unambiguous alphabet: no 0/o, 1/l/i.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateId(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function generateToken(): string {
  return randomBytes(18).toString("base64url");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `s1:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [v, saltB64, hashB64] = stored.split(":");
    if (v !== "s1" || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
