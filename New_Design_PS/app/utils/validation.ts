// app/utils/validation.ts
import { parsePsText, PsMethod } from "./psParse";
import type { SchemaEntity } from "./normalizeSchema";
export const runtime = "nodejs";
export type Severity = "error" | "warning" | "info";
export interface Issue {
  id: string;
  message: string;
  code?: string;
  severity: Severity;
  line: number;      // 1-based
  column?: number;   // 1-based
  length?: number;   // highlight length
  relatedPath?: string;
}

function mkId() { return `iss-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`; }

function buildLineIndex(text: string) {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function posToLineCol(starts: number[], pos: number) {
  // binary search largest start <= pos
  let lo = 0, hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= pos) { lo = mid + 1; } else { hi = mid - 1; }
  }
  const line = hi + 1; // 1-based
  const col = pos - starts[hi] + 1;
  return { line, col };
}

function findFirst(text: string, re: RegExp): { index: number, length: number } | null {
  const m = re.exec(text);
  if (!m) return null;
  return { index: m.index, length: m[0].length };
}

// Find start tag and optionally attribute value; returns line/col/length for inline highlight
function locateTagAttr(xml: string, tag: string, attrName?: string, attrValue?: string) {
  let re: RegExp;
  if (attrName && attrValue != null) {
    const esc = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`<\\s*${tag}\\b[^>]*\\b${attrName}\\s*=\\s*("|\')${esc}\\1`, "i");
  } else {
    re = new RegExp(`<\\s*${tag}\\b`, "i");
  }
  const m = findFirst(xml, re);
  if (!m) return null;
  return { index: m.index, length: m.length };
}

function pushIssue(out: Issue[], xml: string, starts: number[], msg: string, code: string, sev: Severity, tag?: string, attrName?: string, attrValue?: string) {
  let line = 1, column: number | undefined, length: number | undefined;
  const loc = tag ? locateTagAttr(xml, tag, attrName, attrValue) : null;
  if (loc) {
    const { line: ln, col } = posToLineCol(starts, loc.index);
    line = ln; column = col; length = loc.length;
  }
  out.push({ id: mkId(), message: msg, code, severity: sev, line, column, length, relatedPath: tag ? `<${tag}${attrName ? ` ${attrName}="${attrValue ?? ""}"` : ""}>` : undefined });
}

/** Loose helpers to read attributes from XML DOM Elements */
function attr(el: Element, name: string) { return el.getAttribute(name) ?? ""; }
function nonEmpty(s: string | null | undefined) { return !!(s && String(s).trim().length); }

function tagList(doc: Document, tag: string) { return Array.from(doc.getElementsByTagName(tag)); }

