"use client";

import React, { useEffect, useRef, useState } from "react";
import { buildSchemaFromSoap } from "@/lib/soap/buildSchemaFromSoap";
import { detectUploadKind } from "@/lib/detectUpload";
import { scimToSchema } from "@/lib/scim/scimToConnectorSchema";
import { detectFormat } from "@/lib/detect/detectFormat";
import Link from "next/link";

/* ---------------- Upload types ---------------- */
type Status = "pending" | "uploading" | "done" | "error" | "processing";
type Item = {
  id: string;
  file: File;
  status: Status;
  statusCode?: number;
  message?: string;
};


function isPdfFile(f: File) {
  return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
}

async function extractPdfViaApi(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/pdf", { method: "POST", body: form });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const j = await res.json();
  if (!j?.ok) throw new Error(j?.error || "Extraction failed");
  return j.text as string;
}

function isEnt(x: any): x is Entity {
  return x && typeof x.name === "string" && Array.isArray(x.attributes);
}
function isSchema(x: any): x is Schema {
  return x && Array.isArray(x.entities);
}

/** Merge an array (or single) schema into one Schema object */
function mergeSchemas(input: unknown): Schema {
  const docs: Schema[] = Array.isArray(input)
    ? (input as unknown[]).filter(isSchema)
    : isSchema(input) ? [input] : [];

  const base: Schema = {
    name: docs.find(d => d.name)?.name ?? "Connector",
    version: docs.find(d => d.version)?.version ?? "1.0.0",
    entities: [],
  };

  const byName = new Map<string, Entity>();

  for (const d of docs) {
    for (const e of d.entities) {
      if (!isEnt(e)) continue;

      let target = byName.get(e.name);
      if (!target) {
        // clone attributes so we don’t mutate originals
        target = { name: e.name, attributes: [...(e.attributes ?? [])] };
        byName.set(e.name, target);
        continue;
      }

      // de-dupe attributes by name
      const have = new Set(target.attributes.map(a => a.name));
      for (const a of e.attributes ?? []) {
        if (a?.name && !have.has(a.name)) {
          target.attributes.push(a);
          have.add(a.name);
        }
      }
    }
  }

  base.entities = [...byName.values()];
  return base;
}


/* ---------------- Schema model ---------------- */
type AttrType = "String" | "Int"  | "Bool" | "Datetime";
type Attribute = { name: string; type: AttrType; MultiValue: boolean; IsKey?: boolean }; 
type Entity = { name: string; attributes: Attribute[] };
type Schema = { name: string; version: string; entities: Entity[] };

const TYPE_OPTIONS: AttrType[] = ["String", "Int", "Bool", "Datetime"];

/* ---------------- Helpers ---------------- */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function id30Base62(len = 30): string {
  const out: string[] = [];
  const n = ALPHABET.length;
  const limit = 256 - (256 % n);
  const buf = new Uint8Array(len * 2);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const v = buf[i];
      if (v < limit) out.push(ALPHABET[v % n]);
    }
  }
  return out.join("");
}

export default function UploadPage() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // schema json text + parsed
  const [schemaText, setSchemaText] = useState<string>("");
  const [schema, setSchema] = useState<Schema | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [selectedEntity, setSelectedEntity] = useState(0);

  // expand modal
  const [expanded, setExpanded] = useState(false);

  /* ---------- keep editor in sync with textarea ---------- */
