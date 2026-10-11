import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

export function SiteHeader({ compact = false }: { compact?: boolean }) {
  return (
    <header className="hairline-b">
      <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-6">
        <Link
          href="/"
          className="font-display-it text-[1.5rem] leading-none tracking-tight text-ink"
        >
          Slip<span className="text-accent">.</span>
        </Link>
        <div className="flex items-center gap-4">
          {!compact && (
            <span className="smallcaps hidden text-ink-3 sm:block">
              text &amp; links that fade
            </span>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ children }: { children?: ReactNode }) {
  return (
    <footer className="hairline-t mt-20">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1 px-6 py-8 text-[0.8125rem] text-ink-3">
        {children ?? (
          <>
            <p>Everything on Slip expires. Nothing is listed or indexed — the link is the only way in.</p>
            <p className="text-ink-3/70">Made for quiet sharing.</p>
          </>
        )}
      </div>
    </footer>
  );
}
