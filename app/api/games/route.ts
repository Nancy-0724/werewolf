import { NextResponse } from "next/server";
import { apiError } from "@/src/web/server/http";
import { createWebGame } from "@/src/web/server/gameApp";
import { assertWebSessionConfigured, createWebSessionToken, WEB_SESSION_COOKIE, WEB_SESSION_MAX_AGE_SECONDS } from "@/src/web/server/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertWebSessionConfigured();
    const input: unknown = await request.json();
    const created = await createWebGame(input);
    const response = NextResponse.json({ gameId: created.gameId, envelope: created.envelope }, { status: 201 });
    response.cookies.set(WEB_SESSION_COOKIE, createWebSessionToken(created.gameId, created.playerId), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: WEB_SESSION_MAX_AGE_SECONDS,
    });
    return response;
  } catch (error) {
    const failure = apiError(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
