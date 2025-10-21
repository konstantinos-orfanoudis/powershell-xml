// app/api/parse/route.ts
import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // don't cache responses

/* -------------------- Types -------------------- */
interface PsInput { name: string; type?: string }
interface PsMethod { functionName: string; inputs: PsInput[] }

/* -------------------- Log file setup -------------------- */
function chooseBaseDir() {
  // Allow override; default to project root in dev; /tmp on serverless
  if (process.env.PS_LOG_DIR) return process.env.PS_LOG_DIR;
  if (process.env.VERCEL || process.env.NETLIFY || process.env.AWS_REGION) return "/tmp";
  return process.cwd();
}
let BASE = chooseBaseDir();
let LOG_DIR = path.resolve(BASE, "logs");
let LOG_FILE = path.resolve(LOG_DIR, "ps-parser.log");

async function ensureLogFile() {
  await fs.mkdir(LOG_DIR, { recursive: true });
  try { await fs.access(LOG_FILE); } catch { await fs.writeFile(LOG_FILE, "", "utf8"); }
}

async function appendRaw(filePath: string, text: string) {
  await fs.appendFile(filePath, text, "utf8");
}

/** Write with timestamp; fallback to /tmp if primary path fails */
async function writeLog(lines: string | string[]) {
  const arr = Array.isArray(lines) ? lines : [lines];
  const stamp = new Date().toISOString();
  const payload = arr.map(l => `[${stamp}] ${l}`).join("\n") + "\n";
  try {
    await ensureLogFile();
    await appendRaw(LOG_FILE, payload);
  } catch {
    // Fallback to /tmp
    const tmpDir = path.resolve("/tmp", "logs");
    const tmpFile = path.resolve(tmpDir, "ps-parser.log");
    await fs.mkdir(tmpDir, { recursive: true }).catch(() => {});
    await appendRaw(tmpFile, payload);
    BASE = "/tmp";
    LOG_DIR = tmpDir;
    LOG_FILE = tmpFile;
  }
}

async function writeTable(title: string, rows: Record<string, unknown>[] = []) {
  await writeLog(title);
  if (!rows.length) { await writeLog("(no rows)"); return; }
  const cols = Array.from(
    rows.reduce<Set<string>>((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set())
  );
  const header = cols.join("\t");
  const body = rows.map(r => cols.map(c => String(r[c] ?? "")).join("\t"));
  await writeLog([header, ...body]);
}

/* -------------------- PS parsing helpers -------------------- */
function grabBalanced(src: string, open: string, close: string, startIdx: number) {
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Robust parameter block parser: handles [Parameter(...)][string]$Var, [type]$Var, $Var */
function parseParamBlock(paramBlock: string): PsInput[] {
  const inputs: PsInput[] = [];
  const varRegex = /(?:\[[^\]]*\]\s*)*\$([A-Za-z_]\w*)/g; // attributes/types + $Var
  let m: RegExpExecArray | null;
  while ((m = varRegex.exec(paramBlock))) {
    const varName = m[1];
    // Look immediately to the left for the nearest [...] which is most likely the type/attr
    const left = paramBlock.slice(0, m.index);
    const typeMatch = left.match(/\[([^\]]+)\]\s*$/);
    const type = typeMatch ? typeMatch[1] : undefined;
    if (!inputs.some(i => i.name.toLowerCase() === varName.toLowerCase())) {
      inputs.push({ name: varName, type });
    }
  }
  return inputs;
}

/** New parser: header→next header slicing + balanced `param(...)` + robust var extraction */
function parsePsTextOnServer(text: string): PsMethod[] {
  const methods: PsMethod[] = [];
  const headerRe = /\bfunction\s+global:([A-Za-z][A-Za-z0-9_-]*)\s*(\(|\{)/gim;

  // 1) Collect function headers and their ranges
  const headers: { name: string; start: number; afterHeader: number }[] = [];
  let h: RegExpExecArray | null;
  while ((h = headerRe.exec(text))) {
    const name = h[1];
    const headerEnd = h.index + h[0].length - 1; // points at "(" or "{"
    headers.push({ name, start: h.index, afterHeader: headerEnd + 1 });
  }

  // Helper: find the matching closing parenthesis for a '(' at openIdx
  const findParenClose = (src: string, openIdx: number) => {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  };

  // Helper: extract variables from a param block, infer nearest [Type] before each $Var
  const parseParamBlock = (paramBlock: string): PsInput[] => {
    const out: PsInput[] = [];
    const seen = new Set<string>();
    const varRe = /\$([A-Za-z_]\w*)/g; // match any $Var inside the block
    let m: RegExpExecArray | null;
    while ((m = varRe.exec(paramBlock))) {
      const name = m[1];
      // ignore built-ins/booleans that can appear in attributes
      if (/^(true|false|null)$/i.test(name)) continue;

      // Infer a "type" by looking for the nearest [...] immediately before this $Var
      const left = paramBlock.slice(0, m.index);
      const typeMatch = left.match(/\[([^\]]+)\]\s*$/);
      const type = typeMatch ? typeMatch[1] : undefined;

      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ name, type });
      }
    }
    return out;
  };

  // 2) Process each function slice
  for (let i = 0; i < headers.length; i++) {
    const curr = headers[i];
    const next = headers[i + 1];
    const sliceEnd = next ? next.start : text.length;
    const slice = text.slice(curr.afterHeader, sliceEnd);

    // 3) Find balanced param(...)
    let inputs: PsInput[] = [];
    const paramIdx = slice.search(/param\s*\(/i);
    if (paramIdx >= 0) {
      // find the '(' position
      const openIdx = slice.indexOf("(", paramIdx);
      if (openIdx >= 0) {
        const closeIdx = findParenClose(slice, openIdx);
        if (closeIdx > openIdx) {
          const paramBlock = slice.slice(openIdx + 1, closeIdx);
          inputs = parseParamBlock(paramBlock);
        }
      }
    }

    methods.push({ functionName: curr.name, inputs });
  }

  methods.sort((a, b) => a.functionName.localeCompare(b.functionName));
  return methods;
}



