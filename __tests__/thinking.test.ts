import { describe, expect, it } from "vitest";
import {
  createThinkingTracker,
  handleModelSelect,
  isThinkingLevel,
  parseConfig,
  recordThinkingSelect,
  type ThinkingTrackerState,
} from "../src/index.js";

const CLAUDE = "anthropic/claude-sonnet-4";
const DEEPSEEK = "deepseek/deepseek-v4-flash";
const LUNA = "luna/luna-pro";

describe("isThinkingLevel", () => {
  it("accepts all valid levels", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(isThinkingLevel(level)).toBe(true);
    }
  });

  it("rejects invalid values", () => {
    for (const value of ["ultra", "", 1, null, undefined, {}]) {
      expect(isThinkingLevel(value)).toBe(false);
    }
  });
});

describe("parseConfig", () => {
  it("parses lastUsed and thinking maps", () => {
    const config = parseConfig({
      lastUsed: { [CLAUDE]: 1717000000000 },
      thinking: { [CLAUDE]: "high", [DEEPSEEK]: "max" },
    });
    expect(config.lastUsed[CLAUDE]).toBe(1717000000000);
    expect(config.thinking[CLAUDE]).toBe("high");
    expect(config.thinking[DEEPSEEK]).toBe("max");
  });

  it("defaults missing fields to empty maps", () => {
    expect(parseConfig({})).toEqual({ lastUsed: {}, thinking: {} });
  });

  it("handles legacy configs without a thinking map", () => {
    const config = parseConfig({ lastUsed: { [CLAUDE]: 1 } });
    expect(config.lastUsed[CLAUDE]).toBe(1);
    expect(config.thinking).toEqual({});
  });

  it("drops malformed entries", () => {
    const config = parseConfig({
      lastUsed: { [CLAUDE]: "yesterday", [DEEPSEEK]: 5 },
      thinking: { [CLAUDE]: "ultra", [DEEPSEEK]: "max" },
    });
    expect(config.lastUsed).toEqual({ [DEEPSEEK]: 5 });
    expect(config.thinking).toEqual({ [DEEPSEEK]: "max" });
  });

  it("returns empty config for garbage input", () => {
    for (const raw of [null, undefined, 42, "nope", []]) {
      expect(parseConfig(raw)).toEqual({ lastUsed: {}, thinking: {} });
    }
  });
});

describe("recordThinkingSelect", () => {
  it("records a manual change under the active model", () => {
    const state = createThinkingTracker();
    state.activeKey = CLAUDE;
    expect(recordThinkingSelect(state, CLAUDE, "high", "medium")).toBe(true);
    expect(state.thinking[CLAUDE]).toBe("high");
    expect(state.sawSwitchClamp).toBe(false);
  });

  it("records under the current model when no active model is tracked yet", () => {
    const state = createThinkingTracker();
    expect(recordThinkingSelect(state, CLAUDE, "high", "medium")).toBe(true);
    expect(state.thinking[CLAUDE]).toBe("high");
  });

  it("returns false when the level is unchanged", () => {
    const state = createThinkingTracker();
    state.activeKey = CLAUDE;
    state.thinking[CLAUDE] = "high";
    expect(recordThinkingSelect(state, CLAUDE, "high", "medium")).toBe(false);
  });

  it("attributes a switch-time re-clamp to the outgoing model", () => {
    const state = createThinkingTracker();
    state.activeKey = CLAUDE;
    // Pi swapped to deepseek, then re-clamped: current key differs from the
    // tracked key. previousLevel is claude's final level.
    expect(recordThinkingSelect(state, DEEPSEEK, "high", "max")).toBe(true);
    expect(state.thinking[CLAUDE]).toBe("max");
    expect(state.thinking[DEEPSEEK]).toBeUndefined();
    expect(state.sawSwitchClamp).toBe(true);
  });

  it("sets sawSwitchClamp even when the outgoing level was already recorded", () => {
    const state = createThinkingTracker();
    state.activeKey = CLAUDE;
    state.thinking[CLAUDE] = "max";
    expect(recordThinkingSelect(state, DEEPSEEK, "high", "max")).toBe(false);
    expect(state.sawSwitchClamp).toBe(true);
  });

  it("falls back to the active model when current key is null", () => {
    const state = createThinkingTracker();
    state.activeKey = CLAUDE;
    expect(recordThinkingSelect(state, null, "low", "medium")).toBe(true);
    expect(state.thinking[CLAUDE]).toBe("low");
  });

  it("does nothing when neither current nor active model is known", () => {
    const state = createThinkingTracker();
    expect(recordThinkingSelect(state, null, "low", "medium")).toBe(false);
    expect(state.thinking).toEqual({});
  });
});

