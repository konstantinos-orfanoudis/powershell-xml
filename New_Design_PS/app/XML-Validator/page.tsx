"use client";

import React, { useMemo, useRef, useState, useEffect } from "react";

/* ============ Types & helpers ============ */

type ErrKind = "error" | "warn" | "info";
type ValMsg = { line: number; kind: ErrKind; msg: string };

type UiType = "String" | "Bool" | "Int" | "DateTime" | "Unknown";

const trimDollar = (s: string) => s.replace(/^\$/, "");
const toLines = (s: string) => s.replace(/\r\n/g, "\n").split("\n");
const escapeHtml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function idxToLine(text: string, idx: number) {
  if (idx < 0) return 1;
  return text.slice(0, idx).replace(/\r\n/g, "\n").split("\n").length;
}

function findLineOfSnippet(xml: string, snippet: string, startHint = 0): number {
  const i = xml.indexOf(snippet, startHint);
  return idxToLine(xml, i);
}

/* ---- Balanced extractors ---- */
function extractBalanced(
  src: string,
  openIdx: number,
  openChar: string,
  closeChar: string
): { text: string; end: number } | null {
  let i = openIdx;
  let depth = 0;
  let start = -1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === openChar) {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return { text: src.slice(start, i), end: i + 1 };
      }
    }
    i++;
  }
  return null;
}

/* ---- Type normalization ---- */

function toUiTypeFromPsType(t?: string): UiType {
  const s = String(t || "").trim().toLowerCase().replace(/^system\./, "");
  if (!s) return "Unknown";
  if (/(^|[^a-z])(int|int32|integer)([^a-z]|$)/.test(s)) return "Int";
  if (/(^|[^a-z])(bool|boolean)([^a-z]|$)/.test(s)) return "Bool";
  if (/datetime(offset)?/.test(s)) return "DateTime";
  return "String"; // default PS scalar
}

function toUiTypeFromXml(t?: string): UiType {
  const s = String(t || "").trim().toLowerCase();
  if (s === "int") return "Int";
  if (s === "bool") return "Bool";
  if (s === "datetime") return "DateTime";
  if (s === "string") return "String";
  return "Unknown";
}

/* ---- PowerShell parsing (names + types) ---- */

type PsParam = { name: string; uiType: UiType };
type PsFunc = { name: string; params: PsParam[] };

function extractParamNamesAndTypesFromCode(code: string): PsParam[] {
  const out: PsParam[] = [];
  const m = /param\b/i.exec(code);
  if (!m) return out;
  const parenIdx = code.indexOf("(", m.index!);
  if (parenIdx < 0) return out;
  const blk = extractBalanced(code, parenIdx, "(", ")");
  if (!blk) return out;

  const body = blk.text;

  // [Type] $name
  const re = /\[\s*([A-Za-z0-9_.]+)\s*\]\s*\$([A-Za-z0-9_]+)/g;
  let mm: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((mm = re.exec(body))) {
    const rawType = mm[1];
    const rawName = mm[2];
    const name = trimDollar(rawName);
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, uiType: toUiTypeFromPsType(rawType) });
  }

  // Fallback bare $name
  const bare = body.match(/\$[A-Za-z0-9_]+/g) || [];
  bare.forEach((d) => {
    const nm = trimDollar(d);
    if (!out.some((p) => p.name.toLowerCase() === nm.toLowerCase())) {
      out.push({ name: nm, uiType: "Unknown" });
    }
  });

  return out;
}

function parsePSFunctions(ps: string): Record<string, PsFunc> {
  const out: Record<string, PsFunc> = {};
  if (!ps) return out;
  const re = /function\s+(?:global:)?([A-Za-z0-9_-]+)\s*\{/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ps))) {
    const name = m[1];
    const openBraceIdx = ps.indexOf("{", m.index!);
    if (openBraceIdx < 0) continue;
    const bodyBlk = extractBalanced(ps, openBraceIdx, "{", "}");
    if (!bodyBlk) continue;
    const params = extractParamNamesAndTypesFromCode(bodyBlk.text);
    out[name] = { name, params };
  }
  return out;
}

/* Also capture function bodies for return-shape parsing */
function parsePSFunctionBodies(ps: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!ps) return out;
  const re = /function\s+(?:global:)?([A-Za-z0-9_-]+)\s*\{/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ps))) {
    const name = m[1];
    const openBraceIdx = ps.indexOf("{", m.index!);
    if (openBraceIdx < 0) continue;
    const bodyBlk = extractBalanced(ps, openBraceIdx, "{", "}");
    if (!bodyBlk) continue;
    out[name] = bodyBlk.text;
  }
  return out;
}

