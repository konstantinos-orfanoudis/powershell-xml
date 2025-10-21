"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** ---------------- Shared Types ---------------- */
interface SchemaAttr { name: string; type?: string }
interface SchemaEntity { name: string; attributes?: SchemaAttr[] }
interface PsInput {
  name: string;
  type?: string;
  mandatory?: boolean;
  hasDefault?: boolean;
  source?: "Schema" | "Connection" | "Manual";
  isKey?: boolean;
}
interface PsMethod { functionName: string; inputs: PsInput[] }

/** Set Parameter type (globals.details.v2) */
type UiType = "String" | "Bool" | "Int" | "DateTime";
interface GlobalVar {
  id: string;
  name: string;
  type: UiType;
  description?: string;
  source: "ConnectionParameter" | "FixedValue" | "GlobalVariable" | "SwitchParameter" | "FixedArray";
  value?: string;
  values?: string[];
  sensitive?: boolean;
  secure?: boolean;
}

/** ---------------- Helpers: schema ---------------- */
function parseSchemaText(text: string): SchemaEntity[] {
  const raw = JSON.parse(text || "{}");
  const ents: SchemaEntity[] = Array.isArray(raw.entities)
    ? raw.entities
        .filter((e: any) => e && typeof e.name === "string" && e.name.trim())
        .map((e: any) => ({
          name: String(e.name).trim(),
          attributes: Array.isArray(e.attributes)
            ? e.attributes
                .map((a: any) => ({
                  name: String(a.name || "").trim(),
                  type: a.type ? String(a.type) : undefined,
                }))
                .filter((a: SchemaAttr) => a.name)
            : [],
        }))
    : [];
  if (!ents.length) throw new Error("No entities found in schema.json (expected entities[].name).");
  return ents;
}

/** ---------------- Helpers: UI types + sensitivity ---------------- */
const toUiType = (t?: string | UiType): UiType => {
  const s = String(t ?? "").trim().toLowerCase();
  if (s.includes("bool")) return "Bool";
  if (s.includes("int")) return "Int";
  if (s.includes("date")) return "DateTime";
  return "String";
};
const looksSensitive = (name: string): boolean =>
  /password|token|secret|apikey|api_key|bearer/i.test(name);

/** ---------------- PowerShell parser ----------------
 * - Keeps trailing inline comments to capture "# Source: X" and "# Key"
 * - Works for the last parameter (no trailing comma)
 */
