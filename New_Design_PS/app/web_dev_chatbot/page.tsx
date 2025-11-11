// ==============================
// File: app/(pages)/one-identity-chat/page.tsx
// ==============================
"use client";
import React, { useEffect, useRef, useState } from "react";
import { Send, Bot, User, Loader2, Eraser, Settings, Link } from "lucide-react";
import ReactMarkdown from "react-markdown";

// --- Types ---
type Role = "user" | "assistant" | "system" | "error";

interface Message {
  id: string;
  role: Role;
  content: string;
  ts: number;
}

/**
 * One Identity Dev Chat – TSX page using two internal API routes that forward to n8n.
 * This is a Client Component page; it does not accept Next.js PageProps or custom Props.
 */
export default function OneIdentityDevChatPage() {
  const title = "One Identity Web Dev Chat";
  const pollIntervalMs = 1000;
  const maxWaitMs = 45_000;

  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const cached = localStorage.getItem("oi_chat_messages");
      if (cached) return JSON.parse(cached);
    } catch {}
    // Use stable, deterministic initial message to avoid SSR/client mismatch
    return [
      {
        id: "welcome",
        role: "assistant",
        content:
          "Hi! I’m your One Identity web development helper.",
        ts: 0, // render time only after mount
      },
    ];
  });
  const [input, setInput] = useState("");
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem("oi_chat_messages", JSON.stringify(messages));
    } catch {}
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Mark mounted to safely render time-only-on-client
  useEffect(() => {
    setMounted(true);
  }, []);

  const clearChat = () => {
    setMessages([]);
    setError(null);
    setTimeout(() => {
      setMessages([
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Cleared! How can I help with One Identity today?",
          ts: Date.now(),
        },
      ]);
    }, 50);
  };

  // --- Backend glue (internal Next.js routes) ---
  const sendToBackend = async (text: string, history: { role: "user" | "assistant"; content: string }[]) => {
    const res = await fetch("/api/ai/web_dev_chat_push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history }),
    });
    if (!res.ok) throw new Error(`Send route failed: ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await res.json();
      const id = typeof data === "string" ? data : data.requestId || data.id || data.jobId;
      if (!id) throw new Error("Missing requestId from /api/chat/send");
      return String(id);
    }
    // text fallback
    const id = await res.text();
    if (!id) throw new Error("Missing requestId from /api/chat/send (text)");
    return id;
  };

  const pollBackend = async (id: string) => {
    const res = await fetch(`/api/ai/web_dev_chat_receive?id=${encodeURIComponent(id)}`, { method: "GET" });
    if (res.status === 204) return { pending: true } as const;
    if (!res.ok) throw new Error(`Poll route failed: ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await res.json();
      if (data?.status === "pending") return { pending: true } as const;
      if (data?.status === "complete" && typeof data.reply === "string") return { pending: false, reply: data.reply } as const;
      if (typeof data.reply === "string") return { pending: false, reply: data.reply } as const;
      // Unknown JSON => treat as pending
      return { pending: true } as const;
    }
    const text = await res.text();
    if (!text) return { pending: true } as const;
    return { pending: false, reply: text } as const;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setError(null);

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: trimmed, ts: Date.now() };
    setMessages((cur) => [...cur, userMsg]);
    setInput("");
    setLoading(true);

    try {
      // Build compact history
      const history = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-10)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const requestId = await sendToBackend(trimmed, history);

      // Add a placeholder assistant message we will replace later
      const placeholderId = crypto.randomUUID();
      setMessages((cur) => [
        ...cur,
        { id: placeholderId, role: "assistant", content: "…", ts: Date.now() },
      ]);

      // Polling loop with basic backoff
      const started = Date.now();
      let wait = pollIntervalMs;
      while (Date.now() - started < maxWaitMs) {
        const result = await pollBackend(requestId);
        if (!result.pending) {
          setMessages((cur) =>
            cur.map((m) => (m.id === placeholderId ? { ...m, content: result.reply, ts: Date.now() } : m))
          );
          setLoading(false);
          inputRef.current?.focus();
          return;
        }
        await new Promise((r) => setTimeout(r, wait));
        // gentle backoff up to 3s
        wait = Math.min(wait + 300, 3000);
      }
      // Timeout -> convert placeholder to error
      setMessages((cur) =>
        cur.map((m) => (m.role === "assistant" && m.content === "…" ? { ...m, role: "error", content: "Timed out waiting for reply.", ts: Date.now() } : m))
      );
      setError("Timed out waiting for reply.");
    } catch (err: any) {
      const msg = err?.message || "Failed to reach backend";
      setError(msg);
      setMessages((cur) => [
        ...cur,
        { id: crypto.randomUUID(), role: "error", content: msg, ts: Date.now() },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-white text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 p-4">
          <div className="flex items-center gap-2">
            <Bot className="h-6 w-6" />
            <h1 className="text-lg font-semibold">{title}</h1>
            <span className="text-xs text-slate-500">n8n (send + poll)</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSettings((s) => !s)}
              className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm shadow-sm hover:bg-slate-50"
              title="Info"
            >
              <Settings className="h-4 w-4" /> Info
            </button>
            <button
              onClick={clearChat}
              className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm shadow-sm hover:bg-slate-50"
              title="Clear chat"
            >
              <Eraser className="h-4 w-4" /> Clear
            </button>
          </div>
        </div>
      </header>

      {/* Info Panel */}
      {showSettings && (
        <div className="mx-auto max-w-5xl p-4">
          <div className="rounded-2xl border p-4 shadow-sm">
            <h2 className="mb-2 text-base font-medium">Backend expects env vars</h2>
            <ul className="list-disc pl-6 text-sm text-slate-700">
              <li><code className="rounded bg-slate-100 px-1">N8N_SEND_WEBHOOK_URL</code> → n8n webhook that enqueues/starts the job and returns a <em>requestId</em>.</li>
              <li><code className="rounded bg-slate-100 px-1">N8N_POLL_WEBHOOK_URL</code> → n8n webhook that checks job status and (once ready) returns the <em>reply</em>.</li>
            </ul>
          </div>
        </div>
      )}

      {/* Chat Area */}
      <main className="mx-auto flex h-[calc(100vh-140px)] max-w-5xl flex-col p-4">
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto rounded-2xl border bg-white p-4">
          {messages.map((m) => (
            <div key={m.id} className="flex gap-3">
              <div className={`mt-1 flex h-7 w-7 items-center justify-center rounded-full ${m.role === "user" ? "bg-slate-900 text-white" : m.role === "assistant" ? "bg-emerald-600 text-white" : m.role === "error" ? "bg-red-600 text-white" : "bg-slate-200"}`}>
                {m.role === "user" ? <User className="h-4 w-4" /> : m.role === "assistant" ? <Bot className="h-4 w-4" /> : m.role === "error" ? <span>!</span> : <span>i</span>}
              </div>
              <div className={`max-w-[85%] rounded-2xl border p-3 text-sm leading-relaxed shadow-sm ${m.role === "user" ? "bg-slate-50" : m.role === "assistant" ? "bg-emerald-50" : m.role === "error" ? "bg-red-50" : "bg-white"}`}>
                {mounted ? (
                  <ReactMarkdown
                    components={{
                      a: ({ node, ...props }: any) => (
                        <a {...props} className="text-emerald-700 underline underline-offset-2" target="_blank" rel="noreferrer" />
                      ),
                      code: ({ node, className, children, ...props }: any) => (
                        <code {...props} className={`rounded bg-slate-100 px-1 ${className || ""}`}>{children}</code>
                      ),
                    }}
                  >
                    {m.content}
                  </ReactMarkdown>
                ) : (
                  <div className="h-4 w-40 animate-pulse rounded bg-slate-200" suppressHydrationWarning />
                )}
                <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-400" suppressHydrationWarning>
                  {mounted && m.ts ? new Date(m.ts).toLocaleTimeString() : null}
                </div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> thinking…
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Composer */}
        <form onSubmit={handleSubmit} className="mt-3 flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder=""
            className="flex-1 rounded-2xl border px-4 py-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Send className="h-4 w-4" /> Send
          </button>
        </form>

        {/* Helpful links */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <Link className="h-3 w-3" />
          <a className="underline underline-offset-2" href="https://n8n.io" target="_blank" rel="noreferrer">n8n</a>
          <span>•</span>
          <a className="underline underline-offset-2" href="https://www.oneidentity.com/" target="_blank" rel="noreferrer">One Identity</a>
        </div>
      </main>
    </div>
  );
}

