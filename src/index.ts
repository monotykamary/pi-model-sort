/**
 * Shared constants, types, and utilities for pi-model-sort.
 */

/** Default config file name (placed in ~/.pi/agent/extensions/). */
export const CONFIG_FILENAME = "pi-model-sort.json";

export interface ModelSortConfig {
  /** Map of "provider/modelId" → last-used Unix timestamp (ms). */
  lastUsed: Record<string, number>;
}

/** Build a stable model key from provider and model id. */
export function buildModelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/**
 * Sort an array of models (or model-like objects) by last-usage recency.
 *
 * Sort order:
 *   1. Current model first (if currentModelKey is provided)
 *   2. Most recently used (highest timestamp) first
 *   3. Provider name alphabetically
 *   4. Model id alphabetically
 *
 * Models with no recorded usage get timestamp 0 (sorted last).
 */
export function sortByLastUsed<T extends { provider: string; id: string }>(
  items: T[],
  lastUsed: Record<string, number>,
  currentModelKey: string | null,
): T[] {
  const sorted = [...items];
  sorted.sort((a, b) => {
    const aKey = buildModelKey(a.provider, a.id);
    const bKey = buildModelKey(b.provider, b.id);

    if (currentModelKey !== null) {
      const aIsCurrent = aKey === currentModelKey;
      const bIsCurrent = bKey === currentModelKey;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
    }

    const aLast = lastUsed[aKey] ?? 0;
    const bLast = lastUsed[bKey] ?? 0;
    if (aLast !== bLast) return bLast - aLast;

    return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
  });
  return sorted;
}