import { NextResponse } from "next/server";
import { createPaste } from "@/lib/pastes";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send JSON, please." }, { status: 400 });
  }

  const result = await createPaste((body ?? {}) as Parameters<typeof createPaste>[0]);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(
    { id: result.id, manageToken: result.manageToken, expiresAt: result.expiresAt },
    { status: 201 },
  );
}
