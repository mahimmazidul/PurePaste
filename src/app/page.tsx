import { EyeOff, Hourglass, KeyRound } from "lucide-react";
import { Composer } from "@/components/composer";
import { LocalList } from "@/components/local-list";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

const PRINCIPLES = [
  {
    Icon: Hourglass,
    title: "Always expiring",
    body: "Choose an hour or a month. Nothing lingers past its welcome, and the clearing is automatic.",
  },
  {
    Icon: EyeOff,
    title: "Unlisted by design",
    body: "There's no directory, no search, no recent list. The link is the only way in — share it like a secret.",
  },
  {
    Icon: KeyRound,
    title: "You hold the key",
    body: "Passwords when you need them, burn-after-reading when once is enough, and a delete key that stays on your device.",
  },
];

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6">
        {/* hero */}
        <section className="rise-in pt-14 sm:pt-20">
          <p className="smallcaps text-accent">A pastebin, softened</p>
          <h1 className="mt-4 font-display text-[2.5rem] leading-[1.1] tracking-tight text-ink sm:text-[3.25rem]">
            A quiet place for <span className="font-display-it">text</span>.
          </h1>
          <p className="mt-5 max-w-xl text-[1.0625rem] leading-relaxed text-ink-2">
            Paste code, notes or prose — or shorten a link that shows its destination
            first. Every slip expires, nothing is indexed, and no account stands
            between you and the paper.
          </p>
        </section>

        <div className="mt-10">
          <Composer />
        </div>

        <LocalList />

        {/* principles */}
        <section className="mt-20">
          <div className="grid gap-x-10 gap-y-8 border-t border-line pt-10 sm:grid-cols-3">
            {PRINCIPLES.map(({ Icon, title, body }, i) => (
              <div key={title} className={`rise-in rise-in-${i + 1}`}>
                <Icon className="size-[18px] text-accent" strokeWidth={1.5} />
                <h3 className="mt-3 text-[0.9375rem] font-medium text-ink">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
