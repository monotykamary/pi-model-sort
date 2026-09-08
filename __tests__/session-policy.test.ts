import { describe, expect, it } from "vitest";
import { isInteractiveModelSession, shouldSelectMru } from "../src/session-policy.js";

describe("interactive model preferences", () => {
  it.each(["rpc", "print", "json", "sdk", undefined])("does not mutate models, thinking, or history in %s", mode => {
    expect(isInteractiveModelSession(mode)).toBe(false);
    expect(shouldSelectMru(mode, "startup", [])).toBe(false);
  });

  it("does not apply interactive preferences inside a Fabric worker", () => {
    expect(isInteractiveModelSession("tui", "child-run")).toBe(false);
    expect(shouldSelectMru("tui", "new", [], "child-run")).toBe(false);
  });

  it.each(["startup", "new"])("retains unspecified interactive %s defaults", reason => {
    expect(shouldSelectMru("tui", reason, [])).toBe(true);
  });

  it.each(["reload", "resume", "fork"])("preserves %s selection", reason => {
    expect(shouldSelectMru("tui", reason, [])).toBe(false);
  });

  it.each(["--model", "--provider", "--models", "--thinking", "--session", "--resume", "-r", "--continue", "-c", "--fork"])("respects explicit %s", flag => {
    expect(shouldSelectMru("tui", "startup", [flag, "requested"])).toBe(false);
    expect(shouldSelectMru("tui", "startup", [`${flag}=requested`])).toBe(false);
    expect(shouldSelectMru("tui", "new", [flag, "requested"])).toBe(false);
  });

  it("does not treat prompt text after -- as CLI model selection", () => {
    expect(shouldSelectMru("tui", "startup", ["--", "--model", "example"])).toBe(true);
    expect(shouldSelectMru("tui", "startup", ["--model-picker"])).toBe(true);
  });
});
