// lib/resultBus.ts
type Payload = any;

const cache = new Map<string, { ts: number; payload: Payload }>();
const waiters = new Map<string, Array<(p: Payload) => void>>();

const TTL_MS = 15 * 60 * 1000; // keep results for 15 min

function cleanup() {
  const now = Date.now();
  for (const [id, v] of cache) {
    if (now - v.ts > TTL_MS) cache.delete(id);
  }
}

/** Called by /api/ai/receive when n8n finishes */
export function putResult(id: string, payload: Payload) {
  cache.set(id, { ts: Date.now(), payload });
  const list = waiters.get(id);
  if (list && list.length) {
    list.forEach(fn => {
      try { fn(payload); } catch {}
    });
    waiters.delete(id);
  }
  cleanup();
}

/** Await until result is delivered (or timeout) */
export function waitForResult(id: string, timeoutMs: number): Promise<Payload> {
  // if already here, return immediately
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit.payload);

  return new Promise<Payload>((resolve, reject) => {
    const timer = setTimeout(() => {
      // on timeout, stop waiting (keep any future delivery in cache)
      const lst = waiters.get(id) || [];
      // remove this resolver
      waiters.set(
        id,
        lst.filter(fn => fn !== onResolve)
      );
      reject(new Error("timeout"));
    }, Math.max(1000, timeoutMs || 0));

    const onResolve = (payload: Payload) => {
      clearTimeout(timer);
      resolve(payload);
    };

    const list = waiters.get(id) || [];
    list.push(onResolve);
    waiters.set(id, list);
  });
}
