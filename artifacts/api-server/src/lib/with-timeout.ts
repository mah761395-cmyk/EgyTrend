/**
 * Race a promise against a timer that resolves with `fallback` (it does NOT
 * reject, and the original promise keeps running — for deduplicated/cached
 * producers that is exactly what we want: the late result still lands in the
 * cache for the next request).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
