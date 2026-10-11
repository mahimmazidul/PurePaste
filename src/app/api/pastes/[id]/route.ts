import { NextResponse } from "next/server";
import { deletePaste, getLivePaste, toPastePayload } from "@/lib/pastes";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const row = await getLivePaste(id);

  if (!row) {
    return NextResponse.json(
      { error: "Nothing lives at this address anymore." },
      { status: 404 },
    );
  }

  const payload = toPastePayload(row);

  // Protected or burn slips never leak content through plain GET.
  if (row.passwordHash || row.burn) {
    const { content: _content, ...meta } = payload;
    return NextResponse.json({ ...meta, protected: Boolean(row.passwordHash) });
  }

  return NextResponse.json({ ...payload, protected: false });
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

  const ok = await deletePaste(id, token);
  if (!ok) {
    return NextResponse.json(
      { error: "That manage token doesn't match this slip." },
      { status: 403 },
    );
  }
  return NextResponse.json({ ok: true });
}
