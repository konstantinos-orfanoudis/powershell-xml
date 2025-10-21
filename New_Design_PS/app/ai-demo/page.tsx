/* app/ai-demo/page.tsx */
"use client";

import React, { useCallback, useRef, useState } from "react";

type SubmitResp = { ok?: boolean; request_id?: string; error?: string };
type ResultResp =
  | { ok: true; result?: string; filename?: string; status?: string }
  | { ok: false; error?: string; pending?: boolean; status?: string };

export default function AIDemoPage() {
  const [psText, setPsText] = useState<string>("");
  const [filename, setFilename] = useState<string>("powershell-prototypes.ps1");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const abortRef = useRef<AbortController | null>(null);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const pollResult = useCallback(
    async (requestId: string) => {
      // Client-side light polling. The server route already has a backoff,
      // but we keep polling here until it returns final 200 with result.
      // First poll after 7s, then every 3s up to ~25s total.
      const delays = [0, 3000, 3000, 3000, 3000, 3000]; // after initial server backoff
      const controller = abortRef.current ?? new AbortController();

      for (let i = 0; i < delays.length; i++) {
        if (delays[i] > 0) await sleep(delays[i]);
        setStatus(i === 0 ? "Waiting for result…" : "Still processing…");

        let res: Response;
        try {
          const url = `/api/ai/result?id=${encodeURIComponent(requestId)}`;
          res = await fetch(url, {
            method: "GET",
            signal: controller.signal,
          });
        } catch (e: any) {
          if (controller.signal.aborted) throw new Error("aborted");
          throw new Error(e?.message || String(e));
        }

        // 202 => pending; keep looping
        if (res.status === 202) continue;

        const ct = res.headers.get("content-type") || "";
        const body: ResultResp = ct.includes("application/json")
          ? await res.json()
          : ({ ok: true, result: await res.text() } as any);

        if (!res.ok) {
          // bubble up the error
          throw new Error(
            (body as any)?.error || `Result endpoint returned ${res.status}`
          );
        }

        // Success (should carry { ok:true, result })
        if ("ok" in body && body.ok) {
          setStatus(body.status || "done");
          setResult(body.result || "");
          if (body.filename) setFilename(body.filename);
          return;
        }

        // Unexpected but tolerated: keep trying if pending flag set
        if ((body as any)?.pending) continue;

        throw new Error("Invalid result payload");
      }

      // Timed out polling
      throw new Error("Result not ready yet (timeout). Try again shortly.");
    },
    []
  );

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError("");
      setResult("");
      setStatus("Submitting…");
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // Send the raw PS text to our submit endpoint
        const resp = await fetch("/api/ai/submit", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Filename": filename || "powershell-prototypes.ps1",
          },
          body: psText,
          signal: controller.signal,
        });

        const ct = resp.headers.get("content-type") || "";
        const body: SubmitResp = ct.includes("application/json")
          ? await resp.json()
          : ({} as any);

        if (!resp.ok) {
          throw new Error(
            body?.error || `Submit failed with status ${resp.status}`
          );
        }

        const requestId =
          body?.request_id || (body as any)?.id || (body as any)?.requestId;
        if (!requestId) {
          throw new Error("Submit returned unexpected payload");
        }

        // Poll for the final result
        await pollResult(requestId);
      } catch (err: any) {
        if (err?.message === "aborted") {
          setError("Request canceled.");
        } else {
          setError(err?.message || String(err));
        }
        setStatus("error");
      } finally {
        setBusy(false);
      }
    },
    [filename, psText, pollResult]
  );

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
    setStatus("canceled");
  }, []);

  return (
    <main className="mx-auto max-w-4xl p-4 space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">AI Demo</h1>

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-700 w-28">Filename</label>
          <input
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="powershell-prototypes.ps1"
          />
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">
            PowerShell (input)
          </label>
          <textarea
            className="w-full h-40 rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
            placeholder="# paste your generated PowerShell here"
            value={psText}
            onChange={(e) => setPsText(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy || !psText.trim()}
            className={`rounded-md px-3 py-2 text-sm text-white ${
              busy ? "bg-slate-400" : "bg-indigo-600 hover:bg-indigo-700"
            }`}
          >
            {busy ? "Working…" : "Generate via n8n"}
          </button>
          {busy && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"
            >
              Cancel
            </button>
          )}
          <span className="text-sm text-slate-500">{status}</span>
        </div>
      </form>

      {/* RESULT ONLY */}
      {result && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="px-4 py-2 border-b border-slate-100 flex items-center justify-between">
            <div className="text-sm text-slate-700">
              Result {filename ? `— ${filename}` : ""}
            </div>
            <button
              type="button"
              className="text-xs text-slate-600 hover:text-slate-900"
              onClick={() => {
                void navigator.clipboard.writeText(result);
              }}
            >
              Copy
            </button>
          </div>
          <pre className="p-4 overflow-auto text-sm leading-relaxed">
            <code>{result}</code>
          </pre>
        </section>
      )}

      {/* ERROR (compact) */}
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}
    </main>
  );
}
