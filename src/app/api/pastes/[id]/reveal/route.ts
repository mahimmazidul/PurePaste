import { NextResponse } from "next/server";
import { revealPaste } from "@/lib/pastes";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  let password: string | undefined;
  try {
    const body = (await request.json()) as { password?: string };
    password = body.password;
  } catch {
    /* body optional */
  }

  const result = await revealPaste(id, password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ paste: result.payload });
}
