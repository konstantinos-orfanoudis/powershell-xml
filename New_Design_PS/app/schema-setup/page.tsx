/* app/schema-setup/page.tsx */
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/** Modes & Protocols */
type Mode = "auto" | "specific";
type Protocol = "rest" | "graphql" | "soap" | "postman" | "samples";

/** File accept strings */
const ACCEPT_BY_PROTOCOL: Record<Protocol, string> = {
  rest: ".json,.yaml,.yml",
  graphql: ".graphql,.gql,.json",
  soap: ".wsdl,.xsd,.xml",
  postman: ".json",
  samples: ".json,.xml,.csv",
};

const ACCEPT_ALL =
  ".json,.yaml,.yml,.graphql,.gql,.wsdl,.xsd,.xml,.csv,.postman_collection.json";

/** Visual metadata per protocol (badges & examples) */
const PROTOCOL_META: Record<
  Protocol,
  {
    title: string;
    color: string; // tailwind color base for accent
    primaryBadge: string; // the main spec type
    badges: { label: string; ext: string }[];
    examples: string[];
    recommendedNote: string;
  }
> = {
  rest: {
    title: "REST (OpenAPI / Swagger)",
    color: "sky",
    primaryBadge: "OpenAPI",
    badges: [
      { label: "OpenAPI JSON", ext: ".json" },
      { label: "OpenAPI YAML", ext: ".yaml" },
      { label: "OpenAPI YAML", ext: ".yml" },
    ],
    examples: ["openapi.json", "swagger.yaml"],
    recommendedNote:
      "OpenAPI spec is recommended for precise endpoints & types. Sample JSON responses also help.",
  },
  graphql: {
    title: "GraphQL (SDL / Introspection)",
    color: "purple",
    primaryBadge: "GraphQL",
    badges: [
      { label: "SDL", ext: ".graphql" },
      { label: "SDL", ext: ".gql" },
      { label: "Introspection", ext: ".json" },
    ],
    examples: ["schema.graphql", "schema.gql", "introspection.json"],
    recommendedNote:
      "Provide SDL (.graphql/.gql) or an introspection JSON for accurate type generation.",
  },
  soap: {
    title: "SOAP (WSDL / XSD)",
    color: "amber",
    primaryBadge: "WSDL",
    badges: [
      { label: "WSDL", ext: ".wsdl" },
      { label: "XSD", ext: ".xsd" },
      { label: "Sample SOAP", ext: ".xml" },
    ],
    examples: ["Service.wsdl", "types.xsd", "GetUserResponse.xml"],
    recommendedNote:
      "A WSDL is recommended; XSD/XML samples refine complex types and arrays.",
  },
  postman: {
    title: "Postman Collection",
    color: "emerald",
    primaryBadge: "Postman",
    badges: [{ label: "Collection", ext: ".json" }],
    examples: ["MyAPI.postman_collection.json", "collection.json"],
    recommendedNote:
      "A collection JSON helps infer resources and example payloads quickly.",
  },
  samples: {
    title: "Raw Samples Only",
    color: "slate",
    primaryBadge: "Samples",
    badges: [
      { label: "JSON", ext: ".json" },
      { label: "XML", ext: ".xml" },
      { label: "CSV", ext: ".csv" },
    ],
    examples: ["users.json", "user.xml", "users.csv"],
    recommendedNote:
      "Add multiple representative payloads. Arrays become entities, fields become attributes.",
  },
};

