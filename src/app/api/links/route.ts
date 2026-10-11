import { NextResponse } from "next/server";
import { createLink } from "@/lib/links";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send JSON, please." }, { status: 400 });
  }

  const result = await createLink((body ?? {}) as Parameters<typeof createLink>[0]);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(
    { id: result.id, manageToken: result.manageToken, expiresAt: result.expiresAt },
    { status: 201 },
  );
}
