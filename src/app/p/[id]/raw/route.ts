import { getLivePaste } from "@/lib/pastes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const row = await getLivePaste(id);

  if (!row) {
    return new Response("Nothing lives at this address anymore.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Raw stays honest: locked or burnable slips don't slip out the side door.
  if (row.passwordHash || row.burn) {
    return new Response("This slip is sealed — open it at its page instead.\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(row.content, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
