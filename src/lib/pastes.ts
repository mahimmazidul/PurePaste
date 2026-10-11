import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { pastes, type PasteRow } from "@/db/schema";
import { generateId, generateToken, hashPassword, verifyPassword } from "@/lib/ids";
import {
  DEFAULT_EXPIRY,
  expiryMs,
  LANGUAGE_IDS,
  MAX_CONTENT_CHARS,
  MAX_TITLE,
  RESERVED_SLUGS,
  SLUG_RE,
} from "@/lib/constants";
import type { PastePayload } from "@/lib/types";

export type CreatePasteInput = {
  title?: string | null;
  content: string;
  language?: string;
  format?: string;
  burn?: boolean;
  password?: string | null;
  slug?: string | null;
  expiry?: string;
};

export type CreatePasteResult =
  | { ok: true; id: string; manageToken: string; expiresAt: string }
  | { ok: false; status: number; error: string };

export async function createPaste(input: CreatePasteInput): Promise<CreatePasteResult> {
  const content = typeof input.content === "string" ? input.content : "";
  if (!content.trim()) {
    return { ok: false, status: 400, error: "Write something first — empty slips aren't kept." };
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return {
      ok: false,
      status: 413,
      error: `That's a little long for a slip — keep it under ${MAX_CONTENT_CHARS.toLocaleString()} characters.`,
    };
  }

  const title = (input.title ?? "").trim().slice(0, MAX_TITLE) || null;
  const language =
    input.language && LANGUAGE_IDS.has(input.language) ? input.language : "plain";
  const format = input.format === "markdown" ? "markdown" : "code";
  const burn = input.burn === true;

  const password = (input.password ?? "").trim();
  const passwordHash = password ? hashPassword(password) : null;

  const ms = expiryMs(input.expiry ?? DEFAULT_EXPIRY);
  if (!ms) {
    return { ok: false, status: 400, error: "Pick a valid lifetime." };
  }
  const expiresAt = new Date(Date.now() + ms);

  let id = generateId();
  const slug = (input.slug ?? "").trim().toLowerCase();
  if (slug) {
    if (!SLUG_RE.test(slug)) {
      return {
        ok: false,
        status: 400,
        error: "Names use 3–48 lowercase letters, numbers and dashes, starting and ending with a letter or number.",
      };
    }
    if (RESERVED_SLUGS.has(slug)) {
      return { ok: false, status: 400, error: "That name is taken, try another." };
    }
    const existing = await getPasteRow(slug);
    if (existing) {
      return { ok: false, status: 409, error: "That name is taken, try another." };
    }
    id = slug;
  }

  const manageToken = generateToken();
  const sizeBytes = Buffer.byteLength(content, "utf8");

  for (let attempt = 0; attempt < 4 && id; attempt++) {
    try {
      await db.insert(pastes).values({
        id,
        title,
        content,
        language,
        format,
        burn,
        passwordHash,
        manageToken,
        sizeBytes,
        expiresAt,
      });
      // Opportunistically sweep expired rows so the table stays lean.
      void db.delete(pastes).where(lt(pastes.expiresAt, new Date())).catch(() => {});
      return { ok: true, id, manageToken, expiresAt: expiresAt.toISOString() };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "23505" && !slug) {
        id = generateId();
        continue;
      }
      throw err;
    }
  }
  return { ok: false, status: 500, error: "Could not save that slip — please try again." };
}

export async function getPasteRow(id: string): Promise<PasteRow | null> {
  const rows = await db.select().from(pastes).where(eq(pastes.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Deletes the row if past expiry; returns null when the paste is unavailable. */
export async function getLivePaste(id: string): Promise<PasteRow | null> {
  const row = await getPasteRow(id);
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(pastes).where(eq(pastes.id, id)).catch(() => {});
    return null;
  }
  return row;
}

export function toPastePayload(row: PasteRow): PastePayload {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    language: row.language,
    format: row.format === "markdown" ? "markdown" : "code",
    burn: row.burn,
    views: row.views,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function countView(id: string): Promise<void> {
  await db
    .update(pastes)
    .set({ views: sql`${pastes.views} + 1` })
    .where(eq(pastes.id, id));
}

export type RevealResult =
  | { ok: true; payload: PastePayload }
  | { ok: false; status: number; error: string };

/**
 * Unlocks a protected paste. Burns (deletes) it when marked burn-after-reading.
 */
export async function revealPaste(id: string, password?: string): Promise<RevealResult> {
  const row = await getLivePaste(id);
  if (!row) return { ok: false, status: 404, error: "Nothing lives at this address anymore." };
  if (row.passwordHash) {
    if (!password) return { ok: false, status: 401, error: "A password is required." };
    if (!verifyPassword(password, row.passwordHash)) {
      return { ok: false, status: 403, error: "That password doesn't fit." };
    }
  }
  await countView(id);
  const payload = toPastePayload({ ...row, views: row.views + 1 });
  if (row.burn) {
    await db.delete(pastes).where(eq(pastes.id, id)).catch(() => {});
  }
  return { ok: true, payload };
}

export async function deletePaste(id: string, token: string): Promise<boolean> {
  if (!token) return false;
  const result = await db
    .delete(pastes)
    .where(and(eq(pastes.id, id), eq(pastes.manageToken, token)))
    .returning({ id: pastes.id });
  return result.length > 0;
}
