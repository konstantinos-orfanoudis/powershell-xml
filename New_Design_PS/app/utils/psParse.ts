// app/utils/psParse.ts
export interface PsInput { name: string; type?: string; mandatory?: boolean; hasDefault?: boolean }
export interface PsMethod { functionName: string; inputs: PsInput[] }

export function parsePsText(text: string): PsMethod[] {
  // strip XML-like and block comments <# ... #>, keep strings safe
  let src = text.replace(/<[\s\S]*?>/g, (m) => (m.startsWith("<#") ? "" : m));
  src = src.replace(/(^|[ \t])#.*$/gm, "$1"); // line comments

  const methods: PsMethod[] = [];
  const fnRe = /\bfunction\s+global:([A-Za-z][A-Za-z0-9_-]*)\s*\{/gi;

  function findParamBlock(s: string, from: number) {
    const m = /\bparam\s*\(/ig.exec(s.slice(from));
    if (!m) return null;
    const absOpen = from + m.index + m[0].lastIndexOf("(");
    let depth = 0;
    for (let i = absOpen; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return { inner: s.slice(absOpen + 1, i) };
      }
    }
    return null;
  }

  function splitParams(block: string): string[] {
    const out: string[] = [];
    let last = 0, par = 0, br = 0, inStr: '"' | "'" | null = null, esc = false;
    for (let i = 0; i < block.length; i++) {
      const ch = block[i];
      if (inStr) { if (!esc && ch === inStr) inStr = null; esc = (!esc && ch === "\\"); continue; }
      if (ch === '"' || ch === "'") { inStr = ch as '"' | "'"; esc = false; continue; }
      if (ch === "(") par++; else if (ch === ")") par = Math.max(0, par - 1);
      else if (ch === "[") br++; else if (ch === "]") br = Math.max(0, br - 1);
      else if (ch === "," && par === 0 && br === 0) { out.push(block.slice(last, i).trim()); last = i + 1; }
    }
    const tail = block.slice(last).trim();
    if (tail) out.push(tail);
    return out.filter(Boolean);
  }

  const RESERVED = new Set(["true","false","null","psscriptroot","pscommandpath","psboundparameters","args"]);
  function parseOne(seg: string): PsInput | null {
    const s = seg.trim(); if (!s) return null;
    const allVars = [...s.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
    let name: string | null = null;
    for (let i = allVars.length - 1; i >= 0; i--) {
      const v = allVars[i]; if (!RESERVED.has(v.toLowerCase())) { name = v; break; }
    }
    if (!name) return null;

    const brackets = [...s.matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim());
    let type: string | undefined;
    for (let i = brackets.length - 1; i >= 0; i--) {
      const b = brackets[i]; if (!/^\s*parameter\s*\(/i.test(b)) { type = b; break; }
    }
    if (!type && /\[switch\]/i.test(s)) type = "switch";

    let mandatory: boolean | undefined;
    const pAttr = brackets.find(b => /^\s*parameter\s*\(/i.test(b));
    if (pAttr) {
      const mm = pAttr.match(/Mandatory\s*=\s*\$?(true|false)/i);
      if (mm) mandatory = mm[1].toLowerCase() === "true";
    }
    const hasDefault = new RegExp(`\\$${name}\\s*=`).test(s);
    return { name, type, mandatory, hasDefault };
  }

  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(src))) {
    const functionName = m[1];
    const afterBrace = m.index + m[0].length;
    const pb = findParamBlock(src, afterBrace);
    const inputs: PsInput[] = [];
    if (pb) {
      for (const seg of splitParams(pb.inner)) {
        const p = parseOne(seg);
        if (p && !inputs.some(x => x.name.toLowerCase() === p.name.toLowerCase())) inputs.push(p);
      }
    }
    methods.push({ functionName, inputs });
  }

  methods.sort((a, b) => a.functionName.localeCompare(b.functionName));
  return methods;
}
