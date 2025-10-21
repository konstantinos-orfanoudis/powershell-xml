// app/api/ai/receive/route.ts
import { NextRequest, NextResponse } from "next/server";
import { putResult } from "../../../../lib/resultbus";

function bad(msg: string, status = 400) {
  return new NextResponse(JSON.stringify({ error: msg }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return bad("invalid json", 400);
  }

  const id = body?.id || body?.request_id || body?.requestId;
  if (!id) return bad("missing id", 400);

  // Store the WHOLE payload; the /result route will return it as-is
  putResult(String(id), body);

  return NextResponse.json({ ok: true });
}
