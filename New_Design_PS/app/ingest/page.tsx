/* app/ingest/page.tsx */
"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

/* ---------------- Types ---------------- */
type Protocol = "auto" | "rest" | "soap" | "graphql" | "csv" | "custom";
type AuthKind = "none" | "bearer" | "apiKey" | "basic" | "ntlm";

type SniffResult = {
  confidence: number;    // 0..1
  protocol: Exclude<Protocol, "auto">;
  reason: string;
};

type IngestConfig =
  | {
      protocol: "auto";
      generic: {
        endpointOrBaseUrl?: string;
        auth: {
          kind: AuthKind;
          token?: string;
          headerName?: string;
          username?: string;
          password?: string;
        };
        filesMeta: { name: string; size: number; type: string }[];
        detected?: SniffResult | null;
      };
    }
  | {
      protocol: "rest";
      baseUrl: string;
      auth?: { kind: Extract<AuthKind, "none" | "bearer" | "apiKey">; token?: string; headerName?: string };
      openapiUrlOrFile?: string;
    }
  | {
      protocol: "soap";
      wsdlUrlOrFile: string;
      binding?: string;
      port?: string;
      auth?: { kind: Extract<AuthKind, "none" | "basic" | "ntlm">; username?: string; password?: string };
    }
  | {
      protocol: "graphql";
      endpoint: string;
      useIntrospection: boolean;
      auth?: { kind: Extract<AuthKind, "none" | "bearer" | "apiKey">; token?: string; headerName?: string };
    }
  | {
      protocol: "csv";
      delimiter: string;
      hasHeader: boolean;
      encoding: string;
      sampleFileName?: string;
    }
  | {
      protocol: "custom";
      parserModuleId: string;
    };

/* ---------------- Helpers ---------------- */
async function fileToText(f: File): Promise<string> {
  return await f.text();
}

