// app/api/ai/result/route.ts
import { NextRequest, NextResponse } from "next/server";

const N8N_RESULT_URL = process.env.N8N_RESULT_URL;
const HDR_NAME = process.env.N8N_AUTH_HEADER_NAME || "";
const HDR_VALUE = process.env.N8N_AUTH_HEADER_VALUE || "";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

// Optional: make sure Next doesn’t cache this route
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return bad("missing id", 400);
  if (!N8N_RESULT_URL) return bad("server missing N8N_RESULT_URL", 500);

  const headers: Record<string, string> = {};
  if (HDR_NAME && HDR_VALUE) headers[HDR_NAME] = HDR_VALUE;

  // Backoff schedule (ms). Adjust as you like.
  const tries = [70000, 40000, 15000];

  for (let i = 0; i < tries.length; i++) {
    // Sleep before each try (including first)
    const wait = tries[i];
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    let res: Response;
    try {
      const url = new URL(N8N_RESULT_URL);
      url.searchParams.set("id", id);
      res = await fetch(url.toString(), { method: "GET", headers });
    } catch (e: any) {
      if (i === tries.length - 1) {
        return bad(`n8n result failed: ${e?.message ?? String(e)}`, 502);
      }
      continue;
    }

    const ct = res.headers.get("content-type") || "";
    let body: any = null;
    try {
      body = ct.includes("application/json") ? await res.json() : await res.text();
    } catch {
      // ignore parse error; body stays null
    }

    // 404 → not ready yet, keep retrying (unless last try)
    if (res.status === 404 && i < tries.length - 1) {
      continue;
    }

    // Forward whatever we got from n8n
    if (!res.ok) {
      const msg =
        typeof body === "string"
          ? body
          : body?.error || `n8n result returned ${res.status}`;
      return bad(msg, res.status);
    }

    // Expect final JSON with { result, tests, ... }, but be tolerant
    return NextResponse.json(
      typeof body === "object" ? body : { ok: true, result: String(body ?? "") }
    );
  }

  // Should not reach here normally
  return bad("result not ready", 504);
}
