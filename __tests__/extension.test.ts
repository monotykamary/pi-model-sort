import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const files = vi.hoisted(() => ({ agent: "" }));
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  files.agent = mkdtempSync(join(tmpdir(), "model-sort-extension-"));
  return {
    getAgentDir: () => files.agent,
    ModelRegistry: class {},
    AgentSession: class { async _cycleScopedModel() {} },
    ModelSelectorComponent: class { sortModels() {} filterModels() {} },
  };
});
import extension from "../model-sort.js";

const requested = { provider: "openai-codex", id: "gpt-5.6-sol" };
const mru = { provider: "runinfra", id: "glm-5-3-flash" };
const extensions = join(files.agent, "extensions");
const configPath = join(extensions, "pi-model-sort.json");
const cleanups: Array<() => unknown> = [];
const argv = process.argv;

beforeEach(() => {
  vi.stubEnv("PI_FABRIC_PARENT_RUN", "");
  process.argv = ["node", "pi"];
  mkdirSync(extensions, { recursive: true });
  config({ "runinfra/glm-5-3-flash": 2, "openai-codex/gpt-5.6-sol": 1 }, { "openai-codex/gpt-5.6-sol": "max" });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(extensions, { recursive: true, force: true });
});
afterAll(() => rmSync(files.agent, { recursive: true, force: true }));

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
  writeFileSync(configPath, JSON.stringify({ lastUsed, thinking }));
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
const lastWrittenThinking = () => readConfig().thinking;

describe("model-sort extension lifecycle", () => {
  it.each(["rpc", "print", "json", "sdk"])("never overrides selection or thinking, or writes MRU history in %s", async mode => {
    const h = harness(mode);
    const original = h.ctx.modelRegistry.getAvailable;
    const before = readFileSync(configPath, "utf8");
    await h.emit("session_start", { reason: "startup" });
    await h.emit("model_select", { model: requested, previousModel: mru, source: "set" });
    await h.emit("thinking_level_select", { level: "high", previousLevel: "low" });
    expect(h.pi.setModel).not.toHaveBeenCalled();
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(readFileSync(configPath, "utf8")).toBe(before);
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
    expect(readConfig().lastUsed["openai-codex/gpt-5.6-sol"]).toBeGreaterThan(1);
  });
});

describe("shared history", () => {
  const a = "openai-codex/gpt-5.6-sol";
  const b = "runinfra/glm-5-3-flash";

  it("merges only the event's model and field from interleaved sessions", async () => {
    const first = harness();
    const second = harness();
    second.ctx.model = mru;
    await first.emit("session_start", { reason: "reload" });
    await second.emit("session_start", { reason: "reload" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(200);
    await second.emit("model_select", { model: mru, source: "set" });
    await second.emit("thinking_level_select", { level: "low", previousLevel: "high" });

    // The first session had already cached an older timestamp and no level for b.
    await first.emit("thinking_level_select", { level: "medium", previousLevel: "high" });
    expect(readConfig()).toEqual({ lastUsed: { [a]: 1, [b]: 200 }, thinking: { [a]: "medium", [b]: "low" } });

    await second.emit("thinking_level_select", { level: "max", previousLevel: "low" });
    clock.mockReturnValue(100);
    first.ctx.model = mru;
    first.thinking.level = "medium";
    await first.emit("model_select", { model: mru, previousModel: requested, source: "set" });
    expect(first.pi.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("max");
    expect(readConfig()).toEqual({ lastUsed: { [a]: 1, [b]: 200 }, thinking: { [a]: "medium", [b]: "max" } });
  });

  it("persists an explicit thinking change even if it matches the stale local cache", async () => {
    const first = harness();
    const second = harness();
    await first.emit("session_start", { reason: "reload" });
    await second.emit("session_start", { reason: "reload" });
    await second.emit("thinking_level_select", { level: "low", previousLevel: "max" });
    await first.emit("thinking_level_select", { level: "max", previousLevel: "high" });
    expect(lastWrittenThinking()).toEqual({ [a]: "max" });
  });

  it("records the outgoing clamp without a timestamp or a second thinking write on cycle", async () => {
    const h = harness();
    await h.emit("session_start", { reason: "reload" });
    h.ctx.model = mru;
    h.thinking.level = "medium";
    await h.emit("thinking_level_select", { level: "medium", previousLevel: "high" });
    expect(lastWrittenThinking()).toEqual({ [a]: "high" });
    // Another session updates a after the clamp. model_select must not replay it.
    config({ [a]: 1, [b]: 2 }, { [a]: "low" });
    await h.emit("model_select", { model: mru, previousModel: requested, source: "cycle" });
    expect(readConfig()).toEqual({ lastUsed: { [a]: 1, [b]: 2 }, thinking: { [a]: "low" } });
  });

  it("keeps working when the config directory is unavailable", async () => {
    const h = harness();
    await h.emit("session_start", { reason: "reload" });
    rmSync(extensions, { recursive: true });
    writeFileSync(extensions, "not a directory");
    await h.emit("thinking_level_select", { level: "low", previousLevel: "high" });
    await h.emit("model_select", { model: requested, source: "set" });
    expect(h.ctx.modelRegistry.getAvailable()).toEqual([requested, mru]);
    expect(h.pi.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("low");
    expect(readFileSync(extensions, "utf8")).toBe("not a directory");
  });

  it("keeps updates in memory on corrupt state without replaying them on unrelated writes", async () => {
    const h = harness();
    await h.emit("session_start", { reason: "reload" });
    const bad = '{"lastUsed":';
    writeFileSync(configPath, bad);
    await h.emit("model_select", { model: requested, source: "set" });
    await h.emit("thinking_level_select", { level: "low", previousLevel: "high" });
    h.pi.setThinkingLevel.mockClear();
    // No previous model: only MRU changes on this event.
    await h.emit("model_select", { model: requested, source: "set" });
    expect(h.ctx.modelRegistry.getAvailable()).toEqual([requested, mru]);
    expect(h.pi.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("low");
    expect(readFileSync(configPath, "utf8")).toBe(bad);

    rmSync(configPath);
    h.ctx.model = mru;
    await h.emit("model_select", { model: mru, source: "set" });
    expect(Object.keys(readConfig().lastUsed)).toEqual([b]);
    expect(lastWrittenThinking()).toBeUndefined();
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
