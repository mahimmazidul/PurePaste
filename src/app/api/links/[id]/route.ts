import { NextResponse } from "next/server";
import { deleteLink, getLiveLink, toLinkPayload } from "@/lib/links";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const row = await getLiveLink(id);
  if (!row) {
    return NextResponse.json(
      { error: "Nothing lives at this address anymore." },
      { status: 404 },
    );
  }
  const payload = toLinkPayload(row);
  const { url: _url, ...meta } = payload; // destination only via /reveal
  return NextResponse.json(meta);
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  let token = request.headers.get("x-manage-token") ?? "";
  if (!token) {
    try {
      const body = (await request.json()) as { manageToken?: string };
      token = body.manageToken ?? "";
    } catch {
      /* no body */
    }
  }

  const ok = await deleteLink(id, token);
  if (!ok) {
    return NextResponse.json(
      { error: "That manage token doesn't match this link." },
      { status: 403 },
    );
  }
  return NextResponse.json({ ok: true });
}
