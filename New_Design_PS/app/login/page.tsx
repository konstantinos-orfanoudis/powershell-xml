"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";

/**
 * One-file login page:
 * - Page component renders a <Suspense> boundary
 * - Inner component uses useSearchParams() safely inside Suspense
 * - Button points to NEXT_PUBLIC_LOGIN_URL (fallback SWA AAD route)
 *
 * If you’re using Azure Static Web Apps (SWA) Auth, the default
 * login URL is `/.auth/login/aad`. For NextAuth or custom auth, set:
 *   NEXT_PUBLIC_LOGIN_URL="your login route"
 */

export default function LoginPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const sp = useSearchParams();

  // read optional query params
  const { error, message, redirect } = useMemo(() => {
    const err = sp.get("error") || undefined;
    const msg = sp.get("message") || undefined;
    const red = sp.get("redirect") || "/";
    return { error: err, message: msg, redirect: red };
  }, [sp]);

  // where to send the user to authenticate:
  const LOGIN_URL =
    process.env.NEXT_PUBLIC_LOGIN_URL?.trim() || "/.auth/login/aad";

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-[min(460px,100%)] rounded-2xl border border-slate-200 bg-white shadow-md">
        <header className="border-b border-slate-100 px-5 py-4">
          <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
          <p className="text-sm text-slate-600">
            Continue to your workspace
          </p>
        </header>

        <section className="px-5 py-5 space-y-4">
          {message && (
            <Alert kind="info" text={message} />
          )}
          {error && (
            <Alert kind="error" text={error} />
          )}

          {/* If you have a username/password form, you can add it here.
             For Azure auth we usually send users straight to the provider. */}
          <div className="space-y-2">
            <a
              href={`${LOGIN_URL}?post_login_redirect_uri=${encodeURIComponent(
                "/homepage"
              )}`}
              className="w-full inline-flex items-center justify-center rounded-lg px-4 py-2.5
                         text-white bg-azure-600 hover:bg-azure-700 active:bg-azure-800
                         focus:outline-none focus:ring-2 focus:ring-azure-400/60
                         transition shadow-sm"
            >
              Continue with Microsoft Entra ID
            </a>

            <p className="text-xs text-slate-500 text-center">
              You’ll be redirected to Microsoft to sign in securely.
            </p>
          </div>
        </section>

        <footer className="border-t border-slate-100 px-5 py-4 text-center">
          <small className="text-xs text-slate-500">
            Need help? Contact your administrator.
          </small>
        </footer>
      </div>
    </main>
  );
}

function PageSkeleton() {
  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-[min(460px,100%)] rounded-2xl border border-slate-200 bg-white shadow-md">
        <div className="px-5 py-5">
          <div className="h-6 w-40 bg-slate-200 rounded mb-2" />
          <div className="h-4 w-64 bg-slate-200 rounded" />
          <div className="h-10 w-full bg-slate-200 rounded mt-6" />
        </div>
      </div>
    </main>
  );
}

function Alert({ kind, text }: { kind: "info" | "error"; text: string }) {
  const styles =
    kind === "error"
      ? "bg-rose-50 text-rose-800 border border-rose-200"
      : "bg-sky-50 text-sky-800 border border-sky-200";
  return (
    <div className={`text-sm rounded-lg px-3 py-2 ${styles}`}>{text}</div>
  );
}

/* Tailwind color helper for Azure button */
declare global {
  /* eslint-disable @typescript-eslint/no-namespace */
  namespace JSX {
    interface IntrinsicElements {
      /* nothing extra */
    }
  }
}
/* If your Tailwind config doesn't have an azure color,
   these utility classes will still work using default classes.
   Alternatively, replace azure-* with blue-* classes:
   bg-blue-600 hover:bg-blue-700 active:bg-blue-800 focus:ring-blue-400/60
*/
