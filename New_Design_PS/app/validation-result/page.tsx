/* app/validation-result/page.tsx */
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/* ---------- Types ---------- */
type Severity = "error" | "warning" | "info";

interface Issue {
  id: string;
  message: string;
  code?: string;
  severity: Severity;
  line: number;          // 1-based
  column?: number;       // 1-based
  length?: number;       // characters to highlight (optional)
  relatedPath?: string;  // optional XPath / extra info
}

interface ResultPayload {
  xmlText: string;
  issues: Issue[];
}

/* ---------- Small helpers ---------- */
function sevTailwind(sev: Severity) {
  switch (sev) {
    case "error":
      return {
        pill: "bg-rose-100 text-rose-800 border border-rose-200",
        line: "bg-rose-50",
        inline: "bg-rose-200",
        dot: "bg-rose-500",
      };
    case "warning":
      return {
        pill: "bg-amber-100 text-amber-900 border border-amber-200",
        line: "bg-amber-50",
        inline: "bg-amber-200",
        dot: "bg-amber-500",
      };
    default:
      return {
        pill: "bg-yellow-100 text-yellow-900 border border-yellow-200",
        line: "bg-yellow-50",
        inline: "bg-yellow-200",
        dot: "bg-yellow-500",
      };
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/* Split a single line into {pre, mark, post} based on 1-based col/length */
function splitForHighlight(
  lineText: string,
  column?: number,
  length?: number
): { pre: string; mark: string; post: string } {
  if (!column || column < 1 || !length || length <= 0) {
    return { pre: "", mark: "", post: "" };
  }
  const idx0 = clamp(column - 1, 0, lineText.length);
  const end = clamp(idx0 + length, 0, lineText.length);
  return {
    pre: lineText.slice(0, idx0),
    mark: lineText.slice(idx0, end),
    post: lineText.slice(end),
  };
}

/* ---------- Accessible, rock-solid toggle ---------- */
function EditToggle({
  checked,
  onChange,
  label = "Edit Mode",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2 text-sm"
      title={label}
    >
      <span className="text-white/90">{label}</span>
      <span
        className={[
          // Track
          "relative h-6 w-12 rounded-full transition-colors duration-200",
          "border-2",
          "overflow-hidden", // <-- keeps the knob inside
          checked
            ? "bg-emerald-500 border-emerald-400"
            : "bg-slate-600 border-sky-400"
        ].join(" ")}
      >
        {/* Knob */}
        <span
          className={[
            "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 will-change-transform",
            checked ? "translate-x-6" : "translate-x-0" // 12px track padding -> 24px move
          ].join(" ")}
        />
      </span>
    </button>
  );
}

/* ---------- Page ---------- */
export default function ValidatorResultPage() {
  const router = useRouter();
  const [xmlText, setXmlText] = useState<string>("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);

  // Refs for scrolling to lines
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Load payload from sessionStorage
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("validator.result.v1");
      if (!raw) {
        router.replace("/validator");
        return;
      }
      const parsed = JSON.parse(raw) as ResultPayload;
      if (!parsed?.xmlText) {
        router.replace("/validator");
        return;
      }
      setXmlText(parsed.xmlText);
      setIssues(Array.isArray(parsed.issues) ? parsed.issues : []);
    } catch {
      router.replace("/validator");
      return;
    } finally {
      setLoading(false);
    }
  }, [router]);

  const lines = useMemo(() => xmlText.split(/\r?\n/), [xmlText]);

  // Map: lineNumber -> issues on that line
  const issuesByLine = useMemo(() => {
    const map = new Map<number, Issue[]>();
    for (const it of issues) {
      const ln = Math.max(1, Math.min(lines.length || 1, it.line || 1));
      const arr = map.get(ln) || [];
      arr.push(it);
      map.set(ln, arr);
    }
    // Sort errors before warnings before infos for gutter stacking order
    for (const ln of map.keys()) {
      const arr = map.get(ln)!;
      arr.sort((a, b) => {
        const rank = (s: Severity) => (s === "error" ? 0 : s === "warning" ? 1 : 2);
        return rank(a.severity) - rank(b.severity);
      });
      map.set(ln, arr);
    }
    return map;
  }, [issues, lines.length]);

  function scrollToIssue(issue: Issue) {
    const ln = clamp(issue.line, 1, lines.length || 1);
    const el = lineRefs.current.get(ln);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Brief flash effect
    el.classList.add("ring-2", "ring-sky-400");
    setTimeout(() => el.classList.remove("ring-2", "ring-sky-400"), 900);
  }

  function handleValidateAnother() {
    sessionStorage.removeItem("validator.result.v1");
    router.replace("/validator");
  }

  function handleCopy() {
    navigator.clipboard.writeText(xmlText).catch(() => {});
  }

  function handleDownload() {
    const blob = new Blob([xmlText], { type: "application/xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "connector.xml";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <main className="min-h-screen grid place-items-center bg-slate-50">
        <div className="text-slate-600 text-sm">Loading…</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-900 text-white">
        <div className="mx-auto max-w-7xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.replace("/validator")}
              className="rounded-md border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
              title="Back to validator"
            >
              ← Back
            </button>
            <h1 className="text-lg font-semibold">XML Validation Results</h1>
          </div>
          <div className="flex items-center gap-3">
            <EditToggle checked={editMode} onChange={setEditMode} />
            <button
              onClick={handleCopy}
              className="rounded-md border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
              title="Copy XML"
            >
              Copy XML
            </button>
            <button
              onClick={handleDownload}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm hover:bg-emerald-700"
              title="Download XML"
            >
              Download
            </button>
            <button
              onClick={handleValidateAnother}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-sm hover:bg-sky-700"
              title="Validate another"
            >
              Validate another
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto max-w-7xl px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Results list */}
        <aside className="lg:col-span-1">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="px-4 py-3 border-b border-slate-100">
              <div className="text-sm font-semibold text-slate-900">Findings</div>
              <div className="mt-1 text-xs text-slate-500">
                {issues.length} item{issues.length === 1 ? "" : "s"}
              </div>
            </div>

            <div className="p-3 space-y-2 max-h-[70vh] overflow-auto">
              {issues.length === 0 && (
                <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
                  No issues found — looks good!
                </div>
              )}

              {issues.map((it) => {
                const theme = sevTailwind(it.severity);
                return (
                  <button
                    key={it.id}
                    onClick={() => scrollToIssue(it)}
                    className={`w-full text-left rounded-md px-3 py-2 border hover:bg-slate-50 ${theme.pill}`}
                    title="Jump to line"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${theme.dot}`}
                        aria-hidden
                      />
                      <span className="font-semibold uppercase tracking-wide">
                        {it.severity}
                      </span>
                      <span className="text-slate-500">·</span>
                      <span className="font-mono">Ln {it.line}{it.column ? `:${it.column}` : ""}</span>
                      {it.code && (
                        <>
                          <span className="text-slate-500">·</span>
                          <span className="font-mono">{it.code}</span>
                        </>
                      )}
                    </div>
                    <div className="mt-1 text-sm">{it.message}</div>
                    {it.relatedPath && (
                      <div className="mt-1 text-[11px] text-slate-600 break-all">
                        {it.relatedPath}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Legend */}
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
            <div className="font-semibold text-slate-900 mb-2">Legend</div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded bg-rose-500" />
                <span>Error</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded bg-amber-500" />
                <span>Warning / Info</span>
              </div>
            </div>
          </div>
        </aside>

        {/* Right: Code view (editable / read-only) */}
        <section className="lg:col-span-2">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">XML {editMode ? "Editor" : "Preview"}</div>
              <button
                onClick={() => containerRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
                className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50"
                title="Back to top"
              >
                Back to top
              </button>
            </div>

            {/* Editor mode: textarea with line numbers */}
            {editMode ? (
              <div className="max-h-[75vh] overflow-auto font-mono text-[12px] leading-5">
                <div className="grid grid-cols-[64px_1fr]">
                  {/* Gutter */}
                  <div className="select-none sticky left-0 z-10 border-r border-slate-100 bg-white">
                    {lines.map((_, i) => (
                      <div key={`g${i}`} className="px-3 py-[1px] text-slate-400">
                        {i + 1}
                      </div>
                    ))}
                  </div>
                  {/* Textarea */}
                  <textarea
                    value={xmlText}
                    onChange={(e) => setXmlText(e.target.value)}
                    spellCheck={false}
                    className="min-h-full w-full resize-none px-3 py-2 outline-none"
                    style={{ height: `${Math.max(400, lines.length * 20)}px` }}
                  />
                </div>
              </div>
            ) : (
              // Read-only pretty viewer with inline highlights
              <div
                ref={containerRef}
                className="max-h-[75vh] overflow-auto font-mono text-[12px] leading-5"
              >
                <div className="min-w-full">
                  {lines.map((text, i) => {
                    const lineNo = i + 1;
                    const lineIssues = issuesByLine.get(lineNo) || [];
                    const topSev: Severity | null = lineIssues[0]?.severity ?? null;
                    const bg =
                      topSev === "error"
                        ? "bg-rose-50"
                        : topSev
                        ? "bg-amber-50"
                        : "";
                    const refSetter = (el: HTMLDivElement | null) => {
                      if (!el) return;
                      lineRefs.current.set(lineNo, el);
                    };

                    // If multiple issues on a line, highlight the first with column/length.
                    const markIssue = lineIssues.find(it => it.column && it.length);
                    const split = splitForHighlight(text, markIssue?.column, markIssue?.length);
                    const inlineClass =
                      markIssue?.severity === "error"
                        ? "bg-rose-200"
                        : markIssue
                        ? "bg-amber-200"
                        : "";

                    return (
                      <div
                        key={`ln-${lineNo}`}
                        ref={refSetter}
                        id={`line-${lineNo}`}
                        className={`grid grid-cols-[64px_1fr] gap-0 ${bg}`}
                      >
                        {/* Gutter with dots */}
                        <div className="select-none sticky left-0 z-10 flex items-start justify-end pr-3 border-r border-slate-100 bg-white">
                          <div className="h-full w-full flex items-center justify-end gap-2 py-[1px]">
                            {lineIssues.slice(0, 3).map((it) => (
                              <span
                                key={`${it.id}-dot`}
                                className={`inline-block h-2 w-2 rounded ${sevTailwind(it.severity).dot}`}
                                title={`${it.severity.toUpperCase()} · ${it.message}`}
                              />
                            ))}
                            <span className="text-slate-400">{lineNo}</span>
                          </div>
                        </div>

                        {/* Code */}
                        <div className="whitespace-pre px-3 py-[1px]">
                          {markIssue ? (
                            <>
                              <span>{split.pre}</span>
                              <span className={inlineClass}>{split.mark}</span>
                              <span>{split.post}</span>
                            </>
                          ) : (
                            <span>{text}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
