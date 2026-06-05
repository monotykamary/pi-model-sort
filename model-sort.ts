/**
 * pi-model-sort — sort models in pi by last usage (descending).
 *
 * Strategy: monkey-patches ModelSelectorComponent.prototype.sortModels and
 * loadModels so the /model picker sorts by recency instead of alphabetically
 * by provider — including the "Scope: scoped" view for Ctrl+P cycling.
 * Also patches ModelRegistry.getAvailable() and getAll() so --list-models
 * and the scoped-models config selector benefit from the same ordering.
 *
 * Usage tracking is automatic — every model selection (manual, Ctrl+P cycle,
 * or session restore) updates the last-used timestamp. Data persists to
 * ~/.pi/agent/extensions/pi-model-sort.json.
 *
 * With no recorded usage, the sort degrades gracefully to the default
 * provider/model-id alphabetical order.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ModelRegistry, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
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

// Extension

export default function (pi: ExtensionAPI) {
  let lastUsed: Record<string, number> = {};

  pi.on("session_start", async (_event, ctx) => {
    const config = readConfig();
    lastUsed = config.lastUsed;

    patchRegistry(ctx.modelRegistry as unknown as PatchedRegistry, () => lastUsed);
    patchSortModels(() => lastUsed);
    patchLoadModels(() => lastUsed);

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

  // Track every model selection (manual, Ctrl+P cycle, session restore)
  pi.on("model_select", async (event, _ctx) => {
    const key = buildModelKey(event.model.provider, event.model.id);
    lastUsed[key] = Date.now();
    writeConfig({ lastUsed });
  });

  // Cleanup on shutdown / reload
  pi.on("session_shutdown", () => {
    unpatchSortModels();
    unpatchLoadModels();
  });
}