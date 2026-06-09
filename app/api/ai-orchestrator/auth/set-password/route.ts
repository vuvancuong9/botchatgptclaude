import { NextRequest, NextResponse } from "next/server";
import { guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { setPasswordForContext } from "@/lib/ai-orchestrator/auth/login-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 10 — set/reset a password. A user can set their own; owner/admin can set
 * anyone's (pass userId). Requires a valid API key. Never logs the password.
 */
export async function POST(req: NextRequest) {
  const gate = await guardRequest(req);
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const password = (body as { password?: unknown })?.password;
  const userId = (body as { userId?: unknown })?.userId;
  const targetUserId =
    typeof userId === "string" && userId ? userId : gate.context.userId;

  if (!targetUserId) {
    return NextResponse.json(
      { error: "userId là bắt buộc (legacy admin không có user để đặt mật khẩu)." },
      { status: 400 },
    );
  }
  if (typeof password !== "string") {
    return NextResponse.json({ error: "password là bắt buộc" }, { status: 400 });
  }

  const result = await setPasswordForContext(
    gate.context,
    targetUserId,
    password,
  );
  if (!result.ok) {
    const status = result.error?.includes("quyền") ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
