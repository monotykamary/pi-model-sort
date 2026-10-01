import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentSession, initTheme, ModelRegistry, ModelRuntime, ModelSelectorComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
const root = resolve(".tmp/pi1-model");
const handlers = new Map<string, any>();
let runtime: ModelRuntime; let models: any[];
beforeAll(async () => {
  mkdirSync(root + "/extensions", { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", root); vi.stubEnv("PI_FABRIC_PARENT_RUN", "");
  runtime = await ModelRuntime.create({ authPath: root + "/auth.json", modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models = [...runtime.getModels("anthropic")].slice(0, 3);
  expect(models).toHaveLength(3);
  writeFileSync(root + "/extensions/pi-model-sort.json", JSON.stringify({ lastUsed: { [`${models[2].provider}/${models[2].id}`]: 3, [`${models[1].provider}/${models[1].id}`]: 2, [`${models[0].provider}/${models[0].id}`]: 1 } }));
  runtime.getAvailableSnapshot = () => models;
  runtime.getAvailable = async () => models;
  runtime.refresh = async () => ({ errors: new Map(), aborted: false }) as any;
  initTheme("dark", false);
  const extension = (await import("../model-sort.js")).default;
  extension({ on: (n: string, f: any) => handlers.set(n, f) } as any);
  await handlers.get("session_start")({ reason: "reload" }, { mode: "tui", modelRegistry: new ModelRegistry(runtime), model: models[0] });
});
afterAll(async () => { await handlers.get("session_shutdown")?.(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("actual Pi 1.0 runtime", () => {
  it("sorts the actual availability path used by unscoped cycling", async () => {
    expect(VERSION).toBe("1.0.0");
    expect(runtime.getAvailableSnapshot()).toEqual([...models].reverse());
    expect(await runtime.getAvailable()).toEqual([...models].reverse());
  });
  it("renders and filters the real selector with scoped MRU order", async () => {
    const selector = new ModelSelectorComponent({ requestRender() {} } as any, undefined, runtime, models.map(model => ({ model })), () => {}, () => {});
    try {
      expect((selector as any).scopedModelItems.map((m: any) => m.id)).toEqual([...models].reverse().map(m => m.id));
      (selector as any).filterModels(models[0].provider);
      for (const width of [20, 80]) { selector.invalidate(); for (const line of selector.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width); }
      selector.focused = true; expect((selector as any).searchInput.focused).toBe(true);
    } finally { selector.dispose(); }
  });
  it("calls native scoped cycle and restores scope before async model_select", async () => {
    const scoped = models.map(model => ({ model }));
    let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    const session: any = { _scopedModels: scoped, _modelRuntime: runtime, model: models[2], agent: { state: {} }, sessionManager: { appendModelChange() {} }, _getThinkingLevelForModelSwitch: () => "off", setThinkingLevel() {}, _emitModelSelect: () => pending };
    const result = (AgentSession.prototype as any)._cycleScopedModel.call(session, "forward", { persist: false });
    expect(session._scopedModels).toBe(scoped);
    expect(session.agent.state.model).toBe(models[1]);
    release(); expect((await result).model).toBe(models[1]);
  });
});
