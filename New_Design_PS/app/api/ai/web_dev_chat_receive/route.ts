import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge"; // or "nodejs"

/**
 * Polls your n8n POLL webhook for completion.
 * Env: N8N_POLL_WEBHOOK_URL
 * Accepts: GET /api/chat/poll?id=REQUEST_ID
 * Responses mapping:
 *  - 204 => pending
 *  - { status: "pending" } => pending
 *  - { status: "complete", reply } => complete
 *  - text/plain => complete with text
 */
export async function GET(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const urlBase = process.env.N8N_POLL_WEBHOOK_URL;
    if (!urlBase) return NextResponse.json({ error: "N8N_POLL_WEBHOOK_URL not set" }, { status: 500 });

    // You can choose GET with query or POST with JSON depending on your n8n flow
    const pollUrl = urlBase.includes("?") ? `${urlBase}&id=${encodeURIComponent(id)}` : `${urlBase}?id=${encodeURIComponent(id)}`;
    const n8nRes = await fetch(pollUrl, { method: "GET" });

    if (n8nRes.status === 204) {
      return new NextResponse(null, { status: 204 }); // pending
    }

    const ct = n8nRes.headers.get("content-type") || "";
    if (!n8nRes.ok) {
      const body = await n8nRes.text().catch(() => "");
      return NextResponse.json({ error: `n8n poll failed: ${n8nRes.status} ${body}` }, { status: 502 });
    }

    if (ct.includes("application/json")) {
      const data = await n8nRes.json();
      if (data?.status === "pending") return new NextResponse(null, { status: 204 });
      if (data?.status === "complete" && typeof data.reply === "string") return NextResponse.json({ reply: data.reply });
      if (typeof data.reply === "string") return NextResponse.json({ reply: data.reply });
      // Unknown JSON => treat as pending
      return new NextResponse(null, { status: 204 });
    }

    const text = await n8nRes.text();
    if (!text) return new NextResponse(null, { status: 204 });
    return NextResponse.json({ reply: text });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unexpected error" }, { status: 500 });
  }
}


// ==============================
// Optional: .env.local example
// ==============================
// N8N_SEND_WEBHOOK_URL="https://your-n8n.example/webhook/one-identity-send"
// N8N_POLL_WEBHOOK_URL="https://your-n8n.example/webhook/one-identity-receive"
