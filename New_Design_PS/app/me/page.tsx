// "use client";

// import { useSwaAuth } from "../login/useSwaAuth";

// export default function MePage() {
//   const { user, loading, refresh } = useSwaAuth();

//   return (
//     <main className="p-6 space-y-4">
//       <h1 className="text-xl font-semibold">Session</h1>
//       <button className="rounded border px-3 py-1.5" onClick={refresh}>Refresh</button>
//       {loading ? (
//         <p>Loading…</p>
//       ) : user ? (
//         <pre className="rounded bg-slate-50 p-3 text-xs overflow-auto">
// {JSON.stringify(user, null, 2)}
//         </pre>
//       ) : (
//         <p>Not signed in.</p>
//       )}
//     </main>
//   );
// }
