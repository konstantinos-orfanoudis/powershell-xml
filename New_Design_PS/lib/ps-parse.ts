// src/lib/ps-parse.ts
export type UiType = "String" | "Bool" | "Int" | "DateTime";
export type PsParam = {
  pid: string;
  name: string;
  type: UiType;
  mandatory: boolean;
  source: "Schema" | "Connection" | "Manual";
};
export type Fn = {
  id: string;
  name: string;
  script: string;
  convo: string;
  chat: string;
  xmlPreview: string;
  inputs?: PsParam[];
};

// --- logger helpers we want to ignore when importing ---
export const LOGGER_FN_NAMES = new Set([
  "Get-FunctionName",
  "Get-Logger",
  "Get-NewLogger",
  "Get-NewLogConfig",
  "Get-NewLogTarget",
  "Get-LogMessageLayout",
]);


// lib/parse-ps.ts
export type CanonVerb = "Get" | "Create" | "Update" | "Delete" | "Modify" | "Remove" | "";

export const VERB_ALIASES: Record<string, CanonVerb> = {
  get: "Get",
  create: "Create",
  update: "Update",
  modify: "Update",   // alias → Update
  delete: "Delete",
  remove: "Delete",
    // alias → Delete
};

/** Parse Verb-Noun and canonicalize the verb (Modify→Update, Remove→Delete). */
export function parseFnName(name: string): { verb: CanonVerb; entity: string } {
  const m = String(name || "").match(/^([A-Za-z_]+)-(.+)$/);
  if (!m) return { verb: "", entity: "" };
  const verb = VERB_ALIASES[m[1].toLowerCase()] ?? "";
  const noun = m[2];
  const entity = verb === "Get" && noun.endsWith("s") ? noun.slice(0, -1) : noun;
  return { verb, entity };
}

/** All acceptable function names for a given op and entity. */
export type MappingOps = "Insert" | "Update" | "Delete" | "List" | "View";
export function fnNamesForOp(entity: string, op: MappingOps): string[] {
  switch (op) {
    case "List":   return [`Get-${entity}s`];
    case "Insert": return [`Create-${entity}`, `New-${entity}`, `Add-${entity}`,`Insert-${entity}`];
    case "Update": return [`Modify-${entity}`, `Update-${entity}`];
    case "Delete": return [`Remove-${entity}`, `Delete-${entity}`];
    case "View":   return [];
    default:       return [];
  }
}

/** If you ever need to infer the connector operation from a function name. */
export type CanonOp = "List" | "Insert" | "Update" | "Delete" | "View" | "";
export function opFromFnName(name: string): CanonOp {
  const { verb } = parseFnName(name);
  if (verb === "Get")    return "List";
  if (verb === "Create") return "Insert";
  if (verb === "Update"  ) return "Update";
  if (verb === "Delete") return "Delete";
  return "";
}


// --------- internal helpers ----------
function randId() {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function uiFromPsTypeToken(token?: string): UiType {
  const t = String(token || "").toLowerCase();
  if (t.includes("bool")) return "Bool";
  if (t.includes("int")) return "Int";
  if (t.includes("date")) return "DateTime";
  return "String";
}

/** Find matching closing token respecting quotes/escapes. */
function findMatching(text: string, openIdx: number, openChar: string, closeChar: string): number {
  let depth = 0, inS = false, inD = false, esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "`") { esc = true; continue; }
    if (inS) { if (ch === "'") inS = false; continue; }
    if (inD) { if (ch === '"') inD = false; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function extractParamBlock(body: string): string | null {
  const m = body.match(/(^|\s)param\s*\(/i);
  if (!m || m.index == null) return null;
  const lp = body.indexOf("(", m.index + (m[1] ? m[1].length : 0));
  if (lp < 0) return null;
  const rp = findMatching(body, lp, "(", ")");
  if (rp < 0) return null;
  return body.slice(lp + 1, rp);
}

function parseParamsFromParamBlock(block: string): PsParam[] {
  // Split on commas that are NOT inside [] or () to keep attribute lists intact
  const parts = block
    .split(/,(?![^\[\]]*\])(?!(?:[^()]*\)))/g)
    .map(s => s.trim())
    .filter(Boolean);

  const out: PsParam[] = [];

  for (const rawPart of parts) {
    const raw = rawPart.replace(/\r?\n/g, " ").trim();
    if (!raw) continue;

    // 1) Find ALL $identifiers, then pick the last non-meta one
    const nameMatches = [...raw.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
    const paramName = [...nameMatches]
      .reverse()
      .find(n => !/^(true|false|null|env|args|psitem|_)$/i.test(n));
    if (!paramName) continue;

    // 2) Determine the [Type] closest to the variable (prefer the last [Type] in the chunk)
    //    Example: [Parameter(...)] [string] $UserID
    //    We take the last [...] token that looks like a type annotation.
    const bracketTokens = [...raw.matchAll(/\[([A-Za-z0-9_.]+)\]/g)].map(m => ({
      token: m[1],
      index: m.index ?? 0,
    }));
    let typeToken = "string";
    if (bracketTokens.length) {
      typeToken = bracketTokens[bracketTokens.length - 1].token;
    }
    const type = uiFromPsTypeToken(typeToken);

    // 3) Mandatory flag
    const mandatory = /\bMandatory\s*=\s*\$?true\b/i.test(raw);

    // 4) Optional: Source via inline hint " # Source: X"
    let source: "Schema" | "Connection" | "Manual" = "Manual";
    const sourceHint = raw.match(/#\s*Source:\s*(Schema|Connection|Manual)/i)?.[1];
    if (sourceHint) source = sourceHint as any;

    out.push({
      pid: randId(),
      name: paramName,
      type,
      mandatory,
      source,
    });
  }
  return out;
}


// --------- public API ----------
/** Parse a .ps1/.psm1 text into Fn[] (logger helpers skipped). */
export function parsePsFileToFns(text: string): Fn[] {
  const src = text || "";
  const fns: Fn[] = [];
  const re = /function\s+(?:global:)?([A-Za-z_][A-Za-z0-9_-]*)\s*\{/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src))) {
    const fnName = m[1];
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatching(src, openIdx, "{", "}");
    if (closeIdx < 0) break;

    if (LOGGER_FN_NAMES.has(fnName)) {
      re.lastIndex = closeIdx + 1;
      continue;
    }

    const fullDef = src.slice(m.index, closeIdx + 1);
    const body = src.slice(openIdx + 1, closeIdx);
    const pb = extractParamBlock(body);
    const inputs = pb ? parseParamsFromParamBlock(pb) : [];

    fns.push({
      id: randId(),
      name: fnName,
      script: fullDef,
      convo: "",
      chat: "",
      xmlPreview: "",
      inputs,
    });

    re.lastIndex = closeIdx + 1;
  }
  return fns;
}
