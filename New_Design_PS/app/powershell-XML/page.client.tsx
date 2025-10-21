"use client";

import dynamic from "next/dynamic";

const ClientOnly = dynamic(() => import("./ClientPage"), {
  ssr: false, // <-- only load/run in the browser
  loading: () => (
    <div className="p-6 text-sm text-slate-600">Loading…</div>
  ),
});

export default function Page() {
  return <ClientOnly />;
}