/** Validate ReturnBind/Bind and schema references */
export function validateConnector(xmlText: string, psText: string, entities: SchemaEntity[]): Issue[] {
  const issues: Issue[] = [];
  const starts = buildLineIndex(xmlText);

  // 1) XML well-formed
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  const parseErr = dom.getElementsByTagName("parsererror")[0];
  if (parseErr) {
    const raw = parseErr.textContent?.trim() ?? "XML is not well-formed";
    // best effort line extraction
    let lineGuess = 1;
    const m = raw.match(/line\s+(\d+)/i); if (m) lineGuess = Math.max(1, parseInt(m[1], 10));
    issues.push({ id: mkId(), message: raw, code: "xml.parse", severity: "error", line: lineGuess });
    return issues; // cannot proceed
  } else {
    issues.push({ id: mkId(), message: "XML is well-formed.", code: "xml.ok", severity: "info", line: 1 });
  }

  // 2) Parse PS functions
  const methods = parsePsText(psText);
  const fnSet = new Set(methods.map(m => m.functionName.toLowerCase()));
  if (fnSet.size === 0) {
    issues.push({ id: mkId(), message: "No global PowerShell functions (function global:Name { ... }) found.", code: "ps.none", severity: "warning", line: 1 });
  } else {
    issues.push({ id: mkId(), message: `Detected ${fnSet.size} PowerShell global function(s).`, code: "ps.count", severity: "info", line: 1 });
  }

  // 3) Build schema maps
  const entMap = new Map<string, Set<string>>();
  for (const e of entities) {
    const props = new Set<string>();
    for (const a of e.attributes || []) props.add(a.name.toLowerCase());
    entMap.set(e.name.toLowerCase(), props);
  }
  issues.push({ id: mkId(), message: `Loaded ${entities.length} schema entit${entities.length === 1 ? "y" : "ies"}.`, code: "schema.entities", severity: "info", line: 1 });

  // 4) Generic attribute hygiene
  const allElements = Array.from(dom.getElementsByTagName("*"));
  for (const el of allElements) {
    for (const a of Array.from(el.attributes)) {
      if (/^\s+$/.test(a.value)) {
        pushIssue(issues, xmlText, starts, `Attribute "${a.name}" has only whitespace.`, "xml.attr.whitespace", "warning", el.tagName, a.name, a.value);
      }
      if (/[^\S\r\n]\n|\r/.test(a.value)) {
        pushIssue(issues, xmlText, starts, `Attribute "${a.name}" contains line breaks; XML attributes should be single-line.`, "xml.attr.newline", "warning", el.tagName, a.name, a.value);
      }
    }
  }

  // 5) ReturnBind / Bind validation (names used in your app)
  const returnBinds = [...dom.getElementsByTagName("ReturnBind"), ...dom.getElementsByTagName("ReturnBinding")];
  for (const rb of returnBinds) {
    const fn = attr(rb, "commandResultOf") || attr(rb, "CommandResultOf");
    const path = attr(rb, "path") || attr(rb, "Path");

    if (!nonEmpty(fn)) {
      pushIssue(issues, xmlText, starts, `ReturnBind is missing "commandResultOf".`, "bind.missing.command", "error", rb.tagName);
    } else {
      if (!fnSet.has(fn.toLowerCase())) {
        pushIssue(issues, xmlText, starts, `ReturnBind refers to unknown PowerShell function "${fn}".`, "bind.fn.unknown", "error", rb.tagName, "commandResultOf", fn);
      }
    }

    if (!nonEmpty(path)) {
      pushIssue(issues, xmlText, starts, `ReturnBind has empty "path" (property path).`, "bind.path.empty", "warning", rb.tagName);
    }
  }

  const binds = tagList(dom, "Bind");
  for (const b of binds) {
    const src = attr(b, "from") || attr(b, "From") || attr(b, "source") || attr(b, "Source");
    const dst = attr(b, "to") || attr(b, "To") || attr(b, "target") || attr(b, "Target");
    if (!nonEmpty(src) || !nonEmpty(dst)) {
      pushIssue(issues, xmlText, starts, `Bind missing "from"/"to".`, "bind.missing.fromto", "error", b.tagName);
    }
  }

  // 6) Attempt to infer context entity/property and cross-check with schema
  //    Heuristic: look for nearest ancestor with @name / @entity / @table that matches a schema entity.
  function nearestEntityName(el: Element): string | null {
    let cur: Element | null = el;
    while (cur) {
      const nameAttrs = ["entity","table","name","for","of"];
      for (const an of nameAttrs) {
        const v = cur.getAttribute(an);
        if (v && entMap.has(v.toLowerCase())) return v;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // For ReturnBind: if we can find a property name (from @path or sibling/parent attribute),
  // and an entity context, verify property exists.
  for (const rb of returnBinds) {
    const path = attr(rb, "path") || attr(rb, "Path");
    if (!nonEmpty(path)) continue;
    const entity = nearestEntityName(rb);
    if (entity) {
      const propSet = entMap.get(entity.toLowerCase())!;
      const leaf = String(path).trim().split(/[./[\]]+/).filter(Boolean).pop() ?? "";
      if (leaf && !propSet.has(leaf.toLowerCase())) {
        pushIssue(issues, xmlText, starts, `Property "${leaf}" not found in schema entity "${entity}".`, "schema.property.missing", "error", rb.tagName, "path", path);
      }
    } else {
      pushIssue(issues, xmlText, starts, `Could not infer entity context for ReturnBind to validate path "${path}".`, "schema.entity.unknown", "info", rb.tagName, "path", path);
    }
  }

  // 7) Required top-level sanity (very generic)
  const root = dom.documentElement;
  if (!root) {
    issues.push({ id: mkId(), message: "XML has no documentElement.", code: "xml.root.missing", severity: "error", line: 1 });
  } else {
    if (!root.getAttribute("name") && !root.getAttribute("Name")) {
      pushIssue(issues, xmlText, starts, `Root element <${root.tagName}> is missing a "name" attribute.`, "xml.root.noname", "warning", root.tagName);
    }
  }

  // 8) Duplicate name detection per common containers
  const nameBuckets = new Map<string, number>();
  const named = allElements.filter(e => e.hasAttribute("name") || e.hasAttribute("Name"));
  for (const el of named) {
    const n = (attr(el, "name") || attr(el, "Name")).trim();
    if (!n) continue;
    nameBuckets.set(n.toLowerCase(), (nameBuckets.get(n.toLowerCase()) ?? 0) + 1);
  }
  for (const [n, count] of nameBuckets.entries()) {
    if (count > 1) {
      pushIssue(issues, xmlText, starts, `Duplicate name "${n}" appears ${count} times.`, "xml.name.duplicate", "warning");
    }
  }

  // 9) Empty text nodes (sometimes signal mistakes)
  const walker = dom.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
  let tn: Node | null;
  while ((tn = walker.nextNode())) {
    const s = (tn.nodeValue ?? "").replace(/\s+/g, "");
    if (s.length === 0 && (tn.textContent?.includes("\n") ?? false)) {
      // informational, not marking inline
      issues.push({ id: mkId(), message: "Whitespace-only text node (likely harmless).", code: "xml.text.ws", severity: "info", line: 1 });
      break; // avoid spamming
    }
  }

  return issues;
}
