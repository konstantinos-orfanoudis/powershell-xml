// app/ask/page.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "submitting" | "waiting" | "done" | "error";

// Adjust/extend as you like
const VERSIONS = [
  { value: "9.2.1", label: "One Identity Manager 9.2.1" },
  { value: "9.3.0", label: "One Identity Manager 9.3.0" },
  { value: "9.4.0", label: "One Identity Manager 9.4.0" },
];

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [version, setVersion] = useState(VERSIONS[0].value);
  const [status, setStatus] = useState<Status>("idle");
  const [answer, setAnswer] = useState<string>("");
  const [responseId, setResponseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Abort polling when navigating away or resubmitting
  const abortRef = useRef<AbortController | null>(null);

  const startPolling = useCallback(async (rid: string) => {
    setStatus("waiting");
    setAnswer("");
    setError(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let tries = 0;
    const maxTries = 60;
    let delay = 2000;
    const maxDelay = 5000;

    while (!controller.signal.aborted && tries < maxTries) {
      tries += 1;
      try {
        const res = await fetch(`/webhooks_openai?responseId=${encodeURIComponent(rid)}`, {
          signal: controller.signal,
          headers: { "cache-control": "no-store" },
        });

        if (res.status === 204) {
          // not ready yet
        } else if (res.ok) {
          const data: { status: "completed" | "failed"; text?: string; error?: string } = await res.json();
          if (data.status === "completed") {
            setAnswer(data.text ?? "");
            setStatus("done");
            return;
          } else {
            setError(data.error ?? "Agent run failed");
            setStatus("error");
            return;
          }
        } else {
          setError(`Polling error: ${res.status} ${res.statusText}`);
          setStatus("error");
          return;
        }
      } catch (e: any) {
        if (controller.signal.aborted) return;
        setError(e?.message ?? "Network error during polling");
        setStatus("error");
        return;
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(maxDelay, Math.floor(delay * 1.2));
    }

    if (!controller.signal.aborted && tries >= maxTries) {
      setError("Timed out waiting for result.");
      setStatus("error");
    }
  }, []);

  const onSubmit = useCallback(async () => {
    setStatus("submitting");
    setAnswer("");
    setError(null);
    setResponseId(null);

    const chatId = crypto.randomUUID();

    // Optional: keep this if your current backend still needs it.
    // If your backend maps version -> vector store, you can remove it.
    const vectorStoreId = process.env.NEXT_PUBLIC_VECTOR_STORE_ID;

    try {
      const body: any = { question, chatId, version };
      if (vectorStoreId) body.vectorStoreId = vectorStoreId;

      const r = await fetch("/openai_agent_run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Start job failed: ${r.status} ${t}`);
      }
      const { responseId } = await r.json();
      setResponseId(responseId);
      startPolling(responseId);
    } catch (e: any) {
      setStatus("error");
      setError(e?.message ?? "Failed to start job");
    }
  }, [question, version, startPolling]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return (
    <main className="mx-auto max-w-2xl p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Ask One Identity (Docs-Grounded)</h1>

      <div className="space-y-2">
        <label className="block text-sm font-medium">Version</label>
        <select
          className="border rounded p-2"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
        >
          {VERSIONS.map(v => (
            <option key={v.value} value={v.value}>{v.label}</option>
          ))}
        </select>

        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Type your question…"
          className="w-full min-h-[120px] border rounded p-3"
        />

        <div className="flex items-center gap-2">
          <button
            onClick={onSubmit}
            disabled={!question.trim() || status === "submitting" || status === "waiting"}
            className="px-4 py-2 border rounded disabled:opacity-50"
          >
            {status === "submitting" ? "Submitting…" : status === "waiting" ? "Waiting…" : "Ask"}
          </button>
          {responseId && (
            <span className="text-xs text-gray-500">responseId: {responseId}</span>
          )}
        </div>
      </div>

      {status === "waiting" && (
        <p className="text-sm text-gray-600">Processing…</p>
      )}

      {status === "done" && (
        <section className="rounded border p-3 bg-white">
          <h2 className="font-medium mb-2">Answer (v{version})</h2>
          <pre className="whitespace-pre-wrap break-words">{answer}</pre>
        </section>
      )}

      {status === "error" && (
        <section className="rounded border p-3 bg-red-50">
          <h2 className="font-medium mb-2 text-red-700">Error</h2>
          <pre className="whitespace-pre-wrap break-words text-red-700">{error}</pre>
        </section>
      )}

      <footer className="text-xs text-gray-500 pt-4">
        Uses async Responses + project webhooks. Server picks vector store/assistant based on <code>version</code>.
      </footer>
    </main>
  );
}