describe("handleModelSelect", () => {
  it("records the carried-over level for the previous model when no re-clamp fired", () => {
    const state = createThinkingTracker();
    state.activeKey = CLAUDE;
    const restore = handleModelSelect(state, DEEPSEEK, CLAUDE, "high");
    expect(state.thinking[CLAUDE]).toBe("high");
    expect(restore).toBeNull();
  });

  it("does not overwrite the previous model's level when a re-clamp recorded it", () => {
    const state = createThinkingTracker();
    state.activeKey = CLAUDE;
    state.thinking[CLAUDE] = "max";
    state.sawSwitchClamp = true;
    handleModelSelect(state, DEEPSEEK, CLAUDE, "high");
    expect(state.thinking[CLAUDE]).toBe("max");
    expect(state.sawSwitchClamp).toBe(false);
  });

  it("returns the remembered level for the new model", () => {
    const state = createThinkingTracker();
    state.thinking[DEEPSEEK] = "max";
    const restore = handleModelSelect(state, DEEPSEEK, CLAUDE, "high");
    expect(restore).toBe("max");
  });

  it("returns null when the remembered level matches the current level", () => {
    const state = createThinkingTracker();
    state.thinking[DEEPSEEK] = "high";
    expect(handleModelSelect(state, DEEPSEEK, CLAUDE, "high")).toBeNull();
  });

  it("returns null when nothing is remembered for the new model", () => {
    const state = createThinkingTracker();
    expect(handleModelSelect(state, DEEPSEEK, CLAUDE, "high")).toBeNull();
  });

  it("updates activeKey to the new model", () => {
    const state = createThinkingTracker();
    handleModelSelect(state, DEEPSEEK, CLAUDE, "high");
    expect(state.activeKey).toBe(DEEPSEEK);
  });

  it("handles a first selection with no previous model", () => {
    const state = createThinkingTracker();
    const restore = handleModelSelect(state, CLAUDE, null, "medium");
    expect(restore).toBeNull();
    expect(state.activeKey).toBe(CLAUDE);
    expect(state.thinking).toEqual({});
  });
});

/** Simulate pi's event sequence for a model switch. */
function switchModel(
  state: ThinkingTrackerState,
  fromKey: string,
  toKey: string,
  clampedLevel: Parameters<typeof handleModelSelect>[3],
  preSwitchLevel: Parameters<typeof handleModelSelect>[3],
): string | null {
  // Pi re-clamps before emitting model_select; a level change emits
  // thinking_level_select with the new model already active.
  if (clampedLevel !== preSwitchLevel) {
    recordThinkingSelect(state, toKey, clampedLevel, preSwitchLevel);
  }
  const restore = handleModelSelect(state, toKey, fromKey, clampedLevel);
  if (restore !== null) {
    // Caller applies the restore; pi re-emits thinking_level_select for the
    // new model with the effective (possibly clamped) level.
    recordThinkingSelect(state, toKey, restore, clampedLevel);
  }
  return restore;
}

describe("thinking memory end-to-end", () => {
  it("restores each model's last-used level across switches", () => {
    const state: ThinkingTrackerState = createThinkingTracker();
    state.activeKey = CLAUDE;

    // User puts claude on high.
    recordThinkingSelect(state, CLAUDE, "high", "medium");

    // Switch to deepseek — level carries over unchanged (deepseek supports high).
    expect(switchModel(state, CLAUDE, DEEPSEEK, "high", "high")).toBeNull();
    expect(state.thinking[CLAUDE]).toBe("high");

    // User puts deepseek on max.
    recordThinkingSelect(state, DEEPSEEK, "max", "high");

    // Switch to luna — pi clamps max down to xhigh before model_select.
    expect(switchModel(state, DEEPSEEK, LUNA, "xhigh", "max")).toBeNull();
    expect(state.thinking[DEEPSEEK]).toBe("max");

    // Back to claude — pi clamps xhigh to high, matching claude's memory.
    expect(switchModel(state, LUNA, CLAUDE, "high", "xhigh")).toBeNull();
    expect(state.thinking[LUNA]).toBe("xhigh");

    // Back to deepseek — carries high over, but max is remembered and restored.
    expect(switchModel(state, CLAUDE, DEEPSEEK, "high", "high")).toBe("max");
    expect(state.thinking[DEEPSEEK]).toBe("max");

    // Back to luna — pi clamps max to xhigh, which already matches luna's
    // remembered level, so no restore is needed.
    expect(switchModel(state, DEEPSEEK, LUNA, "xhigh", "max")).toBeNull();

    // Switching from claude (high) to luna carries high over unchanged, so
    // luna's remembered xhigh is restored.
    switchModel(state, LUNA, CLAUDE, "high", "xhigh");
    expect(switchModel(state, CLAUDE, LUNA, "high", "high")).toBe("xhigh");
  });

  it("self-heals a remembered level that exceeds the model's capabilities", () => {
    const state = createThinkingTracker();
    state.activeKey = DEEPSEEK;
    state.thinking[CLAUDE] = "max";

    // Claude now only supports up to high. Pi clamps max to high on switch,
    // we restore max, pi clamps again to high and re-emits — recorded.
    recordThinkingSelect(state, CLAUDE, "high", "max");
    const restore = handleModelSelect(state, CLAUDE, DEEPSEEK, "high");
    expect(restore).toBe("max");
    recordThinkingSelect(state, CLAUDE, "high", "max");
    expect(state.thinking[CLAUDE]).toBe("high");

    // Next switch finds the healed value — no restore needed.
    expect(handleModelSelect(state, CLAUDE, DEEPSEEK, "high")).toBeNull();
  });
});