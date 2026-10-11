import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { links, type LinkRow } from "@/db/schema";
import { generateId, generateToken } from "@/lib/ids";
import {
  DEFAULT_EXPIRY,
  expiryMs,
  MAX_URL_CHARS,
  RESERVED_SLUGS,
  SLUG_RE,
} from "@/lib/constants";
import type { LinkPayload } from "@/lib/types";

export type CreateLinkInput = {
  url: string;
  burn?: boolean;
  slug?: string | null;
  expiry?: string;
};

export type CreateLinkResult =
  | { ok: true; id: string; manageToken: string; expiresAt: string }
  | { ok: false; status: number; error: string };

export function normalizeUrl(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed.length > MAX_URL_CHARS) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function createLink(input: CreateLinkInput): Promise<CreateLinkResult> {
  const url = normalizeUrl(input.url);
  if (!url) {
    return { ok: false, status: 400, error: "That doesn't look like an http(s) address." };
  }

  const ms = expiryMs(input.expiry ?? DEFAULT_EXPIRY);
  if (!ms) return { ok: false, status: 400, error: "Pick a valid lifetime." };
  const expiresAt = new Date(Date.now() + ms);

  let id = generateId();
  const slug = (input.slug ?? "").trim().toLowerCase();
  if (slug) {
    if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
      return { ok: false, status: 400, error: "That name is taken, try another." };
    }
    const existing = await getLinkRow(slug);
    if (existing) return { ok: false, status: 409, error: "That name is taken, try another." };
    id = slug;
  }

  const manageToken = generateToken();

  for (let attempt = 0; attempt < 4 && id; attempt++) {
    try {
      await db.insert(links).values({
        id,
        url,
        burn: input.burn === true,
        manageToken,
        expiresAt,
      });
      void db.delete(links).where(lt(links.expiresAt, new Date())).catch(() => {});
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
  return { ok: false, status: 500, error: "Could not save that link — please try again." };
}
