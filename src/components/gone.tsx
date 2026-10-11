import Link from "next/link";
import { Leaf } from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

export function Gone({
  reason,
  kind = "paste",
}: {
  reason: "expired" | "missing" | "burned";
  kind?: "paste" | "link";
}) {
  const lines: Record<typeof reason, { head: string; body: string }> = {
    expired: {
      head: "This one has faded.",
      body: `Every ${kind} on Slip expires, and this one's time ran out. Ask the sender to seal a new one.`,
    },
    missing: {
      head: "Nothing by that name.",
      body: `No ${kind} ever lived here — or it's already gone. Check the link for typos.`,
    },
    burned: {
      head: "It kept its promise.",
      body: `This ${kind} was marked burn-after-reading, and it's already been read once.`,
    },
  };
  const { head, body } = lines[reason];

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader compact />
      <main className="flex flex-1 items-center justify-center px-6">
        <div className="rise-in -mt-16 max-w-md text-center">
          <Leaf
            className="mx-auto mb-6 size-6 text-ink-3"
            strokeWidth={1.25}
            aria-hidden
          />
          <h1 className="font-display-it text-4xl tracking-tight text-ink">{head}</h1>
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-2">{body}</p>
          <Link
            href="/"
            className="mt-8 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong"
          >
            {kind === "paste" ? "Write a new slip" : "Make a new link"}
          </Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
