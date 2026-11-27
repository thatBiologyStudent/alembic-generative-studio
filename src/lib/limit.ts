/** Per-key request limiter: at most `max` calls of the same key run at once, the rest wait in order. */
const active = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();

export async function withSlot<T>(key: string, max: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  while ((active.get(key) ?? 0) >= Math.max(1, max)) {
    await new Promise<void>((resolve, reject) => {
      const q = waiting.get(key) ?? [];
      const wake = () => (signal?.removeEventListener('abort', onAbort), resolve());
      const onAbort = () => {
        const list = waiting.get(key) ?? [];
        const i = list.indexOf(wake);
        if (i >= 0) list.splice(i, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      q.push(wake);
      waiting.set(key, q);
    });
  }
  active.set(key, (active.get(key) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    active.set(key, (active.get(key) ?? 1) - 1);
    waiting.get(key)?.shift()?.();
  }
}

/**
 * Runs fn for every item with at most `limit` running at once; results keep the item order.
 * A rejected item rejects the whole run only after the others settle (errors are the caller's to catch per item).
 */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure !== undefined) throw failure;
  return out;
}

/** The parallel requests a connection allows (1 = one at a time, the default). */
export const concurrencyOf = (conn?: { maxConcurrent?: number }) => Math.max(1, Math.min(16, Math.floor(conn?.maxConcurrent ?? 1)));
