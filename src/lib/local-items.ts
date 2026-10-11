"use client";

import type { LocalItem } from "@/lib/types";

const KEY = "slip-items-v1";

function readAll(): LocalItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is LocalItem =>
        x && typeof x.id === "string" && typeof x.manageToken === "string",
    );
  } catch {
    return [];
  }
}

function writeAll(items: LocalItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, 60)));
  } catch {
    /* storage full or unavailable */
  }
}

/** All items with expired ones pruned away. */
export function getLocalItems(): LocalItem[] {
  const now = Date.now();
  const all = readAll();
  const live = all.filter((x) => new Date(x.expiresAt).getTime() > now);
  if (live.length !== all.length) writeAll(live);
  return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveLocalItem(item: LocalItem) {
  const all = readAll().filter((x) => !(x.kind === item.kind && x.id === item.id));
  all.unshift(item);
  writeAll(all);
}

export function removeLocalItem(kind: string, id: string) {
  writeAll(readAll().filter((x) => !(x.kind === kind && x.id === id)));
}

export function getManageToken(kind: string, id: string): string | null {
  return readAll().find((x) => x.kind === kind && x.id === id)?.manageToken ?? null;
}
