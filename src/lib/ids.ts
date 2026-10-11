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