function isLikelyJSON(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

function looksLikeOpenAPI(jsonStr: string): boolean {
  try {
    const o = JSON.parse(jsonStr) as Record<string, unknown>;
    return !!(o && (o["openapi"] || o["swagger"]) && o["paths"]);
  } catch {
    return false;
  }
}

function isLikelyXML(s: string): boolean {
  const t = s.trim();
  return t.startsWith("<") && /<\?xml|<\/?[A-Za-z]/.test(t);
}

function looksLikeWSDL(xml: string): boolean {
  return /<definitions[^>]*xmlns:wsdl=|<wsdl:definitions/i.test(xml);
}

function looksLikeSOAP(xml: string): boolean {
  return /<Envelope[^>]*xmlns(:\w+)?="http:\/\/schemas\.xmlsoap\.org\/soap|<soap:Envelope/i.test(xml);
}

function looksLikeGraphQLSDL(s: string): boolean {
  return /\btype\s+Query\b|\btype\s+Mutation\b|\bschema\s*\{/.test(s);
}

function looksLikeCSV(s: string): boolean {
  const t = s.trim();
  if (!t || t.startsWith("<") || t.startsWith("{") || t.startsWith("[")) return false;
  const lines = t.split(/\r?\n/).slice(0, 10).filter(Boolean);
  if (lines.length < 2) return false;
  const candidates = [",", ";", "\t", "|"];
  for (const sep of candidates) {
    const counts = lines.map(l => l.split(sep).length).filter(n => n > 1);
    if (counts.length >= Math.max(2, Math.floor(lines.length * 0.6))) {
      const unique = new Set(counts);
      if (unique.size <= 3) return true;
    }
  }
  return false;
}

async function sniffFiles(files: File[]): Promise<SniffResult | null> {
  const primary = files[0];
  if (!primary) return null;

  const name = primary.name.toLowerCase();
  const text = await fileToText(primary);

  if (name.endsWith(".wsdl")) {
    return { confidence: 0.99, protocol: "soap", reason: "File has .wsdl extension" };
  }
  if (name.includes("openapi") || name.endsWith(".yaml") || name.endsWith(".yml")) {
    return { confidence: 0.7, protocol: "rest", reason: "File name suggests OpenAPI" };
  }

  if (isLikelyJSON(text)) {
    if (looksLikeOpenAPI(text)) {
      return { confidence: 0.95, protocol: "rest", reason: "JSON looks like OpenAPI" };
    }
    return { confidence: 0.7, protocol: "rest", reason: "Sample looks like JSON REST payload" };
  }

  if (isLikelyXML(text)) {
    if (looksLikeWSDL(text)) {
      return { confidence: 0.98, protocol: "soap", reason: "XML looks like WSDL" };
    }
    if (looksLikeSOAP(text)) {
      return { confidence: 0.9, protocol: "soap", reason: "XML looks like SOAP Envelope" };
    }
    return { confidence: 0.6, protocol: "soap", reason: "XML detected" };
  }

  if (looksLikeGraphQLSDL(text)) {
    return { confidence: 0.85, protocol: "graphql", reason: "GraphQL SDL detected" };
  }

  if (looksLikeCSV(text)) {
    return { confidence: 0.8, protocol: "csv", reason: "Delimited text (CSV-like) detected" };
  }

  return null;
}

/* ---------------- Page ---------------- */
export default function IngestPage() {
  const router = useRouter();

  // Core selection
  const [protocol, setProtocol] = useState<Protocol>("auto");
  const [detected, setDetected] = useState<SniffResult | null>(null);

  // Shared files (user may drop samples/specs)
  const [files, setFiles] = useState<File[]>([]);

  // --- Generic (Auto-detect) capture fields ---
  const [genericEndpoint, setGenericEndpoint] = useState("");
  const [genericAuthKind, setGenericAuthKind] = useState<AuthKind>("none");
  const [genericToken, setGenericToken] = useState("");
  const [genericHeaderName, setGenericHeaderName] = useState("Authorization");
  const [genericUsername, setGenericUsername] = useState("");
  const [genericPassword, setGenericPassword] = useState("");

  // --- Manual protocol specific (still available when not 'auto') ---
  const [restBaseUrl, setRestBaseUrl] = useState("");
  const [restAuthKind, setRestAuthKind] = useState<"none" | "bearer" | "apiKey">("none");
  const [restToken, setRestToken] = useState("");
  const [restHeaderName, setRestHeaderName] = useState("Authorization");
  const [restOpenApi, setRestOpenApi] = useState<File | null>(null);

  const [wsdl, setWsdl] = useState<File | null>(null);
  const [wsdlUrl, setWsdlUrl] = useState("");
  const [soapAuthKind, setSoapAuthKind] = useState<"none" | "basic" | "ntlm">("none");
  const [soapUsername, setSoapUsername] = useState("");
  const [soapPassword, setSoapPassword] = useState("");

  const [graphqlEndpoint, setGraphqlEndpoint] = useState("");
  const [graphqlAuthKind, setGraphqlAuthKind] = useState<"none" | "bearer" | "apiKey">("none");
  const [graphqlToken, setGraphqlToken] = useState("");
  const [graphqlHeaderName, setGraphqlHeaderName] = useState("Authorization");
  const [graphqlUseIntrospection, setGraphqlUseIntrospection] = useState(true);

  const [csvDelimiter, setCsvDelimiter] = useState(",");
  const [csvHasHeader, setCsvHasHeader] = useState(true);
  const [csvEncoding, setCsvEncoding] = useState("utf-8");
  const [csvSample, setCsvSample] = useState<File | null>(null);

  const [parserModuleId, setParserModuleId] = useState("");

  // Busy/error state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-detect on file changes (only when protocol is auto)
  useEffect(() => {
    let cancelled = false;
    async function run() {
      setDetected(null);
      if (protocol !== "auto" || files.length === 0) return;
      const sn = await sniffFiles(files);
      if (!cancelled && sn) setDetected(sn);
    }
    run();
    return () => { cancelled = true; };
  }, [files, protocol]);

  const effectiveProtocol: Protocol = useMemo(() => {
    if (protocol !== "auto") return protocol;
    return detected?.protocol ?? "auto";
  }, [protocol, detected]);

  const canContinue = useMemo(() => {
    if (protocol === "auto") {
      // In auto mode: allow continue if we have either files OR an endpoint/base URL
      // (optional auth is fine)
      return files.length > 0 || genericEndpoint.trim().length > 0;
    }

    // Manual protocols: validate basic required fields
    switch (effectiveProtocol) {
      case "rest":
        return !!restBaseUrl || !!restOpenApi;
      case "soap":
        return !!wsdl || !!wsdlUrl;
      case "graphql":
        return graphqlEndpoint.trim().length > 0;
      case "csv":
        return !!csvSample || files.length > 0;
      case "custom":
        return parserModuleId.trim().length > 0;
      default:
        return false;
    }
  }, [
    protocol,
    effectiveProtocol,
    files.length,
    genericEndpoint,
    restBaseUrl,
    restOpenApi,
    wsdl,
    wsdlUrl,
    graphqlEndpoint,
    csvSample,
    parserModuleId,
  ]);

  const onPickFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setFiles(list);
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const list = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    setFiles(list);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  function resetErrors() {
    setError(null);
  }

  function saveAndGo() {
    resetErrors();
    setBusy(true);
    try {
      let config: IngestConfig;

      if (protocol === "auto") {
        config = {
          protocol: "auto",
          generic: {
            endpointOrBaseUrl: genericEndpoint || undefined,
            auth: {
              kind: genericAuthKind,
              token: ["bearer", "apiKey"].includes(genericAuthKind) ? genericToken : undefined,
              headerName: genericAuthKind === "apiKey" ? (genericHeaderName || "Authorization") : undefined,
              username: ["basic", "ntlm"].includes(genericAuthKind) ? genericUsername : undefined,
              password: ["basic", "ntlm"].includes(genericAuthKind) ? genericPassword : undefined,
            },
            filesMeta: files.map(f => ({ name: f.name, size: f.size, type: f.type })),
            detected,
          },
        };
      } else {
        switch (effectiveProtocol) {
          case "rest": {
            const auth =
              restAuthKind === "none"
                ? { kind: "none" as const }
                : restAuthKind === "bearer"
                ? ({ kind: "bearer" as const, token: restToken })
                : ({ kind: "apiKey" as const, token: restToken, headerName: restHeaderName || "Authorization" });
            config = {
              protocol: "rest",
              baseUrl: restBaseUrl,
              auth,
              openapiUrlOrFile: restOpenApi?.name ?? undefined,
            };
            break;
          }
          case "soap": {
            const auth =
              soapAuthKind === "none"
                ? { kind: "none" as const }
                : soapAuthKind === "basic"
                ? ({ kind: "basic" as const, username: soapUsername, password: soapPassword })
                : ({ kind: "ntlm" as const, username: soapUsername, password: soapPassword });
            config = {
              protocol: "soap",
              wsdlUrlOrFile: wsdl?.name || wsdlUrl,
              auth,
            };
            break;
          }
          case "graphql": {
            const auth =
              graphqlAuthKind === "none"
                ? { kind: "none" as const }
                : graphqlAuthKind === "bearer"
                ? ({ kind: "bearer" as const, token: graphqlToken })
                : ({ kind: "apiKey" as const, token: graphqlToken, headerName: graphqlHeaderName || "Authorization" });
            config = {
              protocol: "graphql",
              endpoint: graphqlEndpoint,
              useIntrospection: graphqlUseIntrospection,
              auth,
            };
            break;
          }
          case "csv": {
            config = {
              protocol: "csv",
              delimiter: csvDelimiter || ",",
              hasHeader: csvHasHeader,
              encoding: csvEncoding || "utf-8",
              sampleFileName: csvSample?.name ?? files[0]?.name,
            };
            break;
          }
          case "custom": {
            config = {
              protocol: "custom",
              parserModuleId,
            };
            break;
          }
          default: {
            setError("Select or detect a protocol to continue.");
            setBusy(false);
            return;
          }
        }
      }

      const payload = {
        config,
        filesMeta: files.map(f => ({ name: f.name, size: f.size, type: f.type })),
        detected,
      };
      sessionStorage.setItem("ingest.config.v1", JSON.stringify(payload));

      router.push("/ingest/review");
    } catch (err) {
      console.error(err);
      setError("Failed to save configuration.");
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- UI ---------------- */
  const header = (
    <div className="border-b bg-slate-900 text-white">
      <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
        <div className="text-lg font-semibold">Source Setup</div>
        <div className="text-sm opacity-80">Step 1 of 2 — Configure Source</div>
      </div>
    </div>
  );

  const ProtocolButton: React.FC<{ value: Protocol; label: string }> = ({ value, label }) => {
    const active = protocol === value;
    return (
      <button
        type="button"
        onClick={() => setProtocol(value)}
        className={`px-3 py-1.5 rounded-lg border text-sm ${
          active ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
        }`}
        aria-pressed={active}
      >
        {label}
      </button>
    );
  };

  return (
    <main className="min-h-screen bg-slate-50">
      {header}

      <div className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT: Protocol + Inputs */}
        <section className="lg:col-span-2 space-y-6">
          {/* Protocol Picker */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="px-6 py-4 border-b">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-900">Data Source Type</h2>
                {protocol === "auto" && detected && (
                  <span className="inline-flex items-center gap-2 text-xs rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 px-3 py-1" title={detected.reason}>
                    Detected: <b className="uppercase">{detected.protocol}</b>
                    <span className="opacity-70">({Math.round(detected.confidence * 100)}%)</span>
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-slate-600">
                Choose how we should interpret your inputs. <b>Auto-detect</b> hides protocol details and
                lets you provide generic connection info + sample/spec files.
                Select a protocol for manual setup.
              </p>
            </div>

            <div className="p-6">
              <div className="flex flex-wrap gap-2">
                <ProtocolButton value="auto" label="Auto-detect" />
                <ProtocolButton value="rest" label="REST / JSON" />
                <ProtocolButton value="soap" label="SOAP / WSDL" />
                <ProtocolButton value="graphql" label="GraphQL" />
                <ProtocolButton value="csv" label="CSV / Files" />
                <ProtocolButton value="custom" label="Custom" />
              </div>
            </div>
          </div>

          {/* ---- AUTO-DETECT: Generic capture panel (only visible in auto) ---- */}
          {protocol === "auto" && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="px-6 py-4 border-b">
                <h3 className="text-sm font-semibold text-slate-900">Generic Connection (Auto)</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Provide a base URL/endpoint (optional) and any authentication. Add sample/spec files on the right.
                </p>
              </div>
              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-slate-800 mb-1">Endpoint / Base URL (optional)</label>
                  <input
                    value={genericEndpoint}
                    onChange={(e) => setGenericEndpoint(e.target.value)}
                    placeholder="https://api.example.com | https://service.example.com?wsdl | https://api.example.com/graphql"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">Auth</label>
                  <select
                    value={genericAuthKind}
                    onChange={(e) => setGenericAuthKind(e.target.value as AuthKind)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="apiKey">API Key (header)</option>
                    <option value="basic">Basic (user/pass)</option>
                    <option value="ntlm">NTLM (user/pass)</option>
                  </select>
                </div>

                {/* Token-based */}
                {(genericAuthKind === "bearer" || genericAuthKind === "apiKey") && (
                  <div>
                    <label className="block text-sm font-medium text-slate-800 mb-1">
                      {genericAuthKind === "bearer" ? "Token" : "Key"}
                    </label>
                    <input
                      value={genericToken}
                      onChange={(e) => setGenericToken(e.target.value)}
                      placeholder={genericAuthKind === "bearer" ? "eyJhbGciOi..." : "abcd-1234"}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}

                {/* API Key header */}
                {genericAuthKind === "apiKey" && (
                  <div>
                    <label className="block text-sm font-medium text-slate-800 mb-1">Header name</label>
                    <input
                      value={genericHeaderName}
                      onChange={(e) => setGenericHeaderName(e.target.value)}
                      placeholder="X-API-KEY"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}

                {/* User/Pass */}
                {(genericAuthKind === "basic" || genericAuthKind === "ntlm") && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-800 mb-1">Username</label>
                      <input
                        value={genericUsername}
                        onChange={(e) => setGenericUsername(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-800 mb-1">Password</label>
                      <input
                        type="password"
                        value={genericPassword}
                        onChange={(e) => setGenericPassword(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ---- Manual protocol panels (only when NOT auto) ---- */}
          {protocol !== "auto" && effectiveProtocol === "rest" && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="px-6 py-4 border-b">
                <h3 className="text-sm font-semibold text-slate-900">REST / JSON</h3>
              </div>
              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-slate-800 mb-1">Base URL</label>
                  <input
                    value={restBaseUrl}
                    onChange={(e) => setRestBaseUrl(e.target.value)}
                    placeholder="https://api.example.com"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">Auth</label>
                  <select
                    value={restAuthKind}
                    onChange={(e) => setRestAuthKind(e.target.value as typeof restAuthKind)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="apiKey">API Key</option>
                  </select>
                </div>

                {(restAuthKind === "bearer" || restAuthKind === "apiKey") && (
                  <div>
                    <label className="block text-sm font-medium text-slate-800 mb-1">
                      {restAuthKind === "bearer" ? "Token" : "Key"}
                    </label>
                    <input
                      value={restToken}
                      onChange={(e) => setRestToken(e.target.value)}
                      placeholder={restAuthKind === "bearer" ? "eyJhbGciOi..." : "abcd-1234"}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}

                {restAuthKind === "apiKey" && (
                  <div>
                    <label className="block text-sm font-medium text-slate-800 mb-1">Header name</label>
                    <input
                      value={restHeaderName}
                      onChange={(e) => setRestHeaderName(e.target.value)}
                      placeholder="X-API-KEY"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-slate-800 mb-1">OpenAPI (optional)</label>
                  <input
                    type="file"
                    accept=".json,.yaml,.yml,application/json,text/yaml,text/x-yaml"
                    onChange={(e) => setRestOpenApi(e.target.files?.[0] ?? null)}
                    className="block w-full rounded-lg border border-slate-300 bg-slate-50 p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-white hover:file:opacity-90"
                  />
                </div>
              </div>
            </div>
          )}

          {protocol !== "auto" && effectiveProtocol === "soap" && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="px-6 py-4 border-b">
                <h3 className="text-sm font-semibold text-slate-900">SOAP / WSDL</h3>
              </div>
              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">WSDL URL</label>
                  <input
                    value={wsdlUrl}
                    onChange={(e) => setWsdlUrl(e.target.value)}
                    placeholder="https://service.example.com?wsdl"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">Or upload WSDL</label>
                  <input
                    type="file"
                    accept=".wsdl,.xml,text/xml"
                    onChange={(e) => setWsdl(e.target.files?.[0] ?? null)}
                    className="block w-full rounded-lg border border-slate-300 bg-slate-50 p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-white hover:file:opacity-90"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">Auth</label>
                  <select
                    value={soapAuthKind}
                    onChange={(e) => setSoapAuthKind(e.target.value as typeof soapAuthKind)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="none">None</option>
                    <option value="basic">Basic</option>
                    <option value="ntlm">NTLM</option>
                  </select>
                </div>

                {soapAuthKind !== "none" && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-800 mb-1">Username</label>
                      <input
                        value={soapUsername}
                        onChange={(e) => setSoapUsername(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-800 mb-1">Password</label>
                      <input
                        type="password"
                        value={soapPassword}
                        onChange={(e) => setSoapPassword(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {protocol !== "auto" && effectiveProtocol === "graphql" && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="px-6 py-4 border-b">
                <h3 className="text-sm font-semibold text-slate-900">GraphQL</h3>
              </div>
              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-slate-800 mb-1">Endpoint URL</label>
                  <input
                    value={graphqlEndpoint}
                    onChange={(e) => setGraphqlEndpoint(e.target.value)}
                    placeholder="https://api.example.com/graphql"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">Auth</label>
                  <select
                    value={graphqlAuthKind}
                    onChange={(e) => setGraphqlAuthKind(e.target.value as typeof graphqlAuthKind)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="apiKey">API Key</option>
                  </select>
                </div>

                {(graphqlAuthKind === "bearer" || graphqlAuthKind === "apiKey") && (
                  <div>
                    <label className="block text-sm font-medium text-slate-800 mb-1">
                      {graphqlAuthKind === "bearer" ? "Token" : "Key"}
                    </label>
                    <input
                      value={graphqlToken}
                      onChange={(e) => setGraphqlToken(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}

                {graphqlAuthKind === "apiKey" && (
                  <div>
                    <label className="block text-sm font-medium text-slate-800 mb-1">Header name</label>
                    <input
                      value={graphqlHeaderName}
                      onChange={(e) => setGraphqlHeaderName(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}

                <div className="md:col-span-2">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={graphqlUseIntrospection}
                      onChange={(e) => setGraphqlUseIntrospection(e.target.checked)}
                      className="h-4 w-4"
                    />
                    Enable GraphQL introspection
                  </label>
                </div>
              </div>
            </div>
          )}

          {protocol !== "auto" && effectiveProtocol === "csv" && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="px-6 py-4 border-b">
                <h3 className="text-sm font-semibold text-slate-900">CSV / Files</h3>
              </div>
              <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">Delimiter</label>
                  <input
                    value={csvDelimiter}
                    onChange={(e) => setCsvDelimiter(e.target.value)}
                    placeholder=","
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">Encoding</label>
                  <input
                    value={csvEncoding}
                    onChange={(e) => setCsvEncoding(e.target.value)}
                    placeholder="utf-8"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex items-end">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={csvHasHeader}
                      onChange={(e) => setCsvHasHeader(e.target.checked)}
                      className="h-4 w-4"
                    />
                    Header row
                  </label>
                </div>
                <div className="md:col-span-3">
                  <label className="block text-sm font-medium text-slate-800 mb-1">Sample file (optional)</label>
                  <input
                    type="file"
                    accept=".csv,.tsv,text/csv,text/tab-separated-values,.txt"
                    onChange={(e) => setCsvSample(e.target.files?.[0] ?? null)}
                    className="block w-full rounded-lg border border-slate-300 bg-slate-50 p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-white hover:file:opacity-90"
                  />
                </div>
              </div>
            </div>
          )}

          {protocol !== "auto" && effectiveProtocol === "custom" && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="px-6 py-4 border-b">
                <h3 className="text-sm font-semibold text-slate-900">Custom Parser</h3>
              </div>
              <div className="p-6">
                <label className="block text-sm font-medium text-slate-800 mb-1">Parser module ID</label>
                <input
                  value={parserModuleId}
                  onChange={(e) => setParserModuleId(e.target.value)}
                  placeholder="@company/parsers/hr-xml-v2"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <p className="mt-2 text-xs text-slate-600">
                  Provide a parser module or select a template in the next step.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* RIGHT: Files drop + Continue */}
        <aside className="space-y-4">
          <div
            onDragOver={onDragOver}
            onDrop={onDrop}
            className="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-6 text-center"
          >
            <div className="text-sm font-semibold text-slate-900">Drop sample/spec files</div>
            <p className="text-xs text-slate-600 mt-1">
              JSON, XML, WSDL, OpenAPI, CSV… We’ll try to detect the protocol.
            </p>
            <div className="mt-4">
              <input
                type="file"
                multiple
                onChange={onPickFiles}
                className="block w-full rounded-lg border border-slate-300 bg-slate-50 p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-white hover:file:opacity-90"
              />
            </div>
            {files.length > 0 && (
              <ul className="mt-3 max-h-40 overflow-auto text-left text-xs text-slate-600">
                {files.map((f) => (
                  <li key={f.name} className="truncate">• {f.name}</li>
                ))}
              </ul>
            )}
          </div>

          {protocol === "auto" && (
            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
              <div className="font-semibold text-slate-900">Auto-detect status</div>
              {!detected ? (
                <div className="mt-1 text-slate-600">Add a file to analyze or provide an endpoint.</div>
              ) : (
                <div className="mt-1">
                  <div className="inline-flex items-center gap-2 text-xs rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-1" title={detected.reason}>
                    Detected: <b className="uppercase">{detected.protocol}</b>
                    <span className="opacity-70">({Math.round(detected.confidence * 100)}%)</span>
                  </div>
                  <div className="mt-2 text-xs text-slate-600">{detected.reason}</div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-800 p-3 text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <button
              disabled={!canContinue || busy}
              onClick={saveAndGo}
              className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow hover:bg-emerald-700 disabled:opacity-50"
            >
              Continue →
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
            <div className="font-semibold text-slate-900 mb-1">Tips</div>
            <ul className="list-disc pl-4 space-y-1">
              <li>In Auto mode, add a representative sample/spec to improve detection.</li>
              <li>Bearer/API Key: paste a token/key; for API Key, customize the header name if needed.</li>
              <li>For SOAP, a WSDL file is the best input (we’ll detect SOAP automatically).</li>
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
