"use client";

import { useEffect, useState } from "react";
import { FileText, Link2, Trash2 } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { getLocalItems, removeLocalItem } from "@/lib/local-items";
import { timeUntil } from "@/lib/time";
import type { LocalItem } from "@/lib/types";

export function LocalList() {
  const [items, setItems] = useState<LocalItem[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    setItems(getLocalItems());
  }, []);

  // Render nothing until mounted — this list lives only in the browser.
  if (items === null) return null;

  async function letGo(item: LocalItem) {
    try {
      await fetch(`/api/${item.kind === "paste" ? "pastes" : "links"}/${item.id}`, {
        method: "DELETE",
        headers: { "x-manage-token": item.manageToken },
      });
    } catch {
      /* even on failure, drop it from the device */
    }
    removeLocalItem(item.kind, item.id);
    setItems((prev) => (prev ?? []).filter((x) => x.id !== item.id));
    setConfirmId(null);
  }

  return (
    <section className="mt-14">
      <h2 className="smallcaps text-ink-3">Kept on this device</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">
        Slips and links you sealed in this browser, with their delete keys. Nothing
        here is public — it's a drawer, not a feed.
      </p>

      {items.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-5 text-sm italic text-ink-3">
          The drawer is empty. Everything you seal will rest here until it fades.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-lg border border-line bg-raised">
          {items.map((item) => {
            const path = `/${item.kind === "paste" ? "p" : "l"}/${item.id}`;
            const fullUrl =
              typeof window !== "undefined" ? `${window.location.origin}${path}` : path;
            const Icon = item.kind === "paste" ? FileText : Link2;
            return (
              <li
                key={`${item.kind}-${item.id}`}
                className="flex items-center gap-3 px-4 py-3"
              >
                <Icon className="size-4 shrink-0 text-ink-3" strokeWidth={1.75} />
                <a
                  href={path}
                  className="min-w-0 flex-1 truncate text-sm text-ink transition-colors hover:text-accent"
                >
                  {item.title ?? (
                    <span className="font-mono text-[0.8125rem]">{path}</span>
                  )}
                </a>
                <span className="hidden shrink-0 text-[0.75rem] text-ink-3 sm:block">
                  fades {timeUntil(item.expiresAt)}
                </span>
                <CopyButton
                  text={fullUrl}
                  label="Copy"
                  copiedLabel="Copied"
                  className="shrink-0 px-2 py-1 text-[0.75rem]"
                />
                {confirmId === item.id ? (
                  <button
                    type="button"
                    onClick={() => void letGo(item)}
                    className="shrink-0 rounded-md border border-danger/40 bg-danger-soft px-2 py-1 text-[0.75rem] text-danger transition-colors hover:bg-danger hover:text-raised"
                  >
                    Sure?
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmId(item.id)}
                    aria-label="Let it go"
                    title="Let it go now"
                    className="shrink-0 rounded-md p-1.5 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.75} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
