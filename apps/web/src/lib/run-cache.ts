export const RUN_CACHE_LIMIT = 32;

/**
 * Record-backed deterministic LRU for run-scoped UI diagnostics. Reading a
 * cached run should call this helper too, so the insertion order remains the
 * recency order used for eviction.
 */
export function touchRunCache<T>(current: Readonly<Record<string, T>>, runId: string, value: T, limit = RUN_CACHE_LIMIT): Record<string, T> {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const entries = Object.entries(current).filter(([id]) => id !== runId);
  entries.push([runId, value]);
  return Object.fromEntries(entries.slice(-boundedLimit));
}