function parsePsText(text: string): PsMethod[] {
  // Remove block comments but keep line comments (we need "# Source:" / "# Key")
  let src = text.replace(/<#[\s\S]*?#>/g, "");

  const methods: PsMethod[] = [];
  const fnRe = /\bfunction\s+(?:global:)?([A-Za-z][A-Za-z0-9_-]*)\s*\{([\s\S]*?)\}/gi;

  function findParamBlockBody(body: string): string | null {
    const m = /\bparam\s*\(/i.exec(body);
    if (!m) return null;
    const start = body.indexOf("(", m.index) + 1;
    let depth = 1;
    for (let i = start; i < body.length; i++) {
      const ch = body[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return body.slice(start, i);
      }
    }
    return null;
  }

  // --- KEY FIX: attach ", # Source: ..." comments to the segment that ends before the comma ---
  function splitParams(block: string): string[] {
    const out: string[] = [];
    let last = 0, par = 0, br = 0, inStr: '"' | "'" | null = null, esc = false;

    const push = (start: number, end: number) => {
      const seg = block.slice(start, end).trim();
      if (seg) out.push(seg);
    };

    for (let i = 0; i < block.length; i++) {
      const ch = block[i];

      if (inStr) {
        if (!esc && ch === inStr) inStr = null;
        esc = !esc && ch === "\\";
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = ch as any; esc = false; continue; }
      if (ch === "(") { par++; continue; }
      if (ch === ")") { par = Math.max(0, par - 1); continue; }
      if (ch === "[") { br++; continue; }
      if (ch === "]") { br = Math.max(0, br - 1); continue; }

      if (ch === "," && par === 0 && br === 0) {
        // Look ahead for ",  # Source: ...<EOL>" and attach that inline comment to this segment.
        let j = i + 1;
        while (j < block.length && /\s/.test(block[j])) j++;
        if (j < block.length && block[j] === "#") {
          // Consume until end of line (support CRLF / LF)
          let k = j;
          while (k < block.length && block[k] !== "\n" && block[k] !== "\r") k++;

          // Append the inline comment to the segment
          const seg = (block.slice(last, i) + " " + block.slice(j, k)).trim();
          if (seg) out.push(seg);

          // Advance 'last' to the char after EOL (handle CRLF)
          if (k < block.length && block[k] === "\r" && block[k + 1] === "\n") {
            last = k + 2;
            i = k + 1; // continue after CRLF
          } else {
            last = k + 1;
            i = k; // continue after LF or EOF
          }
          continue;
        }

        // Normal split (no trailing inline comment)
        push(last, i);
        last = i + 1;
      }
    }

    // Tail
    const tail = block.slice(last).trim();
    if (tail) out.push(tail);
    return out;
  }

  function parseParamLine(seg: string): PsInput | null {
    const s0 = seg.trim();
    if (!s0) return null;

    // Read inline markers anywhere in the segment
    let source: PsInput["source"] | undefined;
    let isKey = false;
    const afterHash = s0.split(/\s+#/).slice(1);
    for (const raw of afterHash) {
      const part = raw.trim();
      const mSrc = /^Source:\s*(Schema|Connection|Manual)\b/i.exec(part);
      if (mSrc) source = mSrc[1] as any;
      if (/^Key\b/i.test(part)) isKey = true;
    }

    // Robust Mandatory parser (other named args allowed)
    const mParam = s0.match(/\[Parameter\s*\(\s*[^)]*?\bMandatory\s*=\s*\$(true|false)[^)]*\)\]/i);
    const mandatory = mParam ? mParam[1].toLowerCase() === "true" : false;

    // Remove all [...] attribute blocks before finding $Name
    const s = s0.replace(/\[[^\]]*\]/g, "");
    const nameMatch = s.match(/\$([A-Za-z_]\w*)/);

    // Segment can be a pure "# Source" / "# Key" line
    if (!nameMatch) {
      if (source || isKey) return { name: "", source, isKey } as unknown as PsInput;
      return null;
    }

    const name = nameMatch[1];

    // Type: last [...] immediately before $Name (handles [string], [System.String], etc.)
    const idxName = s0.indexOf("$" + name);
    const left = idxName === -1 ? s0 : s0.slice(0, idxName);
    const typeMatch = left.match(/\[([^\]\(\)]+)\]\s*$/);
    const rawType = typeMatch ? `[${typeMatch[1]}]` : undefined;

    const hasDefault = new RegExp(`\\$${name}\\s*=`).test(s0);

    return { name, type: rawType, mandatory, hasDefault, source, isKey };
  }

  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(src))) {
    const functionName = m[1];
    const body = m[2] || "";
    const raw = findParamBlockBody(body);
    const inputs: PsInput[] = [];

    if (raw) {
      const parts = splitParams(raw);
      let lastIdx = -1;

      for (const part of parts) {
        const p = parseParamLine(part);
        if (!p) continue;

        // Standalone marker row → attach to previous param
        if (!p.name) {
          if (lastIdx >= 0) {
            if ((p as any).source && !inputs[lastIdx].source) inputs[lastIdx].source = (p as any).source;
            if ((p as any).isKey) inputs[lastIdx].isKey = true as any;
          }
          continue;
        }

        const i = inputs.findIndex(x => x.name.toLowerCase() === p.name.toLowerCase());
        if (i === -1) {
          inputs.push(p);
          lastIdx = inputs.length - 1;
        } else {
          inputs[i] = { ...inputs[i], ...p };
          lastIdx = i;
        }
      }
    }

    methods.push({ functionName, inputs });
  }

  methods.sort((a, b) => a.functionName.localeCompare(b.functionName));
  return methods;
}



