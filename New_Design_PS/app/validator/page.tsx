/* app/validator/page.tsx */
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeSchemaJson, type SchemaEntity } from "../utils/normalizeSchema";
import { validateConnector, type Issue } from "../utils/validation";

export default function ValidatorUploadPage() {
  const router = useRouter();

  // Clear only on real page reloads
  useEffect(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === "reload") {
      sessionStorage.removeItem("validator.xml");
      sessionStorage.removeItem("validator.ps1");
      sessionStorage.removeItem("validator.schema.entities");
      sessionStorage.removeItem("validator.result.v1");
    }
  }, []);

  const [xmlFile, setXmlFile] = useState<File | null>(null);
  const [psFile, setPsFile] = useState<File | null>(null);
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [uiErrors, setUiErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState(false);

  async function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    setUiErrors([]);
    if (!xmlFile || !psFile || !jsonFile) {
      setUiErrors(["Upload all three files."]);
      return;
    }

    setBusy(true);
    try {
      const [xmlText, psText, jsonText] = await Promise.all([
        xmlFile.text(),
        psFile.text(),
        jsonFile.text(),
      ]);

      let entities: SchemaEntity[] = [];
      try {
        entities = normalizeSchemaJson(jsonText);
      } catch (err) {
        setUiErrors([`Schema JSON parse error: ${(err as Error).message}`]);
        return;
      }

      // Deep validation
      const issues: Issue[] = validateConnector(xmlText, psText, entities);

      // Persist inputs (optional)
      sessionStorage.setItem("validator.xml", xmlText);
      sessionStorage.setItem("validator.ps1", psText);
      sessionStorage.setItem("validator.schema.entities", JSON.stringify(entities));

      // Save result (the results page will render and highlight)
      sessionStorage.setItem(
        "validator.result.v1",
        JSON.stringify({ xmlText, issues })
      );

      setUploaded(true);
      router.push("/validation-result");
    } finally {
      setBusy(false);
    }
  }

  const header = useMemo(
    () => (
      <div className="border-b bg-slate-900 text-white">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="text-lg font-semibold">Connector XML Validator</div>
          <div className="text-sm opacity-80">1) Upload → 2) Results</div>
        </div>
      </div>
    ),
    []
  );

  return (
    <main className="min-h-screen bg-slate-50">
      {header}

      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="rounded-2xl border border-slate-200 bg-white shadow">
          <div className="px-6 py-4 border-b">
            <h1 className="text-xl font-semibold text-slate-900">Upload files</h1>
            <p className="text-sm text-slate-600">
              Provide the generated <b>connector XML</b>, the <b>PowerShell</b> file with global
              functions, and the <b>target system schema JSON</b>.
            </p>
          </div>

          <form onSubmit={handleContinue} className="p-6 space-y-6">
            {!uploaded ? (
              <>
                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">Connector XML</label>
                  <input
                    type="file"
                    accept=".xml,text/xml"
                    onChange={(e) => setXmlFile(e.target.files?.[0] ?? null)}
                    className="block w-full rounded-lg border border-slate-300 bg-slate-50 p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-white hover:file:opacity-90"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">PowerShell (.ps1)</label>
                  <input
                    type="file"
                    accept=".ps1,text/plain,application/octet-stream"
                    onChange={(e) => setPsFile(e.target.files?.[0] ?? null)}
                    className="block w-full rounded-lg border border-slate-300 bg-slate-50 p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-white hover:file:opacity-90"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-800 mb-1">Target schema (JSON)</label>
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={(e) => setJsonFile(e.target.files?.[0] ?? null)}
                    className="block w-full rounded-lg border border-slate-300 bg-slate-50 p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-white hover:file:opacity-90"
                  />
                </div>

                {uiErrors.length > 0 && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                    <ul className="list-disc pl-5">
                      {uiErrors.map((i, idx) => <li key={idx}>{i}</li>)}
                    </ul>
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={busy || !xmlFile || !psFile || !jsonFile}
                    className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Validate →
                  </button>
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-600">Files uploaded. Redirecting to results…</div>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}
