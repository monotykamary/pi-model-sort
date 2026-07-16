/**
 * pi-model-sort — sort models in pi by last usage (descending).
 *
 * Strategy: monkey-patches three areas:
 *   ModelSelectorComponent.prototype.sortModels and scoped loader
 *   (loadModelsFromSnapshot on pi 0.80.8+, loadModels on older pi) — sorts
 *   both "Scope: all" and "Scope: scoped" views in the /model TUI picker.
 *   ModelRegistry.prototype.getAvailable/getAll — sorts --list-models CLI
 *   and the /scoped-models config selector.
 *   AgentSession.prototype._cycleScopedModel — sorts the Ctrl+P / Ctrl+Shift+P
 *   cycling order (non-destructively — the configured order is preserved).
 *
 * Usage tracking is automatic — every model selection (manual, Ctrl+P cycle,
 * or session restore) updates the last-used timestamp. Data persists to
 * ~/.pi/agent/extensions/pi-model-sort.json.
 *
 * With no recorded usage, the sort degrades gracefully to the default
 * provider/model-id alphabetical order.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentSession, ModelRegistry, ModelSelectorComponent, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildModelKey,
  CONFIG_FILENAME,
  type ModelSortConfig,
  parseModelKey,
  sortByLastUsed,
} from "./src/index.js";

const CONFIG_PATH = join(getAgentDir(), "extensions", CONFIG_FILENAME);

// Config I/O

function readConfig(): ModelSortConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { lastUsed: {} };
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ModelSortConfig;
    return { lastUsed: parsed.lastUsed ?? {} };
  } catch {
    return { lastUsed: {} };
  }
}

function writeConfig(config: ModelSortConfig): void {
  const dir = join(getAgentDir(), "extensions");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ModelSelectorComponent sortModels patch

let origSortModels: ((models: Array<{ provider: string; id: string; model: unknown }>) => Array<{ provider: string; id: string; model: unknown }>) | null = null;

function buildCurrentModelKey(instance: Record<string, unknown>): string | null {
  const cm = instance.currentModel as { provider?: string; id?: string } | undefined;
  if (cm?.provider && cm?.id) {
    return buildModelKey(cm.provider, cm.id);
  }
  return null;
}

function patchSortModels(getLastUsed: () => Record<string, number>): void {
  if (origSortModels !== null) return;

  const proto = ModelSelectorComponent.prototype as unknown as Record<string, unknown>;
  origSortModels = proto.sortModels as typeof origSortModels;

  proto.sortModels = function (
    this: Record<string, unknown>,
    models: Array<{ provider: string; id: string; model: unknown }>,
  ) {
    const lastUsed = getLastUsed();
    return sortByLastUsed(models, lastUsed, buildCurrentModelKey(this));
  };
}

function unpatchSortModels(): void {
  if (origSortModels === null) return;
  (ModelSelectorComponent.prototype as unknown as Record<string, unknown>).sortModels = origSortModels;
  origSortModels = null;
}

// ModelSelectorComponent scoped-loader patch — sorts scopedModelItems for
// the "Scope: scoped" toggle in the /model picker.
//
// pi 0.80.8 split the old loadModels() into a synchronous
// loadModelsFromSnapshot() (used for both the initial render and after each
// catalog refresh) plus a new async refreshModels(). The scoped items are built
// directly inside the snapshot loader and never pass through sortModels, so
// this patch re-sorts them there. We hook whichever method the running pi
// exposes — new (loadModelsFromSnapshot, sync) or old (loadModels, async) — so
// the sort applies on initial render, after a refresh, and (because
// scopedModelItems is re-sorted even when the active scope is "all") survives
// the Tab toggle to "scoped".

let origScopedLoader: ((this: unknown) => unknown) | null = null;
let scopedLoaderName: string | null = null;

function sortScopedItems(instance: Record<string, unknown>, getLastUsed: () => Record<string, number>): void {
  const scopedItems = instance.scopedModelItems as
    | Array<{ provider: string; id: string; model: unknown }>
    | undefined;
  if (!scopedItems || scopedItems.length === 0) return;

  const lastUsed = getLastUsed();
  instance.scopedModelItems = sortByLastUsed(scopedItems, lastUsed, buildCurrentModelKey(instance));

  if (instance.scope === "scoped") {
    // Sync activeModels/filteredModels — the loader set them to the unsorted
    // scopedModelItems before our patch had a chance to sort.
    instance.activeModels = instance.scopedModelItems;
    instance.filteredModels = instance.scopedModelItems;

    // Recalculate selectedIndex — the loader computed it from the unsorted
    // array, so the cursor is at the old position.
    const currentKey = buildCurrentModelKey(instance);
    if (currentKey) {
      const filtered = instance.filteredModels as Array<{ provider: string; id: string }>;
      const newIndex = filtered.findIndex(
        (item) => buildModelKey(item.provider, item.id) === currentKey,
      );
      if (newIndex >= 0) {
        instance.selectedIndex = newIndex;
      }
    }
  }
}

function patchScopedLoader(getLastUsed: () => Record<string, number>): void {
  if (origScopedLoader !== null) return;

  const proto = ModelSelectorComponent.prototype as unknown as Record<string, unknown>;

  // pi 0.80.8+ — synchronous snapshot loader (initial render + after refresh).
  if (typeof proto.loadModelsFromSnapshot === "function") {
    origScopedLoader = proto.loadModelsFromSnapshot as (this: unknown) => unknown;
    scopedLoaderName = "loadModelsFromSnapshot";
    proto.loadModelsFromSnapshot = function (this: Record<string, unknown>) {
      origScopedLoader!.call(this);
      sortScopedItems(this, getLastUsed);
    };
    return;
  }

  // pi <= 0.80.3 — async loadModels.
  if (typeof proto.loadModels === "function") {
    origScopedLoader = proto.loadModels as (this: unknown) => unknown;
    scopedLoaderName = "loadModels";
    proto.loadModels = async function (this: Record<string, unknown>) {
      await origScopedLoader!.call(this);
      sortScopedItems(this, getLastUsed);
    };
  }
}

function unpatchScopedLoader(): void {
  if (origScopedLoader === null || scopedLoaderName === null) return;
  (ModelSelectorComponent.prototype as unknown as Record<string, unknown>)[scopedLoaderName] = origScopedLoader;
  origScopedLoader = null;
  scopedLoaderName = null;
}

// ModelSelectorComponent filterModels patch — re-applies last-used sort after
// fuzzyFilter re-orders results by match quality. Without this, typing in the
// /model picker search box discards the last-used order.

let origFilterModels: ((query: string) => void) | null = null;

function patchFilterModels(getLastUsed: () => Record<string, number>): void {
  if (origFilterModels !== null) return;

  const proto = ModelSelectorComponent.prototype as unknown as Record<string, unknown>;
  origFilterModels = proto.filterModels as (query: string) => void;

  proto.filterModels = function (this: Record<string, unknown>, query: string) {
    // Suppress the original's updateList() call — we'll call it once after
    // re-sorting to avoid a double-render.
    const origUpdateList = this.updateList as () => void;
    this.updateList = (() => {}) as unknown as () => void;

    try {
      origFilterModels!.call(this, query);
    } finally {
      this.updateList = origUpdateList as unknown as () => void;
    }

    // Empty query: nothing to re-sort (activeModels is already sorted by our
    // sortModels/scoped-loader patches), just render the original result.
    if (!query) {
      origUpdateList.call(this);
      return;
    }

    const filtered = this.filteredModels as Array<{ provider: string; id: string; model: unknown }> | undefined;
    if (!filtered || filtered.length <= 1) {
      origUpdateList.call(this);
      return;
    }

    const lastUsed = getLastUsed();
    this.filteredModels = sortByLastUsed(filtered, lastUsed, buildCurrentModelKey(this));

    // Re-sync selectedIndex — fuzzyFilter may have moved the current model.
    const currentKey = buildCurrentModelKey(this);
    if (currentKey) {
      const newFiltered = this.filteredModels as Array<{ provider: string; id: string }>;
      const newIndex = newFiltered.findIndex(
        (item) => buildModelKey(item.provider, item.id) === currentKey,
      );
      if (newIndex >= 0) {
        this.selectedIndex = newIndex;
      }
    }

    // Render once with the final sorted list.
    origUpdateList.call(this);
  };
}

function unpatchFilterModels(): void {
  if (origFilterModels === null) return;
  (ModelSelectorComponent.prototype as unknown as Record<string, unknown>).filterModels = origFilterModels;
  origFilterModels = null;
}

// ModelRegistry getAvailable / getAll patch

const REGISTRY_PATCH_KEY = "__model_sort_registry_patched";

interface PatchedRegistry {
  [REGISTRY_PATCH_KEY]: boolean;
  getAvailable(): unknown[];
  getAll(): unknown[];
  __model_sort_get_last_used: () => Record<string, number>;
  __model_sort_orig_getAvailable: () => unknown[];
  __model_sort_orig_getAll: () => unknown[];
}

function patchRegistry(
  registry: PatchedRegistry,
  getLastUsed: () => Record<string, number>,
): void {
  if (registry[REGISTRY_PATCH_KEY]) {
    registry.__model_sort_get_last_used = getLastUsed;
    return;
  }

  registry[REGISTRY_PATCH_KEY] = true;
  registry.__model_sort_get_last_used = getLastUsed;

  registry.__model_sort_orig_getAvailable = registry.getAvailable.bind(registry);
  registry.__model_sort_orig_getAll = registry.getAll.bind(registry);

  registry.getAvailable = function (this: PatchedRegistry) {
    const lastUsed = this.__model_sort_get_last_used();
    const all = this.__model_sort_orig_getAvailable() as Array<{ provider: string; id: string }>;
    return sortByLastUsed(all, lastUsed, null);
  };

  registry.getAll = function (this: PatchedRegistry) {
    const lastUsed = this.__model_sort_get_last_used();
    const all = this.__model_sort_orig_getAll() as Array<{ provider: string; id: string }>;
    return sortByLastUsed(all, lastUsed, null);
  };
}

function unpatchRegistry(registry: PatchedRegistry): void {
  if (!registry[REGISTRY_PATCH_KEY]) return;

  registry.getAvailable = registry.__model_sort_orig_getAvailable;
  registry.getAll = registry.__model_sort_orig_getAll;

  const raw = registry as unknown as Record<string, unknown>;
  delete raw[REGISTRY_PATCH_KEY];
  delete raw.__model_sort_get_last_used;
  delete raw.__model_sort_orig_getAvailable;
  delete raw.__model_sort_orig_getAll;
}

// AgentSession _cycleScopedModel patch — sorts the scoped models list
// before cycling so Ctrl+P / Ctrl+Shift+P follows last-used order instead
// of the configured order. Non-destructive: the session's stored order is
// temporarily swapped and restored after the cycle lookup.

type ScopedModelEntry = { model: { provider: string; id: string }; thinkingLevel?: string };

let origCycleScopedModel: ((direction: string) => Promise<unknown>) | null = null;

function patchCycleScopedModel(getLastUsed: () => Record<string, number>): void {
  if (origCycleScopedModel !== null) return;

  const proto = AgentSession.prototype as unknown as Record<string, unknown>;
  origCycleScopedModel = proto._cycleScopedModel as (direction: string) => Promise<unknown>;

  proto._cycleScopedModel = async function (this: Record<string, unknown>, direction: string) {
    const lastUsed = getLastUsed();
    const origScoped = this._scopedModels as ScopedModelEntry[] | undefined;

    if (!origScoped || origScoped.length <= 1) {
      return origCycleScopedModel!.call(this, direction);
    }

    // Sort by last-used without mutating the session's stored order.
    const sorted = [...origScoped].sort((a, b) => {
      const aKey = buildModelKey(a.model.provider, a.model.id);
      const bKey = buildModelKey(b.model.provider, b.model.id);
      const aLast = lastUsed[aKey] ?? 0;
      const bLast = lastUsed[bKey] ?? 0;
      if (aLast !== bLast) return bLast - aLast;
      return a.model.provider.localeCompare(b.model.provider) || a.model.id.localeCompare(b.model.id);
    });

    // Temporarily swap for the cycle lookup, restore afterward.
    this._scopedModels = sorted;
    try {
      return await origCycleScopedModel!.call(this, direction);
    } finally {
      this._scopedModels = origScoped;
    }
  };
}

function unpatchCycleScopedModel(): void {
  if (origCycleScopedModel === null) return;
  (AgentSession.prototype as unknown as Record<string, unknown>)._cycleScopedModel = origCycleScopedModel;
  origCycleScopedModel = null;
}

// MRU model lookup — finds the most recently used model that exists in the
// registry and has auth configured. Returns undefined if no usable model found.

function findMruModel(
  lastUsed: Record<string, number>,
  registry: { find(provider: string, modelId: string): unknown; hasConfiguredAuth(model: unknown): boolean },
): unknown | undefined {
  const sorted = Object.entries(lastUsed).sort(([, a], [, b]) => b - a);
  for (const [key] of sorted) {
    const parsed = parseModelKey(key);
    if (!parsed) continue;
    const [provider, modelId] = parsed;
    const model = registry.find(provider, modelId);
    if (model && registry.hasConfiguredAuth(model)) {
      return model;
    }
  }
  return undefined;
}

// Extension

export default function (pi: ExtensionAPI) {
  let lastUsed: Record<string, number> = {};

  pi.on("session_start", async (event, ctx) => {
    const config = readConfig();
    lastUsed = config.lastUsed;

    patchRegistry(ctx.modelRegistry as unknown as PatchedRegistry, () => lastUsed);
    patchSortModels(() => lastUsed);
    patchScopedLoader(() => lastUsed);
    patchFilterModels(() => lastUsed);
    patchCycleScopedModel(() => lastUsed);

    // Override initial model to MRU on new sessions.
    // Pi core picks the saved default if in scope, otherwise scopedModels[0].
    // This hijack switches to the most recently used model instead, so your
    // actual usage history determines the default — not alphabetical scope order.
    if (
      (event.reason === "startup" || event.reason === "new") &&
      Object.keys(lastUsed).length > 0
    ) {
      const mruModel = findMruModel(lastUsed, ctx.modelRegistry);
      const currentModel = ctx.model as { provider: string; id: string } | undefined;
      if (
        mruModel &&
        (!currentModel ||
          currentModel.provider !== (mruModel as { provider: string }).provider ||
          currentModel.id !== (mruModel as { id: string }).id)
      ) {
        await pi.setModel(mruModel as Parameters<typeof pi.setModel>[0]);
      }
    }
  });

  // Track model selections (manual, session restore).
  // Skip "cycle" events — updating lastUsed during Ctrl+P cycling creates
  // a feedback loop: each cycle step makes the selected model most-recent,
  // re-sorts it to position 0, then (currentIndex + 1) % len always hits
  // position 1 — toggling forever between the top 2.
  pi.on("model_select", async (event, _ctx) => {
    if (event.source === "cycle") return;
    const key = buildModelKey(event.model.provider, event.model.id);
    lastUsed[key] = Date.now();
    writeConfig({ lastUsed });
  });

  // Cleanup on shutdown / reload
  pi.on("session_shutdown", () => {
    unpatchSortModels();
    unpatchScopedLoader();
    unpatchFilterModels();
    unpatchCycleScopedModel();
  });
}