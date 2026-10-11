import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { lt } from "drizzle-orm";
import { db } from "@/db";
import { links } from "@/db/schema";
import { Gone } from "@/components/gone";
import { LinkInterstitial } from "@/components/link-interstitial";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { getLinkRow } from "@/lib/links";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "A short hop",
    robots: { index: false, follow: false },
  };
}

export default async function LinkPage({ params }: Props) {
  const { id } = await params;
  const row = await getLinkRow(id);

  if (!row) {
    notFound();
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(links).where(lt(links.expiresAt, new Date())).catch(() => {});
    return <Gone reason="expired" kind="link" />;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader compact />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6">
        <LinkInterstitial
          id={row.id}
          url={row.burn ? null : row.url}
          burn={row.burn}
          visits={row.visits}
          expiresAt={row.expiresAt.toISOString()}
        />
      </main>
      <SiteFooter />
    </div>
  );
}
