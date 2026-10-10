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
  const thinking = { level: "high" };
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler), setModel: vi.fn(async (_model: unknown) => true), getThinkingLevel: () => thinking.level, setThinkingLevel: vi.fn() };
  const registry = { getAvailable: () => [requested, mru], getAll: () => [requested, mru], find: (provider: string, id: string) => [requested, mru].find(m => m.provider === provider && m.id === id), hasConfiguredAuth: () => true };
  const ctx = { mode, model: requested, modelRegistry: registry, scopedModels: [] as Array<{ model: typeof requested }> };
  extension(pi as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  cleanups.push(() => emit("session_shutdown"));
  return { pi, ctx, emit, thinking };
};

const config = (lastUsed: Record<string, number>, thinking: Record<string, string>) =>
  files.read.mockReturnValue(JSON.stringify({ lastUsed, thinking }));
const lastWrittenThinking = () => JSON.parse(files.write.mock.calls.at(-1)![1] as string).thinking;

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

// Pi chooses the startup model and thinking level before session_start and
// emits no model_select when the MRU is already that model (#3).
describe("startup thinking restore", () => {
  const mruIsRequested = () => config({ "openai-codex/gpt-5.6-sol": 2, "runinfra/glm-5-3-flash": 1 }, { "openai-codex/gpt-5.6-sol": "high" });

  it("restores the remembered level when the startup model already is the MRU", async () => {
    mruIsRequested();
    const h = harness();
    h.thinking.level = "medium";
    await h.emit("session_start", { reason: "startup" });
    expect(h.pi.setModel).not.toHaveBeenCalled();
    expect(h.pi.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("high");
  });

  it("restores the remembered level on an unspecified /new", async () => {
    mruIsRequested();
    const h = harness();
    h.thinking.level = "medium";
    await h.emit("session_start", { reason: "new" });
    expect(h.pi.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("high");
  });

  it("does nothing when the startup level already matches", async () => {
    mruIsRequested();
    const h = harness();
    await h.emit("session_start", { reason: "startup" });
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it.each([["--thinking", "low"], ["--model", "openai-codex/gpt-5.6-sol:low"], ["--continue"], ["--session", "abc"]])("keeps the startup level with explicit %s", async (...args) => {
    mruIsRequested();
    const h = harness();
    h.thinking.level = "low";
    process.argv.push(...args);
    await h.emit("session_start", { reason: "startup" });
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it.each(["reload", "resume", "fork"])("keeps the session's level on %s", async reason => {
    mruIsRequested();
    const h = harness();
    h.thinking.level = "medium";
    await h.emit("session_start", { reason });
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("restores the startup model's level when switching to the MRU fails", async () => {
    const h = harness();
    h.thinking.level = "medium";
    h.pi.setModel.mockResolvedValueOnce(false);
    await h.emit("session_start", { reason: "startup" });
    expect(h.pi.setModel).toHaveBeenCalledExactlyOnceWith(mru);
    expect(h.pi.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("max");
  });

  it("leaves the restore to model_select when it switches to the MRU", async () => {
    const h = harness();
    h.thinking.level = "medium";
    await h.emit("session_start", { reason: "startup" });
    expect(h.pi.setModel).toHaveBeenCalledExactlyOnceWith(mru);
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("does not record Pi's startup level for the model it replaces with the MRU", async () => {
    const h = harness();
    h.thinking.level = "medium";
    // Native setModel: switch, apply Pi's switch default, then emit model_select.
    h.pi.setModel.mockImplementationOnce(async model => {
      h.ctx.model = model as typeof mru;
      h.thinking.level = "low";
      await h.emit("thinking_level_select", { level: "low", previousLevel: "medium" });
      await h.emit("model_select", { model, previousModel: requested, source: "set" });
      return true;
    });
    await h.emit("session_start", { reason: "startup" });
    expect(lastWrittenThinking()).toEqual({ "openai-codex/gpt-5.6-sol": "max" });
  });

  it("does not record Pi's startup level when the MRU switch keeps the level", async () => {
    const h = harness();
    h.pi.setModel.mockImplementationOnce(async model => {
      h.ctx.model = model as typeof mru;
      await h.emit("model_select", { model, previousModel: requested, source: "set" });
      return true;
    });
    await h.emit("session_start", { reason: "startup" });
    expect(lastWrittenThinking()).toEqual({ "openai-codex/gpt-5.6-sol": "max" });
  });
});
