// app/api/ai/result/route.ts
import { NextRequest, NextResponse } from "next/server";

const N8N_RESULT_FILES_URL = process.env.N8N_RESULT_FILES_URL!; // e.g. https://.../webhook/get-schema
const HDR_NAME = process.env.N8N_AUTH_HEADER_NAME;
const HDR_VALUE = process.env.N8N_AUTH_HEADER_VALUE;

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function GET(req: NextRequest) {
  if (!N8N_RESULT_FILES_URL) return bad("server missing N8N_RESULT_URL", 500);

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return bad("missing ?id=<request_id>");

  const url = new URL(N8N_RESULT_FILES_URL);
  url.searchParams.set("id", id);

  const headers: Record<string, string> = {};
  if (HDR_NAME && HDR_VALUE) headers[HDR_NAME] = HDR_VALUE;

  try {
    const res = await fetch(url.toString(), { method: "GET", headers });

    // Pass through common “not ready yet” statuses so the client knows to retry
    if (res.status === 404 || res.status === 204 || res.status === 202) {
      return NextResponse.json({ ok: false, notReady: true }, { status: 200 });
    }

    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("application/json") ? await res.json() : await res.text();

    if (!res.ok) {
      const msg = typeof body === "string" ? body.slice(0, 200) : body?.error || res.statusText;
      return NextResponse.json({ ok: false, error: msg }, { status: res.status });
    }

    // Expect the schema directly or under a field
    const result =
      (body && body.result_json) ?? body.schema ?? body.data ?? body;

    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (e: any) {
    return bad(e?.message || "result fetch failed", 502);
  }
}
