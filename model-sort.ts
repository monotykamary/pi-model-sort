/**
 * pi-model-sort — sort models in pi by last usage (descending).
 *
 * Strategy: monkey-patches three areas:
 *   ModelSelectorComponent.prototype.sortModels and loadModels — sorts both
 *   "Scope: all" and "Scope: scoped" views in the /model TUI picker.
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
import { AgentSession, ModelRegistry, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildModelKey,
  CONFIG_FILENAME,
  type ModelSortConfig,
  sortByLastUsed,
} from "./src/index.js";

const HOME = homedir();
const CONFIG_PATH = join(HOME, ".pi", "agent", "extensions", CONFIG_FILENAME);

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
  const dir = join(HOME, ".pi", "agent", "extensions");
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

// ModelSelectorComponent loadModels patch — sorts scopedModelItems for the
// "Scope: scoped" toggle in the /model picker.

let origLoadModels: (() => Promise<void>) | null = null;

function patchLoadModels(getLastUsed: () => Record<string, number>): void {
  if (origLoadModels !== null) return;

  const proto = ModelSelectorComponent.prototype as unknown as Record<string, unknown>;
  origLoadModels = proto.loadModels as () => Promise<void>;

  proto.loadModels = async function (this: Record<string, unknown>) {
    await origLoadModels!.call(this);

    const scopedItems = this.scopedModelItems as Array<{ provider: string; id: string; model: unknown }> | undefined;
    if (!scopedItems || scopedItems.length === 0) return;

    const lastUsed = getLastUsed();
    this.scopedModelItems = sortByLastUsed(scopedItems, lastUsed, buildCurrentModelKey(this));

    if (this.scope === "scoped") {
      this.activeModels = this.scopedModelItems;
      // Sync filteredModels — the original loadModels set it to the
      // unsorted scopedModelItems before our patch had a chance to sort.
      this.filteredModels = this.scopedModelItems;

      // Recalculate selectedIndex — the original loadModels computed it
      // from the unsorted array, so the cursor is at the old position.
      const currentKey = buildCurrentModelKey(this);
      if (currentKey) {
        const filtered = this.filteredModels as Array<{ provider: string; id: string }>;
        const newIndex = filtered.findIndex(
          (item) => buildModelKey(item.provider, item.id) === currentKey,
        );
        if (newIndex >= 0) {
          this.selectedIndex = newIndex;
        }
      }
    }
  };
}

function unpatchLoadModels(): void {
  if (origLoadModels === null) return;
  (ModelSelectorComponent.prototype as unknown as Record<string, unknown>).loadModels = origLoadModels;
  origLoadModels = null;
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

// Extension

export default function (pi: ExtensionAPI) {
  let lastUsed: Record<string, number> = {};

  pi.on("session_start", async (_event, ctx) => {
    const config = readConfig();
    lastUsed = config.lastUsed;

    patchRegistry(ctx.modelRegistry as unknown as PatchedRegistry, () => lastUsed);
    patchSortModels(() => lastUsed);
    patchLoadModels(() => lastUsed);
    patchCycleScopedModel(() => lastUsed);

    if (ctx.hasUI) {
      const count = Object.keys(lastUsed).length;
      ctx.ui.notify(
        count > 0
          ? `pi-model-sort: ${count} model(s) tracked — sorting by last usage`
          : "pi-model-sort: tracking started — models will sort by recency after first use",
        "info",
      );
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
    unpatchLoadModels();
    unpatchCycleScopedModel();
  });
}