import { NextResponse } from "next/server";
import { visitLink } from "@/lib/links";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const payload = await visitLink(id);
  if (!payload) {
    return NextResponse.json(
      { error: "Nothing lives at this address anymore." },
      { status: 404 },
    );
  }
  return NextResponse.json({ link: payload });
}