/** ---------------- Assembly path validation ---------------- */
function trimQuotes(s: string) {
  return s.replace(/^["'](.+)["']$/, "$1");
}
function validateAssemblyPath(input: string): string | null {
  const path = trimQuotes(String(input || "").trim());
  if (!/\.dll$/i.test(path)) return "Path must end with .dll";
  if (/[<>"|?*]/.test(path)) return 'Path contains invalid characters: <>:"|?*';
  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(path);
  const isUNC        = /^\\\\[^\\\/]+\\[^\\\/]+\\/.test(path);
  const isUnixAbs    = /^\//.test(path);
  const isRelative   = /[\\/]/.test(path) && !/^\s+$/.test(path);
  if (isWindowsAbs || isUNC || isUnixAbs || isRelative) return null;
  return "Path format looks invalid";
}

/** ---------------- Seed Set Parameters from Source: Connection ---------------- */
function seedConnectionParamsFromMethods(methods: PsMethod[], existing: GlobalVar[]): GlobalVar[] {
  const list = Array.isArray(existing) ? [...existing] : [];
  const byName = new Map(list.map((p) => [p.name, p]));

  for (const method of methods) {
    for (const inp of method.inputs || []) {
      if (inp.source !== "Connection") continue;
      const nm = (inp.name || "").trim();
      if (!nm || byName.has(nm)) continue;

      const ui = toUiType(inp.type);
      const sensitive = looksSensitive(nm);
      const gv: GlobalVar = {
        id: `sp-${Date.now()}-${nm}`,
        name: nm,
        type: ui,
        description: "Auto-created from PowerShell (Source: Connection)",
        source: "ConnectionParameter",
        sensitive,
        secure: sensitive,
      };
      list.push(gv);
      byName.set(nm, gv);
    }
  }
  return list;
}

/** ---------------- Page ---------------- */
export default function UploadPage() {
  const router = useRouter();
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [psFile, setPsFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Assemblies state
  const [assemblies, setAssemblies] = useState<string[]>([]);

  // Input-driven add
  const [newAsm, setNewAsm] = useState("");
  const [asmFieldError, setAsmFieldError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const arr = JSON.parse(localStorage.getItem("plugin.assemblies") || "[]");
      if (Array.isArray(arr)) setAssemblies(arr.filter((x) => typeof x === "string"));
    } catch {
      // ignore
    }
  }, []);

  function normalizeInputs(raw: string): string[] {
    return raw
      .split(/\r?\n|,|;/)
      .map((s) => trimQuotes(s.trim()))
      .filter(Boolean);
  }

  function addAssembliesFromInput() {
    setAsmFieldError(null);
    const items = normalizeInputs(newAsm);
    if (!items.length) return;

    const errs: string[] = [];
    const next = [...assemblies];

    for (const p of items) {
      const err = validateAssemblyPath(p);
      if (err) { errs.push(`• ${p} — ${err}`); continue; }
      const exists = next.some((a) => a.toLowerCase() === p.toLowerCase());
      if (exists) { errs.push(`• ${p} — already in the list`); continue; }
      next.push(p);
    }

    if (errs.length) {
      setAsmFieldError(["Please fix the following:", ...errs].join("\n"));
    }

    if (next.length !== assemblies.length) {
      setAssemblies(next);
      localStorage.setItem("plugin.assemblies", JSON.stringify(next));
    }

    setNewAsm("");
  }

  function removeAssembly(idx: number) {
    const next = assemblies.filter((_, i) => i !== idx);
    setAssemblies(next);
    localStorage.setItem("plugin.assemblies", JSON.stringify(next));
  }

async function handleContinue(e: React.FormEvent) {
  e.preventDefault();
  setError(null);

  if (!jsonFile || !psFile) {
    setError("Please upload both files.");
    return;
  }

  // Validate stored assemblies
  const invalid = assemblies
    .map(p => ({ p, err: validateAssemblyPath(p) }))
    .filter(x => !!x.err);
  if (invalid.length) {
    setError(["Some assembly paths are invalid:", ...invalid.map(x => `• ${x.p} — ${x.err}`)].join("\n"));
    return;
  }

  try {
    const [schemaText, psText] = await Promise.all([jsonFile.text(), psFile.text()]);

    /** 1) Parse files */
    const entities = parseSchemaText(schemaText);
    const methods  = parsePsText(psText); // IMPORTANT: this sets .isKey when "# Key" is present

    // Persist the core things (and hard-reset mapping stores)
    localStorage.setItem("schema.entities", JSON.stringify(entities));
    localStorage.setItem("schema.tables", JSON.stringify(entities.map(e => e.name)));
    localStorage.setItem("ps.methods.v2", JSON.stringify(methods));

    localStorage.setItem("saved.mappings", JSON.stringify({}));
    localStorage.setItem("saved.mappings.v3", JSON.stringify({}));
    localStorage.setItem("bindings.v2", JSON.stringify({}));
    localStorage.setItem("bindings.v3", JSON.stringify({}));
    localStorage.setItem("table.displayProp", JSON.stringify({}));
    localStorage.setItem("table.uniqueProps", JSON.stringify({}));
    localStorage.setItem("table.customProps", JSON.stringify({}));
    localStorage.setItem("prop.meta.v1", JSON.stringify({}));

    // Assemblies
    localStorage.setItem("plugin.assemblies", JSON.stringify(assemblies || []));

    /** 2) Seed Set Parameters from Source: Connection */
    const prevGv: GlobalVar[] = (() => {
      try { return JSON.parse(localStorage.getItem("globals.details.v2") || "[]"); }
      catch { return []; }
    })();
    const seeded = seedConnectionParamsFromMethods(methods, prevGv);
    localStorage.setItem("globals.details.v2", JSON.stringify(seeded));

    /** 3) Detect entity name from function name */
    const fnEntity = (fn: string): string | null => {
      // Matches Get-Users, Create-User, Modify-Roles, Remove-Group, etc.
      const m = /^(?:Get|Create|Modify|Remove)-([A-Za-z]+)s?$/i.exec(fn.trim());
      if (!m) return null;
      const base = m[1];
      return base.charAt(0).toUpperCase() + base.slice(1);
    };

    /** 4) Build a robust key map per entity */
    const keyByEntity: Record<string, string> = {};

    // Pass 1: explicit "# Key"
    for (const m of methods) {
      const ent = fnEntity(m.functionName);
      if (!ent) continue;
      const k = m.inputs.find(inp => (inp as any).isKey);
      if (k && !keyByEntity[ent]) keyByEntity[ent] = k.name;
    }

    // Pass 2: Id-like param name (UserID, RoleID, Id) if not found in pass 1
    for (const m of methods) {
      const ent = fnEntity(m.functionName);
      if (!ent || keyByEntity[ent]) continue;
      const idLike = m.inputs.find(p => /(^id$|id$)/i.test(p.name));
      if (idLike) keyByEntity[ent] = idLike.name;
    }

    // Pass 3: if still missing, fallback to schema attribute that looks like Id
    for (const ent of entities) {
      if (keyByEntity[ent.name]) continue;
      const idish = (ent.attributes || []).find(a => /(^id$|id$)/i.test(a.name));
      if (idish) keyByEntity[ent.name] = idish.name;
    }

    console.log("[Upload] Detected keyByEntity:", keyByEntity);

    /** 5) Build prop.meta.v1 fresh and **set flags** on the detected key */
    const toUiType = (t?: string): UiType => {
      const s = String(t ?? "").toLowerCase();
      if (s.includes("bool")) return "Bool";
      if (s.includes("int")) return "Int";
      if (s.includes("date")) return "DateTime";
      return "String";
    };

    const nextMeta: Record<string, Record<string, any>> = {};

    for (const ent of entities) {
      const table = ent.name;
      const schemaAttrs = ent.attributes || [];
      const byName: Record<string, any> = {};

      // Defaults for all schema attributes
      for (const a of schemaAttrs) {
        byName[a.name] = {
          type: toUiType(a.type),
          description: "",
          access: "None",
          isAutofill: false,
          isMultiValue: false,
          isSecret: false,
          isObsolete: false,
          isRevision: false,
          isDisplay: false,
          isUnique:  false,
          isMandatory: false,
          returnBinds: [],
          referenceTargets: []
        };
      }

      // Flip flags for the key attribute (if it exists on this entity)
      const keyProp = keyByEntity[table];
      if (keyProp && byName[keyProp]) {
        byName[keyProp].isUnique   = true;
        byName[keyProp].isDisplay  = true;
        byName[keyProp].isAutofill = true;
      }

      nextMeta[table] = byName;
    }

    localStorage.setItem("prop.meta.v1", JSON.stringify(nextMeta));
    localStorage.setItem("table.uniqueProps", JSON.stringify(keyByEntity));
    localStorage.setItem("table.displayProp", JSON.stringify(keyByEntity));

    console.log("[Upload] Saved prop.meta.v1:", nextMeta);

    /** 6) Route to Map */
    router.push("/map");
  } catch (err: any) {
    setError(err?.message ?? "Failed to parse files.");
  }
}





  /** ---------------- Validation / UI state ---------------- */
  function trimQuotesLocal(s: string) { return s.replace(/^["'](.+)["']$/, "$1"); }
  const normalizeInputsLocal = (raw: string) => raw.split(/\r?\n|,|;/).map(s => trimQuotesLocal(s.trim())).filter(Boolean);

  const enteredPaths = normalizeInputsLocal(newAsm);
  const lower = (s: string) => trimQuotesLocal(s).toLowerCase();
  const assembliesLower = assemblies.map(lower);
  const enteredLower = enteredPaths.map(lower);

  const hasInvalidLive = enteredPaths.length > 0 && enteredPaths.some((p) => !!validateAssemblyPath(p));
  const hasInvalidStored = assemblies.some((p) => !!validateAssemblyPath(p));

  // Duplicates within entered input
  const seen = new Set<string>();
  const dupWithin = enteredLower.filter((v) => (seen.has(v) ? true : (seen.add(v), false)));
  // Duplicates against stored
  const setStored = new Set(assembliesLower);
  const dupAgainstStored = enteredLower.filter((v) => setStored.has(v));
  const hasDuplicateLive = dupWithin.length > 0 || dupAgainstStored.length > 0;

  // (Rare) duplicates already stored
  const seenStored = new Set<string>();
  const hasDuplicateStored = assembliesLower.some((v) => (seenStored.has(v) ? true : (seenStored.add(v), false)));

  // Live single-path hint (UX only)
  const liveHint = (() => {
    const trimmed = trimQuotes(newAsm.trim());
    if (!trimmed) return null;
    if (/[\r\n,;]+/.test(newAsm)) return "Multiple values detected — they'll be validated on Add.";
    const err = validateAssemblyPath(trimmed);
    if (err) return err;
    const exists = assembliesLower.includes(lower(trimmed));
    if (exists) return "Already added.";
    return null;
  })();

  const canContinue = !!jsonFile && !!psFile && !hasInvalidStored && !hasInvalidLive && !hasDuplicateLive && !hasDuplicateStored;

  const continueReason = !canContinue
    ? (!jsonFile || !psFile
        ? "Please upload both files."
        : hasInvalidStored
        ? "Some saved assembly paths are invalid."
        : hasInvalidLive
        ? "Fix invalid assembly path(s) in the input field."
        : hasDuplicateStored
        ? "Duplicate assemblies already in the list."
        : hasDuplicateLive
        ? `Remove duplicate path(s): ${Array.from(new Set([...dupWithin, ...dupAgainstStored])).slice(0, 3).join(", ")}${(dupWithin.length + dupAgainstStored.length) > 3 ? "…" : ""}`
        : null)
    : null;

  /** ---------------- UI (unchanged) ---------------- */
  return (
    <main className="min-h-screen bg-slate-50">
      {/* Step Header (dark) */}
      <header className="bg-slate-900 border-b border-slate-800 text-white">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div className="text-xl font-semibold">PowerShell Connector Builder</div>

          {/* Steps */}
          <div className="flex items-center gap-2 text-sm">
            <span className="rounded-full px-3 py-1 bg-emerald-500 text-white">1. Upload</span>
            <span className="text-slate-400">→</span>
            <span className="rounded-full px-3 py-1 bg-white/10 text-white/90 border border-white/20">2. Map</span>
            <span className="text-slate-400">→</span>
            <span className="rounded-full px-3 py-1 bg-white/10 text-white/90 border border-white/20">3. Inputs &amp; XML</span>
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="rounded-2xl border border-slate-200 bg-white shadow-lg">
          <div className="px-6 py-5 border-b bg-gradient-to-r from-slate-50 to-white rounded-t-2xl">
            <h1 className="text-2xl font-bold text-slate-900">Upload Required Files</h1>
            <p className="mt-1 text-slate-600">
              Provide your <b>schema.json</b> and <b>scripts.ps1</b> (global PowerShell functions).
            </p>
          </div>

          <form onSubmit={handleContinue} className="p-6 space-y-6">
            {/* JSON */}
            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1">JSON Schema</label>
              <input
                type="file"
                accept=".json,application/json"
                onChange={(e) => setJsonFile(e.target.files?.[0] ?? null)}
                className="block w-full rounded-lg border border-slate-300 bg-slate-50 p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-sky-700 file:px-4 file:py-2 file:text-white hover:file:opacity-90"
              />
              {jsonFile && <p className="mt-2 text-xs text-slate-500">Selected: {jsonFile.name}</p>}
            </div>

            {/* PS1 */}
            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1">PowerShell Script (.ps1)</label>
              <input
                type="file"
                accept=".ps1,text/plain,application/octet-stream"
                onChange={(e) => setPsFile(e.target.files?.[0] ?? null)}
                className="block w-full rounded-lg border border-slate-300 bg-slate-50 p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-sky-700 file:px-4 file:py-2 file:text-white hover:file:opacity-90"
              />
              {psFile && <p className="mt-2 text-xs text-slate-500">Selected: {psFile.name}</p>}
            </div>

            {/* Assemblies */}
            <div className="rounded-xl border border-slate-200 p-4 bg-slate-50">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">Optional Plugin Assemblies</h2>
              </div>
              <p className="mt-1 text-xs text-slate-600">
                Paste one or more <b>.dll</b> paths (newline, comma or semicolon separated). Click <i>Add</i> to include them.
              </p>

              {/* Inline Add Row */}
              <div className="mt-3 flex flex-col gap-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newAsm}
                    onChange={(e) => setNewAsm(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAssembliesFromInput(); } }}
                    placeholder="e.g. C:\Program Files\One Identity\Custom\MyPlugin.dll or /opt/plugins/MyConnector.dll"
                    className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-600"
                    aria-invalid={!!liveHint || hasInvalidLive || hasDuplicateLive}
                    aria-describedby="asm-hint asm-errors"
                  />
                  <button
                    type="button"
                    onClick={addAssembliesFromInput}
                    className="text-sm px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-black disabled:opacity-50"
                    disabled={!newAsm.trim()}
                  >
                    Add
                  </button>
                </div>

                {/* Live hint for single path */}
                {liveHint && (
                  <div id="asm-hint" className="text-xs text-rose-700 whitespace-pre-wrap">{liveHint}</div>
                )}
              </div>

              {assemblies.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">No assemblies added yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-200">
                  {assemblies.map((path, idx) => {
                    const err = validateAssemblyPath(path);
                    return (
                      <li key={`${path}-${idx}`} className="py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <code className={`text-sm break-all ${err ? "text-rose-700" : "text-slate-800"}`}>
                            {path}
                          </code>
                          {err && (
                            <div className="mt-1 text-xs text-rose-700">⚠ {err}</div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="text-xs text-red-600 hover:text-red-800 shrink-0"
                          onClick={() => removeAssembly(idx)}
                          title="Remove assembly"
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Field-level bulk add errors */}
              {asmFieldError && (
                <div id="asm-errors" className="mt-3 rounded-lg bg-red-50 text-red-700 border border-red-200 px-3 py-2 text-xs whitespace-pre-wrap">
                  {asmFieldError}
                </div>
              )}
            </div>

            {error && (
              <div className="rounded-lg bg-red-50 text-red-700 border border-red-200 px-3 py-2 text-sm whitespace-pre-wrap">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-2">
              <div className="text-sm text-rose-700">{!canContinue && continueReason}</div>
              <button
                type="submit"
                className="rounded-xl bg-sky-700 px-5 py-2.5 text-sm font-medium text-white shadow hover:bg-sky-800 disabled:opacity-50"
                disabled={!canContinue}
              >
                Continue → Map
              </button>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
