/* app/dataflow/page.tsx // /*/
"use client";

import React from "react";
import { usePathname } from "next/navigation";
import LogoutButton from "../page";
type Step = {
  key: string;
  label: string;
  href: string;
  description: string;
};
//
function DataflowSteps() {
  const pathname = usePathname();

  const steps: Step[] = [
    {
      key: "schema",
      label: "Generate Schema",
      href: "/UploadFilesForSchemaCreation",
      description: "Define entities and attributes",
    },
    {
      key: "ps",
      label: "Generate PowerShell & XML",
      href: "/powershell-XML",
      description:
        "Build connector functions and XML file from the schema; tweak params & connection/security.",
    },
    {
      key: "XMLValidation",
      label: "Validate your XML",
      href: "/powershell-XML",
      description:
        "Upload your XML and your PS Script to validate your XML.",
    },
    
  ];

  const activeIdx = Math.max(steps.findIndex((s) => pathname?.startsWith(s.href)), -1);

  return (
    <nav className="w-full">
      <ol className="flex flex-wrap items-center gap-3 sm:gap-4">
        {steps.map((s, i) => {
          const isActive = i === activeIdx;
          const isDone = i < activeIdx;

          return (
            <li key={s.key} className="flex items-center gap-3">
              <a
                href={s.href}
                className={[
                  "inline-flex items-center rounded-lg border px-3 py-2 text-sm transition",
                  isActive
                    ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                    : isDone
                    ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                ].join(" ")}
                title={s.description}
              >
                <span
                  className={[
                    "mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
                    isActive
                      ? "bg-emerald-600 text-white"
                      : isDone
                      ? "bg-slate-800 text-white"
                      : "bg-slate-200 text-slate-700",
                  ].join(" ")}
                >
                  {i + 1}
                </span>
                {s.label}
              </a>

              {/* Arrow between steps */}
              {i < steps.length - 1 && (
                <svg
                  className="h-5 w-5 text-slate-300"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707A1 1 0 018.707 5.293l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default function DataflowPage() {
  return (
    <main className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-4">
          <h1 className="text-xl font-semibold text-slate-900">Project Dataflow</h1>
          <p className="mt-1 text-sm text-slate-600">
            Follow these steps to move from schema to PowerShell and XML.
          </p>

          <div className="mt-3">
            <DataflowSteps />
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-8 grid gap-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-900">1) Generate Schema</h2>
          <p className="mt-2 text-sm text-slate-600">
            Define your entities and attributes via samples of endpoint responses.
          </p>
          <a
            href="/UploadFilesForSchemaCreation"
            className="mt-3 inline-flex items-center rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Build schema.json
          </a>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-900">2) Generate XML PowerShell </h2>
          <p className="mt-2 text-sm text-slate-600">
            Build ps functions and XML from your schema. Adjust connection/auth/security parameters, preview, and download.
          </p>
          <a
            href="/powershell-XML"
            className="mt-3 inline-flex items-center rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Generate Powershell and XML
          </a>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-900">3) Validate XML</h2>
          <p className="mt-2 text-sm text-slate-600">
            Upload your XML and your PS Script to validate your XML.
          </p>
          <a
            href="/XML-Validator"
            className="mt-3 inline-flex items-center rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Validate your XML
          </a>
        </div>
      </section>
    </main>
  );
}
