// app/openai_agent_run/route.ts
import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";

/**
 * POST /openai_agent_run
 * Body: { question: string; chatId?: string; version?: string; vectorStoreId?: string }
 * Returns: { responseId: string }
 *
 * Notes:
 * - Uses Responses API with File Search and background mode.
 * - Picks the vector store by `version` (preferred) or falls back to `vectorStoreId` from the body.
 * - Make sure your Project has a webhook configured for `response.completed`.
 */

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Map One Identity Manager versions → vector store IDs (set these in your env)
const VERSION_MAP: Record<string, { vectorStoreId: string; instructions?: string }> = {
  "9.2.1": {
    vectorStoreId: process.env.VECTOR_STORE_921!, // e.g., vs_abc123
    instructions: "Answer only from One Identity Manager 9.2.1 manuals. Include short citations.",
  },
  "9.3.0": {
    vectorStoreId: process.env.VECTOR_STORE_930!,
    instructions: "Answer only from One Identity Manager 9.3.0 manuals. Include short citations.",
  },
  "9.4.0": {
    vectorStoreId: process.env.VECTOR_STORE_940!,
    instructions: "Answer only from One Identity Manager 9.4.0 manuals. Include short citations.",
  },
};

// Default instructions if none provided above
const DEFAULT_INSTRUCTIONS =
  "Answer only from the attached files. If the answer is not present, say you don't know. Include short citations.";

type RunBody = {
  question: string;
  chatId?: string;
  version?: string;          // from the dropdown
  vectorStoreId?: string;    // legacy/manual override
};

export async function POST(req: NextRequest) {
  let body: RunBody;
  try {
    body = await req.json();
  } catch {
    return new NextResponse("Invalid JSON body", { status: 400 });
  }

  const { question, chatId, version, vectorStoreId } = body || {};

  if (!question || typeof question !== "string" || !question.trim()) {
    return new NextResponse("Missing 'question'", { status: 400 });
  }

  // Prefer version mapping; allow explicit vectorStoreId override for backward compat
  const versionCfg = version ? VERSION_MAP[version] : undefined;
  const storeId = versionCfg?.vectorStoreId || vectorStoreId;

  if (!storeId) {
    return new NextResponse(
      "No vector store configured. Provide 'version' that maps to a vector store, or pass 'vectorStoreId' explicitly.",
      { status: 400 }
    );
  }

  // Build instructions (version-specific if provided)
  const instructions = versionCfg?.instructions ?? DEFAULT_INSTRUCTIONS;

  try {
    const response = await client.responses.create({
      model: "gpt-4.1", // pick your model (e.g., "gpt-5.1" or "gpt-4o-mini" for cost/latency)
      instructions,
      input: question,
      tools: [
        {
          type: "file_search",
          // Your SDK expects inline vector store IDs on the tool
          vector_store_ids: [storeId],
        },
      ],
      background: true, // async job → your webhook will receive response.completed
      metadata: {
        chatId: chatId ?? crypto.randomUUID(),
        version: version ?? "unspecified",
      },
    });

    // Return the response id so the client can poll /webhooks_openai
    return NextResponse.json({ responseId: response.id });
  } catch (e: any) {
    console.error("[openai_agent_run] create failed:", e?.message || e);
    return new NextResponse(`OpenAI error: ${e?.message ?? "unknown error"}`, { status: 500 });
  }
}
