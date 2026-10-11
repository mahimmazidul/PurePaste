import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { lt } from "drizzle-orm";
import { db } from "@/db";
import { pastes } from "@/db/schema";
import { PasteGate } from "@/components/gates";
import { Gone } from "@/components/gone";
import { PasteView } from "@/components/paste-view";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { countView, getPasteRow, toPastePayload } from "@/lib/pastes";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "A slip",
    robots: { index: false, follow: false },
  };
}

export default async function PastePage({ params }: Props) {
  const { id } = await params;
  const row = await getPasteRow(id);

  if (!row) {
    notFound();
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(pastes).where(lt(pastes.expiresAt, new Date())).catch(() => {});
    return <Gone reason="expired" />;
  }

  const gated = Boolean(row.passwordHash) || row.burn;

  if (!gated) {
    await countView(row.id);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader compact />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pt-10 sm:pt-14">
        {gated ? (
          <PasteGate
            id={row.id}
            needsPassword={Boolean(row.passwordHash)}
            burn={row.burn}
            expiresAt={row.expiresAt.toISOString()}
          />
        ) : (
          <PasteView paste={toPastePayload({ ...row, views: row.views + 1 })} />
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
