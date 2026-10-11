"use client";

import { useState } from "react";
import { ArrowUpRight, CircleAlert, Flame, Link2, LoaderCircle } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { timeUntil } from "@/lib/time";

type Props = {
  id: string;
  /** Destination, when it isn't burn-after-reading. */
  url: string | null;
  burn: boolean;
  visits: number;
  expiresAt: string;
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function LinkInterstitial({ id, url, burn, visits, expiresAt }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function proceed() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/links/${id}/reveal`, { method: "POST" });
      const data = (await res.json()) as { link?: { url: string }; error?: string };
      if (!res.ok || !data.link) {
        setError(data.error ?? "That link has already faded.");
        return;
      }
      window.location.assign(data.link.url);
    } catch {
      setError("Couldn't reach the server — is your connection awake?");
      setBusy(false);
    }
  }

  const host = url ? hostOf(url) : null;

  return (
    <div className="rise-in mx-auto max-w-lg pt-10 sm:pt-16">
      <div className="rounded-xl border border-line bg-raised p-7 shadow-[var(--shadow)] sm:p-9">
        <span className="flex size-11 items-center justify-center rounded-full bg-sunken text-ink-2">
          <Link2 className="size-5" strokeWidth={1.5} />
        </span>

        <h1 className="mt-5 font-display text-[1.625rem] leading-tight tracking-tight text-ink">
          A short hop <span className="font-display-it">onward</span>.
        </h1>

        <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">
          {host ? (
            <>
              This Slip link points to{" "}
              <span className="font-medium text-ink">{host}</span>. Look before you
              leap — at least you know where you're landing.
            </>
          ) : (
            "The destination stays hidden until you continue. Make sure you trust whoever sent you here."
          )}
          <span className="mt-1 block text-[0.8125rem] text-ink-3">
            {visits === 0
              ? "No one has followed it yet"
              : visits === 1
                ? "Followed once before"
                : `Followed ${visits} times`}{" "}
            · fades {timeUntil(expiresAt)}
          </span>
        </p>

        {url && (
          <div className="mt-5 rounded-lg border border-line bg-sunken px-3.5 py-2.5">
            <span className="block truncate font-mono text-[0.8125rem] text-ink-2">
              {url}
            </span>
          </div>
        )}

        {burn && (
          <p className="mt-4 flex items-center gap-2 rounded-lg border border-amber/25 bg-amber-soft px-3.5 py-2.5 text-[0.8125rem] text-amber">
            <Flame className="size-4 shrink-0" strokeWidth={1.75} />
            This link burns behind you — it works exactly once.
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void proceed()}
            disabled={busy || Boolean(error)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" strokeWidth={2.25} />
            ) : (
              <ArrowUpRight className="size-4" strokeWidth={2} />
            )}
            {busy ? "Following…" : burn ? "Continue, and burn it" : "Continue"}
          </button>
          {url && <CopyButton text={url} label="Copy destination" className="py-2.5" />}
        </div>

        {error && (
          <p className="mt-4 flex items-center gap-2 text-sm text-danger">
            <CircleAlert className="size-4 shrink-0" strokeWidth={1.75} />
            {error}
          </p>
        )}
      </div>

      <p className="mt-6 text-center text-[0.8125rem] text-ink-3">
        Slip only carried the address — it never touched what lives there.
      </p>
    </div>
  );
}