/* -------------------- Handlers -------------------- */
/** GET helpers:
 *  - ?where=1  -> returns log file path
 *  - ?ping=1   -> writes a ping line
 *  - ?reset=1  -> truncates the log
 *  - ?read=1   -> returns the log file contents (text/plain)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);

  await writeLog("👋 GET /api/parse hit"); // ensure the file can't stay empty

  if (url.searchParams.get("reset") === "1") {
    await fs.mkdir(LOG_DIR, { recursive: true }).catch(() => {});
    await fs.writeFile(LOG_FILE, "", "utf8");
    await writeLog("🧹 Log reset.");
    return NextResponse.json({ ok: true, action: "reset", logFile: LOG_FILE });
  }
  if (url.searchParams.get("ping") === "1") {
    await writeLog("🔔 Ping");
    return NextResponse.json({ ok: true, action: "ping", logFile: LOG_FILE });
  }
  if (url.searchParams.get("where") === "1") {
    await ensureLogFile();
    await writeLog(`📍 where requested -> ${LOG_FILE}`);
    return NextResponse.json({ ok: true, logFile: LOG_FILE });
  }
  if (url.searchParams.get("read") === "1") {
    try {
      const buf = await fs.readFile(LOG_FILE, "utf8");
      return new NextResponse(buf, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message, logFile: LOG_FILE }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    hint: "POST .ps1 text (text/plain | JSON {text} | multipart form-data 'file'). Use ?where=1 to see log path.",
    logFile: LOG_FILE,
  });
}

/** POST: Accept raw .ps1 via text/plain, JSON {text}, or multipart 'file', parse and log */
export async function POST(req: Request) {
  try {
    const ct = req.headers.get("content-type") || "";
    let text = "";

    if (ct.includes("text/plain")) {
      text = await req.text();
    } else if (ct.includes("application/json")) {
      const json = await req.json();
      text = typeof (json as any)?.text === "string" ? (json as any).text : "";
    } else if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (file && typeof file !== "string") {
        text = await (file as File).text();
      }
    } else {
      // Fallback: try treating it as text
      text = await req.text();
    }

    await writeLog([
      "🚀 POST /api/parse",
      `content-type=${ct || "(none)"}`,
      `bodyLength=${text.length}`,
    ]);

    if (!text) {
      await writeLog("❗ Empty body. Expect text/plain, JSON {text}, or multipart 'file'.");
      return NextResponse.json({ error: "Empty body", logFile: LOG_FILE }, { status: 400 });
    }

    const methods = parsePsTextOnServer(text);

    await writeLog(`ℹ️ Functions found: ${methods.length}`);
    for (const m of methods) {
      await writeLog(`⚡ ${m.functionName}: inputs=${m.inputs.length}`);
      if (m.inputs.length) {
        await writeLog(`   → Inputs: ${m.inputs.map(i => `$${i.name}:${i.type ?? "any"}`).join(", ")}`);
      }
    }
    await writeTable("Summary", methods.map(m => ({
      function: m.functionName,
      inputs: m.inputs.length,
      sample: m.inputs.slice(0, 3).map(i => `$${i.name}`).join(", "),
    })));
    await writeLog(`✅ Done. Total functions: ${methods.length}`);

    return NextResponse.json({ methods, logFile: LOG_FILE });
  } catch (err: any) {
    await writeLog(`❌ ERROR: ${err?.message || String(err)}`);
    return NextResponse.json({ error: "Parse failed", logFile: LOG_FILE }, { status: 500 });
  }
}
