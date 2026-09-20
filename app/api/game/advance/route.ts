import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { advanceWebGame } from "@/src/web/server/gameApp";
import { apiError } from "@/src/web/server/http";
import { verifyWebSessionToken, WEB_SESSION_COOKIE } from "@/src/web/server/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  try {
    const store = await cookies();
    const session = verifyWebSessionToken(store.get(WEB_SESSION_COOKIE)?.value);
    if (!session) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "No active game session" } }, { status: 401 });
    return NextResponse.json(await advanceWebGame(session.gameId, session.playerId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const failure = apiError(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
