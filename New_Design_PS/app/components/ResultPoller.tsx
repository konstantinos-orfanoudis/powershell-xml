'use client';

import React from 'react';

type PollState =
  | { phase: 'idle' }
  | { phase: 'pending'; tries: number; nextInMs: number }
  | { phase: 'done'; text: string }
  | { phase: 'error'; message: string };

const INITIAL_DELAY_MS = 1200;
const BACKOFF_FACTOR   = 1.6;
const MAX_DELAY_MS     = 10_000;
const MAX_TRIES        = 25;

export function ResultPoller({ requestId }: { requestId: string }) {
  const [state, setState] = React.useState<PollState>({ phase: 'idle' });

  React.useEffect(() => {
    if (!requestId) {
      setState({ phase: 'error', message: 'Missing request id' });
      return;
    }

    let cancelled = false;

    const pollOnce = async () => {
      try {
        const r = await fetch(`/api/ai/result?id=${encodeURIComponent(requestId)}`, {
          method: 'GET',
          cache: 'no-store',
        });

        if (r.status === 200) {
          const text = await r.text();
          return { kind: 'done' as const, text };
        }
        if (r.status === 202) {
          return { kind: 'pending' as const };
        }

        let msg = `upstream ${r.status}`;
        try {
          const j = await r.json();
          if (j?.error) msg = String(j.error);
        } catch { /* ignore */ }
        return { kind: 'error' as const, message: msg };
      } catch (e: any) {
        return { kind: 'error' as const, message: e?.message ?? String(e) };
      }
    };

    const run = async () => {
      await new Promise(res => setTimeout(res, INITIAL_DELAY_MS));
      if (cancelled) return;

      let tries = 0;
      let delay = INITIAL_DELAY_MS;

      while (!cancelled && tries < MAX_TRIES) {
        const res = await pollOnce();
        if (cancelled) return;

        if (res.kind === 'done') {
          setState({ phase: 'done', text: res.text || '' });
          return;
        }
        if (res.kind === 'error') {
          setState({ phase: 'error', message: res.message || 'Unknown error' });
          return;
        }

        tries += 1;
        delay = Math.min(Math.round(delay * BACKOFF_FACTOR), MAX_DELAY_MS);
        setState({ phase: 'pending', tries, nextInMs: delay });
        await new Promise(res => setTimeout(res, delay));
      }

      if (!cancelled) {
        setState({ phase: 'error', message: 'Timed out waiting for result (still pending).' });
      }
    };

    setState({ phase: 'pending', tries: 0, nextInMs: INITIAL_DELAY_MS });
    run();

    return () => { cancelled = true; };
  }, [requestId]);

  if (state.phase === 'done') {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-0">
        <div className="border-b border-emerald-200 px-3 py-2 text-emerald-900 font-medium">
          PowerShell (final)
        </div>
        <pre className="overflow-x-auto p-3 text-sm text-slate-900">{state.text}</pre>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-900">
        <div className="font-medium">Error</div>
        <div className="text-sm break-all">{state.message}</div>
      </div>
    );
  }

  if (state.phase === 'pending') {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
        Processing… try #{state.tries} — next check in ~{Math.ceil(state.nextInMs / 1000)}s
      </div>
    );
  }

  return null;
}
