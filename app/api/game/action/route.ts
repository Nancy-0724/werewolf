import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { submitWebAction } from "@/src/web/server/gameApp";
import { apiError } from "@/src/web/server/http";
import { verifyWebSessionToken, WEB_SESSION_COOKIE } from "@/src/web/server/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const store = await cookies();
    const session = verifyWebSessionToken(store.get(WEB_SESSION_COOKIE)?.value);
    if (!session) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "No active game session" } }, { status: 401 });
    const body: unknown = await request.json();
    return NextResponse.json(await submitWebAction(session.gameId, session.playerId, body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const failure = apiError(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
