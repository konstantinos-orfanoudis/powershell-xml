"use client";
import React, { useEffect, useMemo, useRef } from "react";

export type Severity = "error" | "warning" | "info";
export interface Issue {
  id: string;
  message: string;
  severity: Severity;
  line: number;       // 1-based
  column?: number;
  length?: number;
}

function sevDot(sev: Severity) {
  return sev === "error" ? "bg-rose-500"
       : sev === "warning" ? "bg-amber-500"
       : "bg-yellow-500";
}
function sevLineBg(sev?: Severity) {
  return sev === "error" ? "bg-rose-50"
       : sev === "warning" ? "bg-amber-50"
       : sev ? "bg-yellow-50"
       : "";
}

export default function CodeWithGutter({
  text,
  setText,
  editable,
  issues,
  onLineRef,
  maxHeight = "75vh",
}: {
  text: string;
  setText?: (next: string) => void;     // required when editable = true
  editable: boolean;
  issues: Issue[];
  onLineRef?: (lineNo: number, el: HTMLDivElement | null) => void;
  maxHeight?: string;
}) {
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const issuesByLine = useMemo(() => {
    const m = new Map<number, Issue[]>();
    for (const it of issues) {
      const ln = Math.max(1, Math.min(lines.length || 1, it.line || 1));
      (m.get(ln) || m.set(ln, []).get(ln)!).push(it);
    }
    return m;
  }, [issues, lines.length]);

  const gutterRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement | HTMLTextAreaElement>(null);

  // keep gutter and code scrolled together
  useEffect(() => {
    const codeEl = codeRef.current as HTMLElement | null;
    const gutEl = gutterRef.current;
    if (!codeEl || !gutEl) return;
    const onScroll = () => { gutEl.scrollTop = codeEl.scrollTop; };
    codeEl.addEventListener("scroll", onScroll, { passive: true });
    return () => codeEl.removeEventListener("scroll", onScroll);
  }, []);

  // Keep textarea height aligned with gutter total height for nice feel
  const lineHeightPx = 20; // leading-5 ~ 20px
  const totalHeight = `${Math.max(lines.length * lineHeightPx, 0)}px`;

  return (
    <div className="relative grid grid-cols-[64px_1fr]">
      {/* Gutter */}
      <div
        ref={gutterRef}
        className="select-none overflow-hidden border-r border-slate-200 bg-white"
        style={{ maxHeight }}
      >
        <div className="font-mono text-[12px] leading-5">
          {lines.map((_, i) => {
            const lineNo = i + 1;
            const arr = issuesByLine.get(lineNo) || [];
            const topSev = arr[0]?.severity;
            return (
              <div
                key={`gut-${lineNo}`}
                className={`flex items-center justify-end gap-2 pr-3 ${sevLineBg(topSev)}`}
                style={{ height: lineHeightPx }}
              >
                <div className="flex gap-0.5">
                  {arr.slice(0, 3).map((x) => (
                    <span key={`${x.id}-dot`} className={`h-2 w-2 rounded ${sevDot(x.severity)}`} />
                  ))}
                </div>
                <span className="text-slate-400">{lineNo}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Code */}
      <div className="overflow-auto" style={{ maxHeight }}>
        {editable ? (
          <textarea
            ref={codeRef as React.RefObject<HTMLTextAreaElement>}
            value={text}
            onChange={(e) => setText?.(e.target.value)}
            spellCheck={false}
            className="w-full font-mono text-[12px] leading-5 whitespace-pre resize-none outline-none p-3"
            style={{ height: totalHeight, minHeight: maxHeight }}
          />
        ) : (
          <div ref={codeRef as React.RefObject<HTMLDivElement>} className="font-mono text-[12px] leading-5">
            {lines.map((lnText, i) => {
              const lineNo = i + 1;
              const arr = issuesByLine.get(lineNo) || [];
              const topSev = arr[0]?.severity;
              return (
                <div
                  key={`ln-${lineNo}`}
                  className={`${sevLineBg(topSev)} whitespace-pre px-3`}
                  style={{ height: lineHeightPx, lineHeight: `${lineHeightPx}px` }}
                  ref={(el) => onLineRef?.(lineNo, el)}
                >
                  {lnText || " "}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
