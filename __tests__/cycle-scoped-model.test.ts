import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const agentDir = mkdtempSync(join(tmpdir(), "pi-model-sort-cycle-test-"));

interface CycleCall {
  direction: unknown;
  options: unknown;
  scopedOrder: string[];
}

const cycleCalls: CycleCall[] = [];

// Mirrors pi 0.85.x: the real implementation dereferences `options.persist`,
// so a missing second argument throws a TypeError. Swappable so a test can
// force the underlying implementation to throw.
let cycleImpl: (
  this: { _scopedModels: Array<{ model: { provider: string; id: string } }> },
  direction?: string,
  options?: { persist?: boolean },
) => Promise<unknown> = async function (this, direction, options) {
  if (!options) {
    throw new TypeError("Cannot read properties of undefined (reading 'persist')");
  }
  cycleCalls.push({
    direction,
    options,
    scopedOrder: this._scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`),
  });
  return { direction };
};

vi.mock("@earendil-works/pi-coding-agent", () => {
  class AgentSession {
    _scopedModels: Array<{ model: { provider: string; id: string }; thinkingLevel?: string }> = [];

    async _cycleScopedModel(direction?: string, options?: { persist?: boolean }) {
      return cycleImpl.call(this, direction, options);
    }
  }

  class ModelRegistry {
    getAvailable() {
      return [];
    }
    getAll() {
      return [];
    }
  }

  class ModelSelectorComponent {
    sortModels<T>(models: T[]) {
      return models;
    }
    loadModelsFromSnapshot() {}
    filterModels() {}
  }

  return {
    AgentSession,
    ModelRegistry,
    ModelSelectorComponent,
    getAgentDir: () => agentDir,
  };
});

type SessionStartHandler = (event: { reason: string }, ctx: unknown) => Promise<void>;

let factory: (pi: unknown) => void;
const handlers = new Map<string, SessionStartHandler>();

beforeAll(async () => {
  ({ default: factory } = await import("../model-sort.js"));

  const pi = {
    on: (event: string, handler: SessionStartHandler) => handlers.set(event, handler),
    setModel: vi.fn(),
    getThinkingLevel: () => "medium",
    setThinkingLevel: vi.fn(),
  };
  const modelRegistry = {
    getAvailable: () => [],
    getAll: () => [],
    find: () => undefined,
    hasConfiguredAuth: () => false,
  };

  factory(pi);
  // The extension only patches interactive sessions (session-policy gate).
  delete process.env.PI_FABRIC_PARENT_RUN;
  await handlers.get("session_start")!(
    { reason: "startup" },
    { mode: "tui", modelRegistry, model: undefined },
  );
});

async function createSession(scoped: Array<{ provider: string; id: string }>) {
  const { AgentSession } = (await import("@earendil-works/pi-coding-agent")) as unknown as {
    AgentSession: new () => { _scopedModels: Array<{ model: { provider: string; id: string } }> };
  };
  const session = new AgentSession();
  session._scopedModels = scoped.map((model) => ({ model }));
  return session as unknown as {
    _scopedModels: Array<{ model: { provider: string; id: string } }>;
    _cycleScopedModel(direction: string, options?: unknown): Promise<unknown>;
  };
}

describe("_cycleScopedModel patch", () => {
  it("forwards cycle options instead of dropping them", async () => {
    cycleCalls.length = 0;
    const session = await createSession([
      { provider: "openai", id: "gpt-4o" },
      { provider: "anthropic", id: "claude-sonnet-4" },
    ]);

    await expect(session._cycleScopedModel("forward", { persist: false })).resolves.toEqual({
      direction: "forward",
    });

    expect(cycleCalls).toHaveLength(1);
    expect(cycleCalls[0]!.direction).toBe("forward");
    expect(cycleCalls[0]!.options).toEqual({ persist: false });
  });

  it("cycles in last-used order and restores the configured order", async () => {
    cycleCalls.length = 0;
    const session = await createSession([
      { provider: "openai", id: "gpt-4o" },
      { provider: "anthropic", id: "claude-sonnet-4" },
    ]);
    const originalOrder = session._scopedModels.map((entry) => entry.model.id);

    await session._cycleScopedModel("backward", { persist: true });

    // No usage data on disk in the test config dir: alphabetical fallback.
    expect(cycleCalls[0]!.scopedOrder).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
    ]);
    expect(session._scopedModels.map((entry) => entry.model.id)).toEqual(originalOrder);
  });

  it("forwards options through the single-scope fast path", async () => {
    cycleCalls.length = 0;
    const session = await createSession([{ provider: "openai", id: "gpt-4o" }]);

    await expect(session._cycleScopedModel("forward", { persist: true })).resolves.toEqual({
      direction: "forward",
    });

    expect(cycleCalls).toHaveLength(1);
    expect(cycleCalls[0]!.options).toEqual({ persist: true });
  });

  it("restores the configured order when the underlying cycle throws", async () => {
    const session = await createSession([
      { provider: "openai", id: "gpt-4o" },
      { provider: "anthropic", id: "claude-sonnet-4" },
    ]);
    const originalOrder = session._scopedModels.map((entry) => entry.model.id);
    const defaultImpl = cycleImpl;
    cycleImpl = () => {
      throw new Error("cycle failed");
    };

    try {
      await expect(session._cycleScopedModel("forward", { persist: false })).rejects.toThrow(
        "cycle failed",
      );
      expect(session._scopedModels.map((entry) => entry.model.id)).toEqual(originalOrder);
    } finally {
      cycleImpl = defaultImpl;
    }
  });
});
