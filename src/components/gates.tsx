"use client";

import { useState, type FormEvent } from "react";
import { CircleAlert, Flame, KeyRound, LoaderCircle } from "lucide-react";
import { PasteView } from "@/components/paste-view";
import { timeUntil } from "@/lib/time";
import type { PastePayload } from "@/lib/types";

type GateProps = {
  id: string;
  needsPassword: boolean;
  burn: boolean;
  expiresAt: string;
};

export function PasteGate({ id, needsPassword, burn, expiresAt }: GateProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState<PastePayload | null>(null);

  async function reveal(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pastes/${id}/reveal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(password ? { password } : {}),
      });
      const data = (await res.json()) as { paste?: PastePayload; error?: string };
      if (!res.ok || !data.paste) {
        setError(data.error ?? "It slipped away — try again.");
        return;
      }
      setPaste(data.paste);
    } catch {
      setError("Couldn't reach the server — is your connection awake?");
    } finally {
      setBusy(false);
    }
  }

  if (paste) {
    return <PasteView paste={paste} destroyed={burn} revealed />;
  }

  const Icon = burn ? Flame : KeyRound;

  return (
    <div className="rise-in mx-auto max-w-md pt-10 sm:pt-16">
      <div className="rounded-xl border border-line bg-raised p-7 shadow-[var(--shadow)] sm:p-9">
        <span className="flex size-11 items-center justify-center rounded-full bg-sunken text-ink-2">
          <Icon className="size-5" strokeWidth={1.5} />
        </span>

        <h1 className="mt-5 font-display text-[1.625rem] leading-tight tracking-tight text-ink">
          {burn ? (
            <>
              This slip <span className="font-display-it">burns</span> after it's read.
            </>
          ) : (
            "A locked slip."
          )}
        </h1>

        <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">
          {burn
            ? "Once. That's all it has. The moment you open it, it's gone for everyone — link previews and refreshing can't coax it back."
            : "The sender set a password. It's checked against the slip — nowhere else."}
          <span className="mt-1 block text-[0.8125rem] text-ink-3">
            Fades {timeUntil(expiresAt)} either way.
          </span>
        </p>

        <form onSubmit={(e) => void reveal(e)} className="mt-6">
          {needsPassword && (
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="The password, as you were told it"
              autoComplete="off"
              autoFocus={!burn}
              aria-label="Password"
              className="w-full rounded-lg border border-line bg-raised px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3/70 transition-colors hover:border-line-strong focus:border-accent/50"
            />
          )}
          <button
            type="submit"
            disabled={busy || (needsPassword && !password)}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <LoaderCircle className="size-4 animate-spin" strokeWidth={2.25} />}
            {busy
              ? "Opening…"
              : burn
                ? "Read it, and let it go"
                : "Open the slip"}
          </button>
        </form>

        {error && (
          <p className="mt-4 flex items-center gap-2 text-sm text-danger">
            <CircleAlert className="size-4 shrink-0" strokeWidth={1.75} />
            {error}
          </p>
        )}
      </div>

      <p className="mt-6 text-center text-[0.8125rem] text-ink-3">
        Changed your mind?{" "}
        <a
          href="/"
          className="underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink"
        >
          Leave it sealed
        </a>
      </p>
    </div>
  );
}