export default function SchemaSetupPage() {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>("auto");
  const [protocol, setProtocol] = useState<Protocol>("soap");
  const [files, setFiles] = useState<File[]>([]);
  const [namingHints, setNamingHints] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Soft guidance (non-blocking)
  const [warnings, setWarnings] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]); // only truly blocking (e.g., zero files)

  useEffect(() => {
    sessionStorage.removeItem("schema.sources.v1");
    sessionStorage.removeItem("schema.namingHints.v1");
    sessionStorage.removeItem("schema.generated.v1");
  }, []);

  const accept = mode === "auto" ? ACCEPT_ALL : ACCEPT_BY_PROTOCOL[protocol];
  const meta = PROTOCOL_META[protocol];

  function onPickFiles(list: FileList | null) {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!e.dataTransfer.files?.length) return;
    onPickFiles(e.dataTransfer.files);
  }
  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  function guessMime(name: string): string {
    const low = name.toLowerCase();
    if (low.endsWith(".json")) return "application/json";
    if (low.endsWith(".yaml") || low.endsWith(".yml")) return "application/yaml";
    if (low.endsWith(".graphql") || low.endsWith(".gql"))
      return "application/graphql";
    if (/\.(wsdl|xsd|xml)$/.test(low)) return "application/xml";
    if (low.endsWith(".csv")) return "text/csv";
    return "text/plain";
  }

  /** Only truly blocking errors */
  function collectBlockingErrors(): string[] {
    const errs: string[] = [];
    if (files.length === 0) errs.push("Please upload at least one file.");
    if (namingHints.trim()) {
      try {
        const obj = JSON.parse(namingHints);
        if (typeof obj !== "object" || Array.isArray(obj))
          errs.push("Naming hints must be a JSON object.");
      } catch {
        errs.push("Naming hints is not valid JSON.");
      }
    }
    return errs;
  }

  /** Non-blocking advisory warnings (specs optional) */
  function collectAdvisoryWarnings(): string[] {
    const warns: string[] = [];
    if (mode !== "specific") return warns;
    const names = files.map((f) => f.name.toLowerCase());

    if (protocol === "soap" && !names.some((n) => n.endsWith(".wsdl"))) {
      warns.push("SOAP: No .wsdl found. We’ll infer structure from XSD/XML samples where possible.");
    }
    if (protocol === "rest" && !names.some((n) => /\.(json|yaml|yml)$/.test(n))) {
      warns.push("REST: No OpenAPI (.json/.yaml/.yml) found. Inference will rely on payload samples.");
    }
    if (protocol === "graphql" && !names.some((n) => /\.(graphql|gql|json)$/.test(n))) {
      warns.push("GraphQL: No SDL (.graphql/.gql) or introspection JSON found. Provide example query responses.");
    }
    if (protocol === "postman" && !names.some((n) => n.endsWith(".json"))) {
      warns.push("Postman: No collection .json found. Consider adding one or provide sample responses.");
    }

    return warns;
  }

  async function readAllFiles(fs: File[]) {
    const out: { name: string; type: string; text: string }[] = [];
    for (const f of fs) {
      out.push({ name: f.name, type: f.type || guessMime(f.name), text: await f.text() });
    }
    return out;
  }

  async function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    const hard = collectBlockingErrors();
    const soft = collectAdvisoryWarnings();

    setErrors(hard);
    setWarnings(soft);

    if (hard.length) return; // only block on true errors

    setBusy(true);
    try {
      const payload = {
        mode,
        protocol: mode === "specific" ? protocol : undefined,
        files: await readAllFiles(files),
      };
      sessionStorage.setItem("schema.sources.v1", JSON.stringify(payload));
      if (namingHints.trim()) {
        sessionStorage.setItem("schema.namingHints.v1", namingHints.trim());
      } else {
        sessionStorage.removeItem("schema.namingHints.v1");
      }
      // proceed regardless of warnings
      router.push("/schema-review");
    } finally {
      setBusy(false);
    }
  }

  /** UI helpers */
  const ModeCard = ({
    id,
    label,
    checked,
    onChange,
    description,
  }: {
    id: string;
    label: string;
    checked: boolean;
    onChange: () => void;
    description: React.ReactNode;
  }) => (
    <label
      htmlFor={id}
      className={`flex-1 min-w-[260px] cursor-pointer rounded-xl border p-4 ${
        checked ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:bg-slate-50"
      }`}
    >
      <div className="flex items-center gap-3">
        <input id={id} type="radio" checked={checked} onChange={onChange} />
        <div>
          <div className="font-semibold text-slate-900">{label}</div>
          <div className="text-sm text-slate-600 mt-0.5">{description}</div>
        </div>
      </div>
    </label>
  );

  const ProtocolCard = ({ p }: { p: Protocol }) => {
    const m = PROTOCOL_META[p];
    const selected = mode === "specific" && p === protocol;
    return (
      <button
        type="button"
        onClick={() => mode === "specific" && setProtocol(p)}
        className={`w-full text-left rounded-xl border p-4 transition ${
          selected
            ? "border-slate-900 bg-white shadow-sm"
            : "border-slate-200 bg-slate-50 hover:bg-white"
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="font-semibold text-slate-900">{m.title}</div>
          <span
            className={`text-xs rounded-full px-2 py-0.5 border bg-${m.color}-50 text-${m.color}-800 border-${m.color}-200`}
          >
            {m.primaryBadge}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {m.badges.map((b, i) => (
            <span
              key={i}
              className={`text-[11px] rounded-full px-2 py-0.5 border bg-${m.color}-50 text-${m.color}-800 border-${m.color}-200`}
              title={b.label}
            >
              {b.ext}
            </span>
          ))}
        </div>
        <div className="mt-2 text-xs text-slate-600">
          <span className="font-medium">Examples:</span> {m.examples.join(" · ")}
        </div>
        <div className="mt-2 text-xs text-slate-600 italic">
          {m.recommendedNote}
        </div>
      </button>
    );
  };

  const SpecificBanner = () => (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-slate-900">Recommended files</div>
        <div
          className={`text-xs rounded-full px-2 py-0.5 border bg-${meta.color}-50 text-${meta.color}-800 border-${meta.color}-200`}
        >
          {meta.title}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {meta.badges.map((b, i) => (
          <span
            key={i}
            className={`text-[12px] rounded-full px-2 py-0.5 border bg-${meta.color}-100 text-${meta.color}-900 border-${meta.color}-200`}
          >
            {b.label} <b>{b.ext}</b>
          </span>
        ))}
      </div>
      <div className="mt-2 text-xs text-slate-600">
        <span className="font-medium">Examples:</span> {meta.examples.join(" · ")}
      </div>
    </div>
  );

  /** Render */
  return (
    <main className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-slate-900 text-white border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="text-lg font-semibold">Schema Generator — Offline Inputs Only</div>
          <div className="text-sm opacity-80">1) Choose format → 2) Upload → 3) Review</div>
        </div>
        <Link href="/logout?return=/login">Sign out</Link>
      </div>
      

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {/* Mode */}
        <section className="rounded-2xl border border-slate-200 bg-white shadow">
          <div className="px-6 py-4 border-b">
            <h1 className="text-xl font-semibold text-slate-900">Choose input mode</h1>
          </div>
          <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <ModeCard
              id="mode-auto"
              label="Auto-detect formats"
              checked={mode === "auto"}
              onChange={() => setMode("auto")}
              description={
                <>Drop OpenAPI, GraphQL, WSDL/XSD, Postman, or JSON/XML/CSV samples.</>
              }
            />
            <ModeCard
              id="mode-specific"
              label="Specific format"
              checked={mode === "specific"}
              onChange={() => setMode("specific")}
              description={<>Get focused hints & recommendations for one protocol.</>}
            />
          </div>

          {mode === "specific" && (
            <div className="px-6 pb-6">
              <div className="mb-3 text-sm text-slate-700">Select protocol</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ProtocolCard p="rest" />
                <ProtocolCard p="graphql" />
                <ProtocolCard p="soap" />
                <ProtocolCard p="postman" />
                <ProtocolCard p="samples" />
              </div>
            </div>
          )}
        </section>

        {/* Highlight recommendations for selected protocol */}
        {mode === "specific" && <SpecificBanner />}

        {/* Upload */}
        <section className="rounded-2xl border border-slate-200 bg-white shadow">
          <div className="px-6 py-4 border-b">
            <h2 className="text-lg font-semibold text-slate-900">Upload files</h2>
            <p className="text-sm text-slate-600">You can add multiple files.</p>
          </div>

          <div className="p-6 space-y-4">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center"
            >
              <div className="text-slate-800 font-medium">Drag & drop files here</div>
              <div className="text-xs text-slate-500 mt-1">
                Accepted:{" "}
                {mode === "auto"
                  ? "OpenAPI/GraphQL/WSDL/XSD/Postman/JSON/XML/CSV"
                  : ACCEPT_BY_PROTOCOL[protocol]}
              </div>
              <div className="mt-3">
                <label className="inline-block">
                  <span className="rounded-md bg-slate-900 text-white px-4 py-2 text-sm cursor-pointer hover:bg-black">
                    Choose files
                  </span>
                  <input
                    type="file"
                    multiple
                    accept={accept}
                    className="hidden"
                    onChange={(e) => onPickFiles(e.target.files)}
                  />
                </label>
              </div>
            </div>

            {files.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="px-4 py-2 border-b text-sm font-medium text-slate-900">
                  Selected ({files.length})
                </div>
                <ul className="divide-y divide-slate-100">
                  {files.map((f, idx) => (
                    <li
                      key={`${f.name}-${idx}`}
                      className="px-4 py-2 flex items-center justify-between"
                    >
                      <div className="min-w-0">
                        <div className="font-mono text-sm truncate">{f.name}</div>
                        <div className="text-xs text-slate-500">{f.type || "unknown"}</div>
                      </div>
                      <button
                        type="button"
                        className="text-xs text-rose-700 hover:text-rose-900"
                        onClick={() => removeFile(idx)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        {/* Naming hints */}
        <section className="rounded-2xl border border-slate-200 bg-white shadow">
          <div className="px-6 py-4 border-b">
            <h2 className="text-lg font-semibold text-slate-900">Entity naming hints (optional)</h2>
            <p className="text-sm text-slate-600">
              Override inferred entity names. Example:{" "}
              <code className="px-1 py-0.5 bg-slate-100 rounded text-xs">
                {"{ \"/users\": \"User\", \"roles\": \"Role\" }"}
              </code>
            </p>
          </div>
          <div className="p-6">
            <textarea
              className="w-full h-28 rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
              placeholder='Optional JSON mapping, e.g. { "/users": "User" }'
              value={namingHints}
              onChange={(e) => setNamingHints(e.target.value)}
            />
          </div>
        </section>

        {/* Blocking errors */}
        {errors.length > 0 && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <div className="font-semibold mb-1">Fix these to continue:</div>
            <ul className="list-disc ml-5">
              {errors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Advisory warnings (non-blocking) */}
        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="font-semibold mb-1">Recommendations:</div>
            <ul className="list-disc ml-5">
              {warnings.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setFiles([]);
              setNamingHints("");
              setWarnings([]);
              setErrors([]);
            }}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
          >
            Clear
          </button>
          <button
            onClick={handleContinue}
            disabled={busy || files.length === 0}
            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow hover:bg-emerald-700 disabled:opacity-50"
          >
            Continue →
          </button>
        </div>
      </div>
    </main>
  );
}
