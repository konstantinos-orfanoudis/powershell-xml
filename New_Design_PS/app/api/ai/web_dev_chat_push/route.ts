// ==============================
// File: app/api/chat/send/route.ts
// ==============================
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge"; // or "nodejs" if you need node APIs

/**
 * Forwards the user's message/history to your n8n SEND webhook.
 * Env: N8N_SEND_WEBHOOK_URL
 * Expected response: { requestId: string } | string | text/plain
 */
export async function POST(req: NextRequest) {
  try {
    const { message, history } = await req.json();
    if (!message) return NextResponse.json({ error: "Missing message" }, { status: 400 });

    const url = process.env.N8N_SEND_WEBHOOK_URL;
    if (!url) return NextResponse.json({ error: "N8N_SEND_WEBHOOK_URL not set" }, { status: 500 });

    const n8nRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });

    const ct = n8nRes.headers.get("content-type") || "";
    if (!n8nRes.ok) {
      const body = await n8nRes.text().catch(() => "");
      return NextResponse.json({ error: `n8n send failed: ${n8nRes.status} ${body}` }, { status: 502 });
    }

    if (ct.includes("application/json")) {
      const data = await n8nRes.json();
      const requestId = typeof data === "string" ? data : data.requestId || data.id || data.jobId;
      if (!requestId) return NextResponse.json({ error: "Missing requestId from n8n" }, { status: 502 });
      return NextResponse.json({ requestId });
    }

    // text/plain fallback
    const text = await n8nRes.text();
    if (!text) return NextResponse.json({ error: "Empty response from n8n" }, { status: 502 });
    return NextResponse.json({ requestId: text });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unexpected error" }, { status: 500 });
  }
}
