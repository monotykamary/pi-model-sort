import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const files = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("node:fs", () => ({
  readFileSync: files.read, writeFileSync: files.write, existsSync: () => true, mkdirSync: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/test-agent",
  ModelRegistry: class {},
  AgentSession: class { async _cycleScopedModel() {} },
  ModelSelectorComponent: class { sortModels() {} filterModels() {} },
}));
import extension from "../model-sort.js";

const requested = { provider: "openai-codex", id: "gpt-5.6-sol" };
const mru = { provider: "runinfra", id: "glm-5-3-flash" };
const cleanups: Array<() => unknown> = [];
const argv = process.argv;

beforeEach(() => {
  vi.stubEnv("PI_FABRIC_PARENT_RUN", "");
  process.argv = ["node", "pi"];
  files.read.mockReturnValue(JSON.stringify({ lastUsed: { "runinfra/glm-5-3-flash": 2, "openai-codex/gpt-5.6-sol": 1 }, thinking: { "openai-codex/gpt-5.6-sol": "max" } }));
  files.write.mockClear();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  process.argv = argv;
  vi.unstubAllEnvs();
});

const harness = (mode = "tui") => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler), setModel: vi.fn(), getThinkingLevel: () => "high", setThinkingLevel: vi.fn() };
  const registry = { getAvailable: () => [requested, mru], getAll: () => [requested, mru], find: (provider: string, id: string) => [requested, mru].find(m => m.provider === provider && m.id === id), hasConfiguredAuth: () => true };
  const ctx = { mode, model: requested, modelRegistry: registry, scopedModels: [] as Array<{ model: typeof requested }> };
  extension(pi as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  cleanups.push(() => emit("session_shutdown"));
  return { pi, ctx, emit };
};

describe("model-sort extension lifecycle", () => {
  it.each(["rpc", "print", "json", "sdk"])("never overrides selection or thinking, or writes MRU history in %s", async mode => {
    const h = harness(mode);
    const original = h.ctx.modelRegistry.getAvailable;
    await h.emit("session_start", { reason: "startup" });
    await h.emit("model_select", { model: requested, previousModel: mru, source: "set" });
    await h.emit("thinking_level_select", { level: "high", previousLevel: "low" });
    expect(h.pi.setModel).not.toHaveBeenCalled();
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(files.write).not.toHaveBeenCalled();
    expect(h.ctx.modelRegistry.getAvailable).toBe(original);
  });

  it("keeps MRU interactive defaults but not an explicit --model", async () => {
    const h = harness();
    process.argv.push("--model", "openai-codex/gpt-5.6-sol");
    await h.emit("session_start", { reason: "startup" });
    expect(h.pi.setModel).not.toHaveBeenCalled();
    expect(h.ctx.modelRegistry.getAvailable()).toEqual([mru, requested]);
  });

  it("selects MRU for an unspecified interactive startup", async () => {
    const h = harness();
    await h.emit("session_start", { reason: "startup" });
    expect(h.pi.setModel).toHaveBeenCalledExactlyOnceWith(mru);
  });

  it("does not select a most-recent model outside the configured scope", async () => {
    const h = harness();
    h.ctx.scopedModels = [{ model: requested }];
    await h.emit("session_start", { reason: "startup" });
    expect(h.pi.setModel).not.toHaveBeenCalled();
  });

  it("retains interactive thinking memory on manual model switches", async () => {
    const h = harness();
    await h.emit("session_start", { reason: "reload" });
    await h.emit("model_select", { model: requested, previousModel: mru, source: "set" });
    expect(h.pi.setThinkingLevel).toHaveBeenCalledWith("max");
    expect(files.write).toHaveBeenCalled();
  });
});
