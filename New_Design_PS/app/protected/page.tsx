// app/protected/page.tsx
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic"; // don’t prerender; evaluate per request
export const revalidate = 0;

type SP = Record<string, string | string[] | undefined>;
type Principal = {
  userId?: string;
  userDetails?: string;
  identityProvider?: string;
  userRoles?: string[];
};

const toStr = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v ?? undefined;

function parseSWAUser(h: Headers): Principal | null {
  const b64 = h.get("x-ms-client-principal");
  if (!b64) return null;
  try {
    // Buffer exists on Node runtime used by Next.js
    const json = Buffer.from(b64, "base64").toString("utf8");
    const p = JSON.parse(json);
    return {
      userId: p.userId,
      userDetails: p.userDetails,
      identityProvider: p.identityProvider,
      userRoles: p.userRoles,
    };
  } catch {
    return null;
  }
}

export default async function ProtectedPage({
  // Next 15: searchParams is a Promise in server components
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const hdrs = await headers();

  const principal = parseSWAUser(hdrs);
  const isAuthed = !!principal?.userId;

  // where to send users back after login/logout
  const here = "/protected";
  const redirectAfterLogout = toStr(sp.redirect) || "/login";

  // Allow overriding SWA endpoints with env, else use defaults
  const loginBase =
    process.env.NEXT_PUBLIC_LOGIN_URL?.trim() || "/.auth/login/aad";
  const logoutBase =
    process.env.NEXT_PUBLIC_LOGOUT_URL?.trim() || "/.auth/logout";

  const loginHref = `${loginBase}?post_login_redirect_uri=${encodeURIComponent(
    here
  )}`;
  const logoutHref = `${logoutBase}?post_logout_redirect_uri=${encodeURIComponent(
    redirectAfterLogout
  )}`;

  // If not authenticated, send to /login (server redirect; no client hooks)
  if (!isAuthed) {
    redirect(`/login?redirect=${encodeURIComponent(here)}`);
  }

  // Authenticated view
  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto w-[min(960px,100%)] space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              Protected area
            </h1>
            <p className="text-sm text-slate-600">
              You are signed in with{" "}
              <span className="font-medium">
                {principal?.identityProvider || "Azure AD"}
              </span>
              .
            </p>
          </div>

          {/* Red sign-out button (as requested) */}
          <a
            href={logoutHref}
            className="inline-flex items-center rounded-md border border-rose-600
                       bg-rose-600 px-4 py-2 text-sm font-medium text-white
                       hover:bg-rose-700 hover:border-rose-700
                       focus:outline-none focus:ring-2 focus:ring-rose-500"
          >
            Sign out
          </a>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">
            Hello, {principal?.userDetails || "user"}!
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Only authenticated users can see this page.
          </p>

          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <pre className="text-xs text-slate-700 overflow-auto">
              {JSON.stringify(principal, null, 2)}
            </pre>
          </div>

          <div className="mt-6">
            <a
              href={loginHref}
              className="text-sm text-sky-700 hover:underline"
            >
              Re-authenticate
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
