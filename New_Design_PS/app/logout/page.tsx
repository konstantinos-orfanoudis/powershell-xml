// app/logout/page.tsx
// Server component (no client hooks). Works with Next 15 (searchParams is a Promise).

type SP = Record<string, string | string[] | undefined>;
const toStr = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v ?? undefined);

export default async function LogoutPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;

  const redirect = toStr(sp.redirect) || "/login";

  // Azure Static Web Apps default logout endpoint. Override via env if needed.
  const logoutBase = process.env.NEXT_PUBLIC_LOGOUT_URL?.trim() || "/.auth/logout";
  const href = `${logoutBase}?post_logout_redirect_uri=${encodeURIComponent(redirect)}`;

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-[min(460px,100%)] rounded-2xl border border-slate-200 bg-white shadow-md">
        <header className="border-b border-slate-100 px-5 py-4">
          <h1 className="text-lg font-semibold text-slate-900">Sign out</h1>
          <p className="text-sm text-slate-600">You’re about to sign out of your session.</p>
        </header>

        <section className="px-5 py-5 space-y-4">
          <a
            href={href}
            className="w-full inline-flex items-center justify-center rounded-lg px-4 py-2.5
                       text-white bg-rose-600 hover:bg-rose-700 active:bg-rose-800
                       focus:outline-none focus:ring-2 focus:ring-rose-400/60
                       transition shadow-sm"
          >
            Sign out now
          </a>

          <p className="text-xs text-slate-500 text-center">
            You’ll be redirected after sign-out.
          </p>
        </section>
      </div>
    </main>
  );
}