useEffect(() => {
  if (!schemaText.trim()) {
    setSchema(null);
    setParseError(null);
    return;
  }
  try {
    const obj = JSON.parse(schemaText) as Schema;
    if (!obj || !Array.isArray(obj.entities)) throw new Error("Missing entities[]");

    const norm: Schema = {
      ...obj,
      entities: obj.entities.map((e) => ({
        ...e,
        attributes: (e.attributes || []).map((a: any) => {
          const copy: any = { ...a };

          // Prefer IsKey, convert from isKey if needed
          const val =
            Object.prototype.hasOwnProperty.call(copy, "IsKey")
              ? !!copy.IsKey
              : Object.prototype.hasOwnProperty.call(copy, "isKey")
              ? !!copy.isKey
              : false;

          copy.IsKey = val;      // single source of truth for JSON
          copy.isKey = val;      // internal convenience for the checkbox
          delete copy.isKey;     // (optional) if you don't want to keep the convenience flag in memory
          delete copy.iskey;     // defensive
          delete copy.isKey;     // remove lowercase from incoming docs

          return copy;
        }),
      })),
    };

    setSchema(norm);
    setParseError(null);
    if (selectedEntity >= norm.entities.length) setSelectedEntity(0);
  } catch (e: any) {
    setParseError(e?.message || "Invalid JSON");
  }
}, [schemaText]); // eslint-disable-line


  /* ---------- file picking ---------- */
  function pickFilesClick() {
    inputRef.current?.click();
  }
  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list?.length) return;
    const next: Item[] = Array.from(list).map((f) => ({
      id: `${f.name}-${f.size}-${f.lastModified}-${crypto.randomUUID()}`,
      file: f,
      status: "pending",
    }));
    setItems((prev) => {
      const map = new Map(prev.map((p) => [`${p.file.name}-${p.file.size}`, p]));
      next.forEach((n) => map.set(`${n.file.name}-${n.file.size}`, n));
      return Array.from(map.values());
    });
    e.target.value = "";
  }
  function removeOne(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }
  function setStatus(id: string, status: Status, message?: string) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status, message } : it)));
  }

  /* ---------- fixed-delay polling of result route ---------- */
  const POLL_DELAYS_MS = [10000, 15000, 15000, 10000, 15000];
  async function pollResultWithDelays(requestId: string) {
    for (let i = 0; i < POLL_DELAYS_MS.length; i++) {
      await new Promise((r) => setTimeout(r, POLL_DELAYS_MS[i]));
      const res = await fetch(`/api/ai/resultFiles?id=${encodeURIComponent(requestId)}`);
      if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` as const };
      const j = await res.json();
      if (j?.ok && j.result) return { ok: true as const, result: j.result };
    }
    return { ok: false as const, error: "No result within polling window" };
  }

  async function readTextHead(f: File, max = 400_000) {
  const blob = f.size > max ? f.slice(0, max) : f;
  return (await blob.text()).trim();
}

async function readScimDocs(files: File[]) {
  const schemas: any[] = [];
  const resourceTypes: any[] = [];

  for (const f of files) {
    if (!f.name.toLowerCase().endsWith(".json")) continue;
    try {
      const txt = await readTextHead(f);
      const j = JSON.parse(txt);

      // /Schemas response: { Resources: [ ...schema objects...] }
      if (Array.isArray(j?.Resources) && j.Resources.some((r: any) => r?.attributes)) {
        // could be /Schemas or /ResourceTypes; sort by fields present
        const schemasPart = j.Resources.filter((r: any) => Array.isArray(r?.attributes));
        const rtPart = j.Resources.filter((r: any) => r?.schema || r?.schemaExtensions);
        schemas.push(...schemasPart);
        resourceTypes.push(...rtPart);
        continue;
      }

      // single Schema doc
      if (j?.attributes && typeof j?.id === "string") {
        schemas.push(j);
        continue;
      }

      // /ResourceTypes response or single ResourceType
      if (Array.isArray(j) && j.some((r: any) => r?.schema || r?.schemaExtensions)) {
        resourceTypes.push(...j);
        continue;
      }
      if (j?.schema || j?.schemaExtensions) {
        resourceTypes.push(j);
        continue;
      }
    } catch {
      // ignore non-JSON files in the batch
    }
  }

  return { schemas, resourceTypes };
}

  /* ---------- submit ---------- */
  async function submitAll() {
    if (!items.length) return;
    setSubmitting(true);
     
    const kind = await detectUploadKind(items.map(i => i.file));
    if (kind === "scim") {
      const files = items.map(i => i.file)
      const { schemas, resourceTypes } = await readScimDocs(files);
      if (schemas.length || resourceTypes.length) {
        const schemaObj = scimToSchema(
          resourceTypes,
          schemas,
          {
            schemaName: "Connector",
            version: "1.0.0",
            preferUserNameAsKey: true, // optional
          }
        );
        setSchemaText(JSON.stringify(schemaObj, null, 2));
        setItems(prev => prev.map(i => ({ ...i, status: "done", message: "SCIM parsed" })));
        return; // skip AI route
      }
    }
    else if (kind === "soap"){
        const texts = await Promise.all(Array.from(items).map(f => f.file.text()));
        const schema = buildSchemaFromSoap(texts, { scope: "union" });
        setItems((prev) => prev.map((i) => ({ ...i, status: "done", message: "Completed" })));
        setSchemaText(JSON.stringify(schema, null, 2));
        return;
    }
    else{
    const request_id = id30Base62();

    try {
      await Promise.all(
        items.map(async (it) => {
          setStatus(it.id, "uploading");
          const form = new FormData();
          form.append("file", it.file);
          form.append("request_id", request_id);
          form.append("filename", it.file.name);
          form.append("fileType", it.file.type || "application/octet-stream");
          form.append("size", String(it.file.size));
          try {
            const res = await fetch("/api/ai/submitFile", { method: "POST", body: form });
            if (!res.ok) {
              setStatus(it.id, "error", `${res.status} ${res.statusText}`);
              return;
            }
            await res.json().catch(() => ({} as any));
            setStatus(it.id, "processing", "Queued");
          } catch {
            setStatus(it.id, "error", "Network error");
          }
        })
      );
      const out = await pollResultWithDelays(request_id);
      if (out.ok) {
        const text = typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2);
        const docs = JSON.parse(text);

        const merged = mergeSchemas(docs); 

// now set it
setSchemaText(JSON.stringify(merged, null, 2));
        setItems((prev) => prev.map((i) => ({ ...i, status: "done", message: "Completed" })));
      } else {
        setSchemaText(out.error);
        setItems((prev) => prev.map((i) => ({ ...i, status: "error", message: out.error })));
      }
    } finally {
      setSubmitting(false);
    }
  }
}

  function downloadSchemaFile(text: string, filename = "schema.json") {
  const blob = new Blob([text ?? ""], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
const onDownloadSchema = () => {
  const raw = (schemaText || "").trim();
  if (!raw) return;

  try {
    // pretty-print if it’s valid JSON
    const pretty = JSON.stringify(JSON.parse(raw), null, 2);
    downloadSchemaFile(pretty);
  } catch {
    // not valid JSON — offer to download as-is
    const ok = confirm("The content isn’t valid JSON. Download it as-is?");
    if (ok) downloadSchemaFile(raw);
  }
};

  /* ---------- schema editing actions ---------- */
  function updateEntityName(idx: number, name: string) {
    if (!schema) return;
    const s = structuredClone(schema);
    s.entities[idx].name = name || "Entity";
    setSchema(s);
  }
  function addAttribute(idx: number) {
    if (!schema) return;
    const s = structuredClone(schema);
    s.entities[idx].attributes.push({
      name: "new_field",
      type: "String",
      MultiValue: false,
      IsKey: false,
    });
    setSchema(s);
  }

function uniqueEntityName(base: string, existing: string[]) {
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function addEntity() {
  // allow creating when schema is empty or null
  const empty: Schema = { name: "Connector", version: "1.0.0", entities: [] };
  const s = structuredClone(schema ?? empty);
  const existingNames = s.entities.map(e => e.name);
  const name = uniqueEntityName("Entity", existingNames);
  s.entities.push({
    name,
    attributes: [
      { name: "id", type: "String", MultiValue: false, IsKey: true }, // starter field
    ],
  });
  setSchema(s);
  setSelectedEntity(s.entities.length - 1);
}

function removeEntity(idx: number) {
  if (!schema) return;
  if (idx < 0 || idx >= schema.entities.length) return;

  const s = structuredClone(schema);
  s.entities.splice(idx, 1);

  // If nothing left, keep an empty schema (or set null if you prefer)
  if (s.entities.length === 0) {
    setSchema(s);
    setSelectedEntity(0);
    return;
  }

  // Clamp selected index
  const nextIdx = Math.max(0, Math.min(idx, s.entities.length - 1));
  setSchema(s);
  setSelectedEntity(nextIdx);
}


  function removeAttribute(ei: number, ai: number) {
    if (!schema) return;
    const s = structuredClone(schema);
    s.entities[ei].attributes.splice(ai, 1);
    setSchema(s);
  }
  function updateAttrName(ei: number, ai: number, name: string) {
    if (!schema) return;
    const s = structuredClone(schema);
    s.entities[ei].attributes[ai].name = name || "field";
    setSchema(s);
  }
  function updateAttrType(ei: number, ai: number, type: AttrType) {
    if (!schema) return;
    const s = structuredClone(schema);
    s.entities[ei].attributes[ai].type = type;
    setSchema(s);
  }
  function updateAttrMV(ei: number, ai: number, mv: boolean) {
    if (!schema) return;
    const s = structuredClone(schema);
    s.entities[ei].attributes[ai].MultiValue = mv;
    setSchema(s);
  }
  function toggleKey(ei: number, ai: number, makeKey: boolean) {
    if (!schema) return;
    const s = structuredClone(schema);
    s.entities[ei].attributes.forEach((attr, idx) => {
      attr.IsKey = makeKey && idx === ai;          // only the clicked one can be true
    });
    setSchema(s);
  }



useEffect(() => {
  if (!schema) return;
  const replacer = (k: string, v: any) => {
    if (k === "isKey") return undefined;   // never show lowercase key
    if (k.startsWith("__")) return undefined;
    return v;
  };
  setSchemaText(JSON.stringify(schema, replacer, 2));
}, [schema]);

const logoutHref = "/.auth/logout?post_logout_redirect_uri=/login";

  /* ---------------- UI ---------------- */
  return (
    <main className="min-h-screen bg-slate-50 py-10">
      {/* Upload header */}
      <div className="mx-auto max-w-6xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Upload & Submit</h1>
        <p className="mt-1 text-sm text-slate-600">
          Pick one or more files. Click <b>Submit</b>, we’ll poll for the result and show it on the right.
          Supported files are: <b>JSON, XML, WSDL, XSD, PDF </b>.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-black"
          >
            Choose files
          </button>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={onPick} />
          <button
            type="button"
            disabled={submitting || items.length === 0}
            onClick={submitAll}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? "Submitting…" : `Submit ${items.length || ""}`}
          </button>
          <button
            type="button"
            disabled={submitting || items.length === 0}
            onClick={() => setItems([])}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Clear
          </button>
          <a
            href={logoutHref}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 hover:bg-slate-50"
          >
            Sign out
          </a>
        </div>

        {items.length > 0 && (
          <div className="mt-5 rounded-lg border border-slate-200">
            <div className="border-b px-3 py-2 text-sm font-medium text-slate-900">Files ({items.length})</div>
            <ul className="divide-y">
              {items.map((it) => (
                <li key={it.id} className="flex items-center justify-between px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-slate-800">{it.file.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {(it.file.size / 1024).toFixed(1)} KB · {it.file.type || "unknown type"}
                    </div>
                    {it.message && (
                      <div className="mt-1 text-[11px] text-slate-600 truncate max-w-[520px]">{it.message}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-xs " +
                        (it.status === "pending"
                          ? "bg-slate-100 text-slate-800"
                          : it.status === "uploading"
                          ? "bg-amber-100 text-amber-900"
                          : it.status === "processing"
                          ? "bg-blue-100 text-blue-900"
                          : it.status === "done"
                          ? "bg-emerald-100 text-emerald-900"
                          : "bg-rose-100 text-rose-900")
                      }
                    >
                      {it.status}
                    </span>
                    <button
                      disabled={submitting || it.status === "uploading"}
                      onClick={() => removeOne(it.id)}
                      className="text-xs text-rose-700 hover:text-rose-900 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* === Two-column editor + Schema.json === */}
      <div className="mx-auto max-w-6xl mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: Entities & attributes */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900">Schema Editor</div>
            <div className="text-xs text-slate-500">
              {schema ? `Entities: ${schema.entities.length}` : "No schema loaded"}
            </div>
          </div>

          <div className="p-4">
            {!schema ? (
              <div className="text-sm text-slate-500">Load a schema to edit (submit a file first).</div>
            ) : (
              <>
              <div className="flex items-center justify-between mb-3">
  <div className="text-xs text-slate-600">Entities</div>
  <div className="flex items-center gap-2">
    <button
      onClick={addEntity}
      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
    >
      + Add entity
    </button>
    <button
      onClick={() => removeEntity(selectedEntity)}
      disabled={!schema || schema.entities.length === 0}
      className="rounded-md border border-rose-300 text-rose-700 px-3 py-1.5 text-xs hover:bg-rose-50 disabled:opacity-50"
      title="Remove current entity"
    >
      Remove entity
    </button>
  </div>
</div>
                {/* Entity picker + rename */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div>
                    <label className="text-xs text-slate-600">Select entity</label>
                    <select
                      className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      value={selectedEntity}
                      onChange={(e) => setSelectedEntity(Number(e.target.value))}
                    >
                      {schema.entities.map((e, i) => (
                        <option key={i} value={i}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-xs text-slate-600">Rename entity</label>
                    <input
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                      value={schema.entities[selectedEntity]?.name || ""}
                      onChange={(e) => updateEntityName(selectedEntity, e.target.value)}
                    />
                  </div>
                </div>

                {/* Attributes */}
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs text-slate-600">
                      Attributes ({schema.entities[selectedEntity].attributes.length})
                    </div>
                    <button
                      onClick={() => addAttribute(selectedEntity)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
                    >
                      + Add attribute
                    </button>
                  </div>

                  <div className="space-y-2">
                    {schema.entities[selectedEntity].attributes.map((a, ai) => (
                      <div key={`${a.name}-${ai}`} className="grid grid-cols-12 gap-2 items-center">
                        {/* Name */}
                        <input
                          className="col-span-4 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                          value={a.name}
                          onChange={(e) => updateAttrName(selectedEntity, ai, e.target.value)}
                        />
                        {/* Type */}
                        <select
                          className="col-span-3 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                          value={a.type}
                          onChange={(e) => updateAttrType(selectedEntity, ai, e.target.value as AttrType)}
                        >
                          {TYPE_OPTIONS.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        {/* MultiValue */}
                        <label className="col-span-2 inline-flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!!a.MultiValue}
                            onChange={(e) => updateAttrMV(selectedEntity, ai, e.target.checked)}
                          />
                          <span>MultiValue</span>
                        </label>
                        {/* Key (single per entity) */}
                        <label className="col-span-2 inline-flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!!a.IsKey}                           // <-- reflect current key flag
                            onChange={(e) => toggleKey(selectedEntity, ai, e.target.checked)}
                          />
                          <span>Key</span>
                        </label>
                        {/* Remove */}
                        <button
                          className="col-span-1 text-xs text-rose-700 hover:text-rose-900"
                          onClick={() => removeAttribute(selectedEntity, ai)}
                          title="Remove attribute"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* RIGHT: Schema.json with Expand */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900">Schema.json</div>
            <button
              onClick={() => setExpanded(true)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
              title="Expand"
            >
              Expand
            </button>
          </div>
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <button
              onClick={onDownloadSchema}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Download schema.json
            </button>
          </div>
          <textarea
            className="w-full h-[520px] font-mono text-xs leading-5 p-3 outline-none"
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
            spellCheck={false}
            placeholder="Schema.json will appear here…"
          />
          {parseError && (
            <div className="px-4 py-2 text-xs text-rose-700 border-t border-rose-200 bg-rose-50">
              JSON parse error: {parseError}
            </div>
          )}
        </div>
      </div>

      {/* Expand modal */}
      {expanded && (
        <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center">
          <div className="w-[92vw] h-[86vh] rounded-xl overflow-hidden border border-slate-300 bg-white shadow-2xl">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">Schema.json (Expanded)</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    try {
                      navigator.clipboard.writeText(schemaText);
                    } catch {}
                  }}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
                >
                  Copy
                </button>
                <button
                  onClick={() => setExpanded(false)}
                  className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-xs hover:bg-black"
                >
                  Close
                </button>
              </div>
            </div>
            <textarea
              className="w-full h-[calc(86vh-56px)] font-mono text-sm leading-6 p-3 outline-none"
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
              spellCheck={false}
            />
          </div>
        </div>
      )}
    </main>
  );
}