/* ---- CustomCommands param names/types parsed from CDATA inside XML ---- */
function parseCustomCommandsFromXml(xml: string): Record<string, PsFunc> {
  const out: Record<string, PsFunc> = {};
  const ccRe =
    /<CustomCommand\s+Name="([^"]+)"\s*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/CustomCommand>/gi;
  let m: RegExpExecArray | null;
  while ((m = ccRe.exec(xml))) {
    const name = m[1];
    const body = m[2];
    const params = extractParamNamesAndTypesFromCode(body);
    out[name] = { name, params };
  }
  return out;
}

/* ---- Tiny XML helpers ---- */
type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  startIdx: number;
  endIdx: number;
};

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}

/** Parse nodes for a given tag: <tag ...> ... </tag> (simple nesting) */
function parseXmlNodes(xml: string, tag: string): XmlNode[] {
  const nodes: XmlNode[] = [];
  const open = new RegExp(`<${tag}(\\s+[^>]*?)?>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    const start = m.index!;
    const attrs = parseAttrs(m[1] || "");
    const openTag = `<${tag}`;
    const closeTag = `</${tag}>`;
    let i = open.lastIndex;
    let depth = 1;

    while (i < xml.length && depth > 0) {
      const nextOpen = xml.indexOf(openTag, i);
      const nextClose = xml.indexOf(closeTag, i);
      if (nextClose < 0) break;

      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + openTag.length;
      } else {
        depth--;
        if (depth === 0) {
          const innerStart = open.lastIndex;
          const innerEnd = nextClose;
          nodes.push({
            tag,
            attrs,
            text: xml.slice(innerStart, innerEnd),
            startIdx: start,
            endIdx: nextClose,
          });
        }
        i = nextClose + closeTag.length;
      }
    }
  }
  return nodes;
}

function parseClasses(xml: string): {
  name: string;
  body: string;
  startIdx: number;
}[] {
  return parseXmlNodes(xml, "Class").map((n) => ({
    name: n.attrs["Name"] || "",
    body: n.text,
    startIdx: n.startIdx,
  }));
}

function extractReadConfiguration(xmlClassBody: string) {
  const rc = parseXmlNodes(xmlClassBody, "ReadConfiguration")[0];
  if (!rc) return null;
  const listing = parseXmlNodes(rc.text, "ListingCommand")[0] || null;
  const cmdSeq = parseXmlNodes(rc.text, "CommandSequence")[0] || null;
  return { rc, listing, cmdSeq };
}

/* Predefined entries with line numbers */
function getPredefinedEntries(xml: string): { name: string; line: number }[] {
  const blocks = parseXmlNodes(xml, "PredefinedCommands");
  const entries: { name: string; line: number }[] = [];
  blocks.forEach((blk) => {
    const re = /<Command\s+Name="([^"]+)"\s*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blk.text))) {
      const snippet = m[0];
      entries.push({
        name: m[1],
        line: findLineOfSnippet(xml, snippet, blk.startIdx),
      });
    }
  });
  return entries;
}

/* ---- Property parsing (for type + inner content) ---- */
type XmlProperty = {
  name: string;
  uiType: UiType;
  node: XmlNode;
  line: number;
};

function parseProperties(xml: string, classBody: string, classStartIdx: number): XmlProperty[] {
  const props = parseXmlNodes(classBody, "Property");
  return props.map((p) => ({
    name: p.attrs["Name"] || "",
    uiType: toUiTypeFromXml(p.attrs["DataType"]),
    node: p,
    line: findLineOfSnippet(xml, `<Property`, classStartIdx),
  }));
}

/* ---- PS return shape parsing: keys + inferred UiType ---- */

function inferUiTypeFromPsExpr(expr: string): UiType {
  const s = expr.trim();
  if (/^\$true|\$false$/i.test(s)) return "Bool";
  if (/^["'][\s\S]*?["']$/.test(s)) return "String";
  if (/^[+-]?\d+$/i.test(s)) return "Int";
  if (/\[datetime\]/i.test(s)) return "DateTime";
  if (/Get-Date\b/i.test(s)) return "DateTime";
  if (/::(UtcNow|Now|Parse|ParseExact)\b/.test(s) && /DateTime/i.test(s)) return "DateTime";
  return "Unknown";
}

/** Map: funcName -> { key: UiType } for [pscustomobject]@{ key = expr } blocks */
function parsePsReturnShapes(psBodies: Record<string, string>): Record<string, Record<string, UiType>> {
  const result: Record<string, Record<string, UiType>> = {};
  for (const [fname, body] of Object.entries(psBodies)) {
    const map: Record<string, UiType> = {};
    // Find all [pscustomobject]@{ ... } blocks
    const re = /\[\s*pscustomobject\s*\]\s*@\s*\{/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const openIdx = body.indexOf("{", m.index!);
      if (openIdx < 0) continue;
      const blk = extractBalanced(body, openIdx, "{", "}");
      if (!blk) continue;
      const content = blk.text;

      // Extract assignments: key = expr
      const assignRe = /([A-Za-z0-9_]+)\s*=\s*([^\r\n;]+)/g;
      let am: RegExpExecArray | null;
      while ((am = assignRe.exec(content))) {
        const key = am[1];
        const expr = am[2];
        if (!map[key]) {
          map[key] = inferUiTypeFromPsExpr(expr);
        }
      }
    }
    if (Object.keys(map).length > 0) {
      result[fname] = map;
    }
  }
  return result;
}

/* ---- Read-only viewer with numbers (rendered via HTML) ---- */
function highlightXmlWithNumbers(xml: string, errorLines: Set<number>): string {
  const lines = toLines(xml);
  const lineHeight = 20; // px

  const gutter = lines
    .map(
      (_, i) =>
        `<div style="height:${lineHeight}px;line-height:${lineHeight}px;text-align:right;padding:0 8px;color:#64748b;">${
          i + 1
        }</div>`
    )
    .join("");

  const code = lines
    .map((ln, i) => {
      const hl = errorLines.has(i + 1) ? "background:#fff7c2;" : "";
      return `<div style="height:${lineHeight}px;line-height:${lineHeight}px;${hl}">${escapeHtml(
        ln
      )}</div>`;
    })
    .join("");

  return `
<div style="display:grid;grid-template-columns:3.25rem auto;align-items:start;">
  <div style="border-right:1px solid #e5e7eb;background:#f8fafc;">${gutter}</div>
  <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;font-size:12px;padding:0 8px;">${code}</div>
</div>`;
}

/* ============ Line-numbered editor component ============ */

type EditorProps = {
  value: string;
  onChange: (v: string) => void;
  heightClass?: string;
  placeholder?: string;
};

function LineNumberedEditor({
  value,
  onChange,
  heightClass = "h-[420px]",
  placeholder,
}: EditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lineCount = Math.max(1, toLines(value).length);

  const syncScroll = () => {
    if (!taRef.current || !gutterRef.current) return;
    gutterRef.current.scrollTop = taRef.current.scrollTop;
  };

  useEffect(() => {
    syncScroll();
  }, [value]);

  return (
    <div
      className={`relative w-full rounded-md border border-slate-300 bg-white font-mono text-xs ${heightClass}`}
    >
      <div className="absolute inset-0 grid grid-cols-[3.25rem_auto]">
        {/* Gutter */}
        <div
          ref={gutterRef}
          className="select-none border-r border-slate-200 bg-slate-50 px-2 py-2 text-right leading-5 text-slate-500 overflow-hidden"
        >
          {Array.from({ length: lineCount }).map((_, i) => (
            <div key={i} className="h-5">
              {i + 1}
            </div>
          ))}
        </div>

        {/* Textarea */}
        <textarea
          ref={taRef}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          spellCheck={false}
          className="h-full w-full resize-none bg-white px-2 py-2 leading-5 outline-none"
          style={{ tabSize: 2 }}
        />
      </div>
    </div>
  );
}

/* ============ Page ============ */

export default function Page() {
  const [xmlText, setXmlText] = useState<string>("");
  const [psText, setPsText] = useState<string>("");

  // expand modals
  const [modal, setModal] = useState<{
    open: boolean;
    kind: "xml" | "ps" | "viewer" | null;
    draft: string;
  }>({
    open: false,
    kind: null,
    draft: "",
  });

  const [results, setResults] = useState<ValMsg[]>([]);
  const rightRef = useRef<HTMLDivElement>(null);

  // keep highlighted-error lines so the viewer modal can reuse them
  const [hlErrLines, setHlErrLines] = useState<Set<number>>(new Set());

  const psFuncs = useMemo(() => parsePSFunctions(psText), [psText]);
  const psBodies = useMemo(() => parsePSFunctionBodies(psText), [psText]);
  const psReturnShapes = useMemo(() => parsePsReturnShapes(psBodies), [psBodies]);

  const customFromXml = useMemo(() => parseCustomCommandsFromXml(xmlText), [xmlText]);
  const predefinedEntries = useMemo(() => getPredefinedEntries(xmlText), [xmlText]);
  const predefinedNames = useMemo(
    () => Array.from(new Set(predefinedEntries.map((e) => e.name))),
    [predefinedEntries]
  );

  const knownCommands = useMemo(() => {
    const map = new Map<
      string,
      { name: string; params: PsParam[]; source: "ps" | "custom" | "predefined" }
    >();
    Object.values(psFuncs).forEach((f) =>
      map.set(f.name, { name: f.name, params: f.params, source: "ps" })
    );
    Object.values(customFromXml).forEach((f) => {
      const existing = map.get(f.name);
      if (!existing || existing.source !== "ps") {
        map.set(f.name, { name: f.name, params: f.params, source: "custom" });
      }
    });
    predefinedNames.forEach((nm) => {
      if (!map.has(nm)) map.set(nm, { name: nm, params: [], source: "predefined" });
    });
    return map;
  }, [psFuncs, customFromXml, predefinedNames]);

  function validate() {
    const errs: ValMsg[] = [];
    const errLines = new Set<number>();
    const xml = xmlText || "";

    if (!xml.trim()) {
      setResults([{ line: 1, kind: "warn", msg: "Paste XML on the left and click Validate." }]);
      if (rightRef.current) rightRef.current.innerHTML = highlightXmlWithNumbers("", new Set());
      setHlErrLines(new Set());
      return;
    }

    /* Predefined must exist in PS */
    predefinedEntries.forEach((ent) => {
      if (!(ent.name in psFuncs)) {
        errs.push({
          line: ent.line,
          kind: "error",
          msg: `Predefined command "${ent.name}" is not found in the PowerShell file.`,
        });
        errLines.add(ent.line);
      }
    });

    const classes = parseClasses(xml);

    classes.forEach((cl) => {
      const rcPack = extractReadConfiguration(cl.body);

      // ReadConfiguration mandatory
      if (!rcPack) {
        const classLine = findLineOfSnippet(xml, `<Class Name="${cl.name}"`, 0);
        errs.push({
          line: classLine,
          kind: "error",
          msg: `Class "${cl.name}": <ReadConfiguration> block is required and must include <ListingCommand> and <CommandSequence>.`,
        });
        errLines.add(classLine);
        return;
      }

      const { rc, listing, cmdSeq } = rcPack;
      const rcStartLine = findLineOfSnippet(xml, "<ReadConfiguration", cl.startIdx);

      if (!listing) {
        errs.push({
          line: rcStartLine,
          kind: "error",
          msg: `Class "${cl.name}": <ReadConfiguration> must contain a <ListingCommand> block.`,
        });
        errLines.add(rcStartLine);
      }

      if (!cmdSeq) {
        const l1 = listing
          ? findLineOfSnippet(xml, "<ListingCommand", cl.startIdx) || rcStartLine
          : rcStartLine;
        errs.push({
          line: l1,
          kind: "error",
          msg: `Class "${cl.name}": <ReadConfiguration> must contain a <CommandSequence> block after <ListingCommand>.`,
        });
        errLines.add(l1);
      }

      if (listing && cmdSeq) {
        const posList = rc.text.indexOf("<ListingCommand");
        const posSeq = rc.text.indexOf("<CommandSequence");
        if (posSeq >= 0 && posList >= 0 && posSeq < posList) {
          const lList = findLineOfSnippet(xml, "<ListingCommand", cl.startIdx) || rcStartLine;
          errs.push({
            line: lList,
            kind: "error",
            msg: `Class "${cl.name}": <CommandSequence> must appear after <ListingCommand> within <ReadConfiguration>.`,
          });
          errLines.add(lList);
        }
      }

      // ListingCommand declaration & existence
      if (listing) {
        const lLine = findLineOfSnippet(xml, "<ListingCommand", cl.startIdx);
        const lCmd = listing.attrs["Command"];
        if (!lCmd) {
          errs.push({
            line: lLine,
            kind: "error",
            msg: `Class "${cl.name}": <ListingCommand> must include Command="...".`,
          });
          errLines.add(lLine);
        } else {
          const info = knownCommands.get(lCmd);
          if (!info) {
            errs.push({
              line: lLine,
              kind: "error",
              msg: `Command "${lCmd}" used in <ListingCommand> is not declared as Custom/Predefined and not found in the PowerShell file.`,
            });
            errLines.add(lLine);
          } else if (info.source === "predefined" && !(lCmd in psFuncs)) {
            errs.push({
              line: lLine,
              kind: "error",
              msg: `Command "${lCmd}" is declared as Predefined but not found in the PowerShell file.`,
            });
            errLines.add(lLine);
          }
        }
      }

      // Each <Item Command="..."> exists & declared
      const itemRe = /<Item\s+[^>]*Command="([^"]+)"[^>]*>/g;
      let im: RegExpExecArray | null;
      while ((im = itemRe.exec(cl.body))) {
        const cmd = im[1];
        const ln = findLineOfSnippet(xml, im[0], cl.startIdx);
        const info = knownCommands.get(cmd);
        if (!info) {
          errs.push({
            line: ln,
            kind: "error",
            msg: `Command "${cmd}" is used in <Item> but is not declared as Custom/Predefined and not found in the PowerShell file.`,
          });
          errLines.add(ln);
        } else if (info.source === "predefined" && !(cmd in psFuncs)) {
          errs.push({
            line: ln,
            kind: "error",
            msg: `Command "${cmd}" is declared as Predefined but not found in the PowerShell file.`,
          });
          errLines.add(ln);
        }
      }
    });

    /* ---- Build property map per class ---- */
    type ClassCtx = {
      name: string;
      props: XmlProperty[];
      startIdx: number;
      body: string;
    };
    const perClass: ClassCtx[] = classes.map((cl) => ({
      name: cl.name,
      props: parseProperties(xml, cl.body, cl.startIdx),
      startIdx: cl.startIdx,
      body: cl.body,
    }));

    /* ---- SetParameter checks (with type validation) ---- */
    perClass.forEach((cl) => {
      const setRe = /<SetParameter\s+([^>]+?)\/>/g;
      const contexts = [
        ...cl.body.matchAll(/<(Item|ListingCommand)\s+[^>]*Command="([^"]+)"[^>]*>/g),
      ].map((it) => ({ idx: it.index || 0, cmd: it[2] }));

      let m: RegExpExecArray | null;
      while ((m = setRe.exec(cl.body))) {
        const attrs = parseAttrs(m[1] || "");
        const paramAttr = attrs["Param"];
        const source = attrs["Source"];
        const setStart = m.index || 0;
        const absLine = findLineOfSnippet(xml, m[0], cl.startIdx);

        const ctx = contexts
          .filter((it) => it.idx <= setStart)
          .sort((a, b) => b.idx - a.idx)[0];

        if (!ctx) {
          errs.push({
            line: absLine,
            kind: "error",
            msg: `<SetParameter> must be inside an <Item> or <ListingCommand>.`,
          });
          errLines.add(absLine);
          continue;
        }

        if (!paramAttr) {
          errs.push({
            line: absLine,
            kind: "error",
            msg: `SetParameter must include a non-empty Param="...".`,
          });
          errLines.add(absLine);
        }

        if (source && source !== "ConnectionParameter") {
          errs.push({
            line: absLine,
            kind: "error",
            msg: `SetParameter Source="${source}" is not allowed. Only Source="ConnectionParameter" is supported.`,
          });
          errLines.add(absLine);
        }

        const cmdName = ctx.cmd;
        const cmdInfo = knownCommands.get(cmdName);

        if (!cmdInfo) {
          errs.push({
            line: absLine,
            kind: "error",
            msg: `Command "${cmdName}" is not declared (Custom/Predefined) and not found in the PowerShell file.`,
          });
          errLines.add(absLine);
          continue;
        }

        if (cmdInfo.source === "predefined" && !(cmdName in psFuncs)) {
          errs.push({
            line: absLine,
            kind: "error",
            msg: `Command "${cmdName}" is declared as Predefined but not found in the PowerShell file. Cannot verify Param="${paramAttr}".`,
          });
          errLines.add(absLine);
          continue;
        }

        // Name exists?
        if (paramAttr) {
          const match =
            cmdInfo.params.find((p) => p.name.toLowerCase() === paramAttr.toLowerCase()) || null;
          if (!match) {
            errs.push({
              line: absLine,
              kind: "error",
              msg: `Param="${paramAttr}" is not a parameter of command "${cmdName}".`,
            });
            errLines.add(absLine);
          } else {
            // Type check: ConnectionParameters assumed String
            if (match.uiType !== "Unknown" && match.uiType !== "String") {
              errs.push({
                line: absLine,
                kind: "error",
                msg: `Type mismatch: <SetParameter> binds a ConnectionParameter (String) to "${cmdName}.${match.name}" of type ${match.uiType}.`,
              });
              errLines.add(absLine);
            } else if (match.uiType === "Unknown") {
              errs.push({
                line: absLine,
                kind: "warn",
                msg: `Could not determine type for "${cmdName}.${match.name}" (PowerShell).`,
              });
            }
          }
        }
      }
    });

    /* ---- ModBy (property must be parameter of command) ---- */
    perClass.forEach((cl) => {
      cl.props.forEach((prop) => {
        const modRe = /<ModBy\s+[^>]*Command="([^"]+)"[^>]*\/>/g;
        let m: RegExpExecArray | null;
        while ((m = modRe.exec(prop.node.text))) {
          const cmdName = m[1];
          const line = findLineOfSnippet(xml, m[0], cl.startIdx);
          const info = knownCommands.get(cmdName);
          if (!info) {
            errs.push({
              line,
              kind: "error",
              msg: `ModBy Command="${cmdName}" is used but "${cmdName}" is not declared (Custom/Predefined) and not found in PS.`,
            });
            errLines.add(line);
          } else if (info.source === "predefined" && !(cmdName in psFuncs)) {
            errs.push({
              line,
              kind: "error",
              msg: `ModBy Command="${cmdName}" is declared as Predefined but not found in the PowerShell file.`,
            });
            errLines.add(line);
          } else {
            const hasParam = info.params.some(
              (p) => p.name.toLowerCase() === prop.name.toLowerCase()
            );
            if (!hasParam) {
              errs.push({
                line,
                kind: "error",
                msg: `Property "${prop.name}" used in <ModBy Command="${cmdName}">, but "${cmdName}" does not expose a parameter named "${prop.name}".`,
              });
              errLines.add(line);
            }
          }
        }
      });
    });

    /* ---- Map (with type matching + property name match) ---- */
    perClass.forEach((cl) => {
      cl.props.forEach((prop) => {
        const mapRe =
          /<Map\s+[^>]*ToCommand="([^"]+)"\s+[^>]*Parameter="([^"]+)"[^>]*\/>/g;
        let m: RegExpExecArray | null;
        while ((m = mapRe.exec(prop.node.text))) {
          const toCmd = m[1];
          const param = m[2];
          const line = findLineOfSnippet(xml, m[0], cl.startIdx);
          const info = knownCommands.get(toCmd);

          if (!info) {
            errs.push({
              line,
              kind: "error",
              msg: `Map ToCommand="${toCmd}" is used but "${toCmd}" is not declared (Custom/Predefined) and not found in PS.`,
            });
            errLines.add(line);
            continue;
          }

          if (info.source === "predefined" && !(toCmd in psFuncs)) {
            errs.push({
              line,
              kind: "error",
              msg: `Map ToCommand="${toCmd}" is declared as Predefined but not found in the PowerShell file; cannot verify Parameter="${param}".`,
            });
            errLines.add(line);
            continue;
          }

          const pp =
            info.params.find((p) => p.name.toLowerCase() === param.toLowerCase()) || null;
          if (!pp) {
            errs.push({
              line,
              kind: "error",
              msg: `Property/Binding uses Parameter="${param}" but that is not a parameter of PowerShell function "${toCmd}".`,
            });
            errLines.add(line);
            continue;
          }

          if (param.toLowerCase() !== prop.name.toLowerCase()) {
            errs.push({
              line,
              kind: "error",
              msg: `Property "${prop.name}" maps with Parameter="${param}". The parameter name must match the property name.`,
            });
            errLines.add(line);
          }

          if (pp.uiType === "Unknown") {
            errs.push({
              line,
              kind: "warn",
              msg: `Could not determine type for parameter "${pp.name}" of "${toCmd}" (PowerShell).`,
            });
          } else if (prop.uiType === "Unknown") {
            errs.push({
              line,
              kind: "warn",
              msg: `Property "${prop.name}" has unknown DataType in XML; cannot fully verify type match with "${toCmd}.${pp.name}" (${pp.uiType}).`,
            });
          } else if (prop.uiType !== pp.uiType) {
            errs.push({
              line,
              kind: "error",
              msg: `Type mismatch: Property "${prop.name}" is ${prop.uiType} but "${toCmd}.${pp.name}" is ${pp.uiType}.`,
            });
            errLines.add(line);
          }
        }
      });
    });

    /* ---- ReturnBindings: command exists + key exists + type matches returned PSCustomObject ---- */
    perClass.forEach((cl) => {
      const bindRe = /<Bind\s+[^>]*CommandResultOf="([^"]+)"[^>]*Path="([^"]+)"[^>]*\/>/g;
      cl.props.forEach((prop) => {
        let m: RegExpExecArray | null;
        while ((m = bindRe.exec(prop.node.text))) {
          const cmd = m[1];
          const path = m[2];
          const ln = findLineOfSnippet(xml, m[0], cl.startIdx);
          const info = knownCommands.get(cmd);

          if (!info) {
            errs.push({
              line: ln,
              kind: "error",
              msg: `Bind CommandResultOf="${cmd}" is not declared as Custom/Predefined and not found in the PowerShell file.`,
            });
            errLines.add(ln);
            continue;
          } else if (info.source === "predefined" && !(cmd in psFuncs)) {
            errs.push({
              line: ln,
              kind: "error",
              msg: `Bind CommandResultOf="${cmd}" refers to a Predefined command not found in the PowerShell file.`,
            });
            errLines.add(ln);
            continue;
          }

          // Verify the returned object exposes this path as a top-level key
          const shape = psReturnShapes[cmd];
          if (!shape) {
            errs.push({
              line: ln,
              kind: "warn",
              msg: `Could not inspect returned object of "${cmd}" (no [pscustomobject] found); cannot verify Path="${path}" or type.`,
            });
            continue;
          }

          if (!(path in shape)) {
            errs.push({
              line: ln,
              kind: "error",
              msg: `Bind Path="${path}" not found in PSCustomObject returned by "${cmd}".`,
            });
            errLines.add(ln);
            continue;
          }

          const rt = shape[path]; // UiType inferred from expression
          if (rt === "Unknown") {
            errs.push({
              line: ln,
              kind: "warn",
              msg: `Type of "${cmd}.${path}" could not be determined (PowerShell); Property "${prop.name}" declared as ${prop.uiType}.`,
            });
          } else if (prop.uiType === "Unknown") {
            errs.push({
              line: ln,
              kind: "warn",
              msg: `Property "${prop.name}" has unknown DataType; cannot fully verify type match with "${cmd}.${path}" (${rt}).`,
            });
          } else if (prop.uiType !== rt) {
            errs.push({
              line: ln,
              kind: "error",
              msg: `Type mismatch in ReturnBinding: Property "${prop.name}" is ${prop.uiType} but "${cmd}.${path}" is ${rt}.`,
            });
            errLines.add(ln);
          }
        }
      });
    });

    setResults(errs.sort((a, b) => a.line - b.line));
    setHlErrLines(errLines);
    if (rightRef.current) {
      rightRef.current.innerHTML = highlightXmlWithNumbers(xml, errLines);
    }
  }

  const openModal = (kind: "xml" | "ps" | "viewer") =>
    setModal({ open: true, kind, draft: kind === "xml" ? xmlText : kind === "ps" ? psText : "" });
  const closeModal = () => setModal({ open: false, kind: null, draft: "" });
  const saveModal = () => {
    if (modal.kind === "xml") setXmlText(modal.draft);
    if (modal.kind === "ps") setPsText(modal.draft);
    closeModal();
  };

  // keep viewer in sync even before first validation
  useEffect(() => {
    if (rightRef.current) rightRef.current.innerHTML = highlightXmlWithNumbers(xmlText, hlErrLines);
  }, [xmlText, hlErrLines]);

  return (
    <main className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-white/90 px-3 py-2 backdrop-blur">
        <h1 className="text-base font-semibold">XML Validator</h1>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-slate-700 px-3 py-1.5 text-sm text-white hover:bg-slate-800">
            <input
              type="file"
              accept=".xml,.txt"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setXmlText(await f.text());
              }}
            />
            Upload XML
          </label>

          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-slate-700 px-3 py-1.5 text-sm text-white hover:bg-slate-800">
            <input
              type="file"
              accept=".ps1,.txt"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setPsText(await f.text());
              }}
            />
            Upload PowerShell
          </label>

          <button
            onClick={validate}
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            Validate
          </button>
          <a
          href="/.auth/logout?post_logout_redirect_uri=/login"
          className="inline-flex items-center rounded-md border border-rose-600 bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 hover:border-rose-700 focus:outline-none focus:ring-2 focus:ring-rose-500"
        >
          Sign out
        </a>
        </div>
      </div>

      {/* Editors + Viewer */}
      <div className="grid gap-4 p-3 md:grid-cols-2">
        {/* Left column: editable editors */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-slate-700">XML (editable)</div>
            <button
              onClick={() => openModal("xml")}
              className="text-xs rounded-md bg-slate-200 px-2 py-1 hover:bg-slate-300"
              title="Expand XML editor"
            >
              Expand
            </button>
          </div>
          <LineNumberedEditor value={xmlText} onChange={setXmlText} heightClass="h-[420px]" />

          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-slate-700">PowerShell (editable)</div>
            <button
              onClick={() => openModal("ps")}
              className="text-xs rounded-md bg-slate-200 px-2 py-1 hover:bg-slate-300"
              title="Expand PowerShell editor"
            >
              Expand
            </button>
          </div>
          <LineNumberedEditor value={psText} onChange={setPsText} heightClass="h-[220px]" />
        </div>

        {/* Right column: highlighted read-only XML with line numbers */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-slate-700">
              XML (read-only with highlights & line numbers)
            </div>
            <button
              onClick={() => openModal("viewer")}
              className="text-xs rounded-md bg-slate-200 px-2 py-1 hover:bg-slate-300"
              title="Expand highlighted XML"
            >
              Expand
            </button>
          </div>
          <div
            ref={rightRef}
            className="h-[660px] w-full overflow-auto rounded-md border border-slate-300 bg-white p-0 font-mono text-xs"
          />
        </div>
      </div>

      {/* Results */}
      <div className="mx-3 mb-6 rounded-md border border-slate-200 bg-white">
        <div className="border-b px-3 py-2 text-sm font-medium">Validation Results</div>
        <div className="max-h-[320px] overflow-auto px-3 py-2">
          {results.length === 0 ? (
            <div className="text-sm text-slate-500">Upload/paste files and click Validate.</div>
          ) : (
            <ul className="space-y-2">
              {results.map((r, i) => (
                <li
                  key={i}
                  className={`rounded border px-3 py-2 text-sm ${
                    r.kind === "error"
                      ? "border-rose-200 bg-rose-50 text-rose-800"
                      : r.kind === "warn"
                      ? "border-amber-200 bg-amber-50 text-amber-800"
                      : "border-slate-200 bg-slate-50 text-slate-700"
                  }`}
                >
                  <div className="font-mono">
                    Line {r.line}: {r.msg}
                  </div>
                  <div className="text-xs text-slate-500">Kind: {r.kind}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Full-screen modals */}
      {modal.open && modal.kind !== "viewer" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-3 w-[min(1200px,96vw)] rounded-2xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="text-sm font-medium">
                {modal.kind === "xml" ? "Edit XML" : "Edit PowerShell"}
              </div>
              <button
                onClick={closeModal}
                className="rounded-md bg-slate-200 px-2 py-1 text-xs hover:bg-slate-300"
              >
                Close
              </button>
            </div>
            <div className="p-4">
              <LineNumberedEditor
                value={modal.draft}
                onChange={(v) => setModal((m) => ({ ...m, draft: v }))}
                heightClass="h-[70vh]"
              />
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
              <button
                onClick={closeModal}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={saveModal}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Read-only highlighted XML modal */}
      {modal.open && modal.kind === "viewer" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-3 w-[min(1400px,98vw)] rounded-2xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="text-sm font-medium">XML (read-only, expanded)</div>
              <button
                onClick={closeModal}
                className="rounded-md bg-slate-200 px-2 py-1 text-xs hover:bg-slate-300"
              >
                Close
              </button>
            </div>
            <div className="p-0">
              <div
                className="h-[78vh] w-full overflow-auto rounded-b-2xl"
                dangerouslySetInnerHTML={{
                  __html: highlightXmlWithNumbers(xmlText, hlErrLines),
                }}
              />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
