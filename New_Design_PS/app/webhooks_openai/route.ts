// app/webhooks_openai/route.ts
import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";

type RecordT = {
  chatId?: string;
  status: "completed" | "failed";
  text?: string;
  error?: string;
};
const g = globalThis as unknown as { __openaiStore?: Map<string, RecordT> };
if (!g.__openaiStore) g.__openaiStore = new Map<string, RecordT>();
const store = g.__openaiStore;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  webhookSecret: process.env.OPENAI_WEBHOOK_SECRET!,
});

// Extract text from any Response shape
function extractText(res: any): string {
  if (typeof res?.output_text === "string" && res.output_text.trim()) {
    return res.output_text.trim();
  }
  const out: string[] = [];
  const items: any[] = Array.isArray(res?.output) ? res.output : [];
  for (const item of items) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        const v =
          c?.text?.value ??
          (typeof c?.text === "string" ? c.text : undefined);
        if (typeof v === "string" && v.trim()) out.push(v.trim());
      }
    }
    if (item?.type === "output_text") {
      const v =
        item?.text?.value ??
        (typeof item?.text === "string" ? item.text : undefined);
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
    if (item?.type === "tool_output") {
      const v =
        item?.content?.text?.value ??
        item?.text?.value ??
        (typeof item?.text === "string" ? item.text : undefined);
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }
  return out.join("\n\n").trim();
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const headersRecord = Object.fromEntries(req.headers);

  let event: Awaited<ReturnType<typeof client.webhooks.unwrap>>;
  try {
    event = await client.webhooks.unwrap(raw, headersRecord);
  } catch (e) {
    console.error("[webhook] signature error", e);
    return new NextResponse("Invalid signature", { status: 400 });
  }

  if (event.type === "response.completed") {
    const res: any = event.data;
    const responseId: string = res.id;
    const chatId = res?.metadata?.chatId as string | undefined;

    let text = extractText(res);

    // 👇 Fallback: fetch the full object if webhook payload is thin
    if (!text) {
      try {
        const full = await client.responses.retrieve(responseId);
        text = extractText(full as any);
        console.log("[webhook] fallback retrieve used", {
          responseId,
          hadTextInitially: false,
          gotText: !!text,
        });
      } catch (e) {
        console.warn("[webhook] retrieve failed", { responseId, e });
      }
    }

    store.set(responseId, { chatId, status: "completed", text });
    console.log("[webhook] completed", {
      responseId,
      preview: (text ?? "").slice(0, 120),
    });
    return NextResponse.json({ ok: true });
  }

  if (event.type === "response.failed") {
    const res: any = event.data;
    const responseId: string = res.id;
    const chatId = res?.metadata?.chatId as string | undefined;
    store.set(responseId, { chatId, status: "failed", error: "response.failed" });
    console.log("[webhook] failed", { responseId });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}

/**
 * GET /webhooks_openai?responseId=resp_123
 * 204 if not ready; 200 with {status,text|error} when ready.
 * Also falls back to retrieve() if the stored record exists but has empty text.
 */
export async function GET(req: NextRequest) {
  const responseId = new URL(req.url).searchParams.get("responseId") ?? "";
  if (!responseId) return new NextResponse("Missing responseId", { status: 400 });

  const record = store.get(responseId);

  // If we already have a non-empty text or a failure, return it
  if (record && (record.text || record.status === "failed")) {
    return NextResponse.json(record);
  }

  // Fallback: try fetching from API (helps across instances or thin webhook payloads)
  try {
    const full = await client.responses.retrieve(responseId);
    const text = extractText(full as any);
    if (text) {
      const cached: RecordT = { status: "completed", text };
      store.set(responseId, cached);
      return NextResponse.json(cached);
    }
  } catch {
    // ignore; not ready yet
  }

  return new NextResponse(null, { status: 204 });
}
