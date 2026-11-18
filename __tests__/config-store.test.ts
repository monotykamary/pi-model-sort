import { randomUUID } from "node:crypto";
import type * as Fs from "node:fs";
import { mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig, updateConfig } from "../src/config-store.js";

vi.mock("node:crypto", async importOriginal => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, randomUUID: vi.fn(crypto.randomUUID) };
});
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof Fs>();
  return { ...fs, mkdirSync: vi.fn(fs.mkdirSync), renameSync: vi.fn(fs.renameSync) };
});
const fs = await vi.importActual<typeof Fs>("node:fs");

let dir: string;
let path: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "model-sort-store-"));
  // Canonicalize temp roots like macOS /var -> /private/var for path assertions.
  dir = fs.realpathSync(dir);
  path = join(dir, "pi-model-sort.json");
});
afterEach(() => {
  vi.mocked(randomUUID).mockReset();
  vi.mocked(mkdirSync).mockReset();
  vi.mocked(renameSync).mockReset();
  fs.rmSync(dir, { recursive: true, force: true });
});

const put = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data));
const get = (file = path) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("shared config transactions", () => {
  it("reads only after acquiring a contended lock, merging the preceding publication", () => {
    const lock = `${path}.lock`;
    const precedingTemp = join(dir, "preceding.tmp");
    put(path, { lastUsed: { "p/a": 1 }, thinking: { "p/a": "low" } });
    fs.mkdirSync(lock);
    put(precedingTemp, { lastUsed: { "p/a": 50, "p/b": 30 }, thinking: { "p/a": "high", "p/b": "max" } });
    let attempts = 0;
    vi.mocked(mkdirSync).mockImplementation((file, options) => {
      if (file === lock && ++attempts === 2) {
        // The first writer publishes and releases while the second is waiting.
        fs.renameSync(precedingTemp, path);
        fs.rmdirSync(lock);
      }
      return fs.mkdirSync(file, options);
    });
    expect(updateConfig(path, { lastUsed: ["p/a", 2], thinking: ["p/c", "medium"] })).toEqual({
      lastUsed: { "p/a": 50, "p/b": 30 }, thinking: { "p/a": "high", "p/b": "max", "p/c": "medium" },
    });
    expect(attempts).toBe(2);
    expect(get()).toEqual({
      lastUsed: { "p/a": 50, "p/b": 30 }, thinking: { "p/a": "high", "p/b": "max", "p/c": "medium" },
    });
    expect(fs.readdirSync(dir)).toEqual(["pi-model-sort.json"]);
  });

  it("never steals an existing lock based on age", () => {
    const lock = `${path}.lock`;
    put(path, { lastUsed: { "p/a": 1 } });
    fs.mkdirSync(lock);
    fs.utimesSync(lock, 1, 1);
    expect(updateConfig(path, { lastUsed: ["p/a", 9] })).toBeUndefined();
    expect(get()).toEqual({ lastUsed: { "p/a": 1 } });
    expect(fs.statSync(lock).mtimeMs).toBe(1000);
  });

  it("publishes a complete exclusive sibling and cleans only its own failed temp", () => {
    put(path, { lastUsed: { "p/a": 1 } });
    fs.chmodSync(path, 0o640);
    const otherTemp = join(dir, "other-writer.tmp");
    fs.writeFileSync(otherTemp, "leave this alone");
    vi.mocked(renameSync).mockImplementationOnce((temp, target) => {
      expect(dirname(String(temp))).toBe(dir);
      expect(target).toBe(path);
      expect(fs.existsSync(`${path}.lock`)).toBe(true);
      expect(get()).toEqual({ lastUsed: { "p/a": 1 } });
      expect(get(String(temp))).toEqual({ lastUsed: { "p/a": 2 } });
      expect(fs.statSync(temp).mode & 0o777).toBe(0o640);
      fs.renameSync(temp, target);
    }).mockImplementationOnce(() => { throw new Error("rename failed"); });
    expect(updateConfig(path, { lastUsed: ["p/a", 2] })?.lastUsed).toEqual({ "p/a": 2 });
    expect(updateConfig(path, { lastUsed: ["p/a", 3] })).toBeUndefined();
    expect(vi.mocked(renameSync).mock.calls[0][0]).not.toBe(vi.mocked(renameSync).mock.calls[1][0]);
    expect(get()).toEqual({ lastUsed: { "p/a": 2 } });
    expect(fs.statSync(path).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir).sort()).toEqual(["other-writer.tmp", "pi-model-sort.json"]);
    expect(fs.readFileSync(otherTemp, "utf8")).toBe("leave this alone");
  });

  it("does not truncate or unlink a pre-existing file at the chosen temp path", () => {
    const uuid = "00000000-0000-4000-8000-000000000000";
    const occupied = `${path}.${uuid}.tmp`;
    fs.writeFileSync(occupied, "belongs to someone else");
    vi.mocked(randomUUID).mockReturnValueOnce(uuid);
    expect(updateConfig(path, { lastUsed: ["p/a", 1] })).toBeUndefined();
    expect(fs.readFileSync(occupied, "utf8")).toBe("belongs to someone else");
    expect(fs.readdirSync(dir)).toEqual([`pi-model-sort.json.${uuid}.tmp`]);
  });

  it("creates the target of a dangling relative symlink and preserves the symlink on update", () => {
    const target = join(dir, "shared", "history.json");
    fs.mkdirSync(dirname(target));
    fs.symlinkSync("shared/history.json", path);
    expect(updateConfig(path, { lastUsed: ["p/a", 1] })?.lastUsed).toEqual({ "p/a": 1 });
    expect(updateConfig(target, { thinking: ["p/b", "max"] })?.thinking).toEqual({ "p/b": "max" });
    expect(readConfig(path)).toEqual({ lastUsed: { "p/a": 1 }, thinking: { "p/b": "max" } });
    expect(fs.readlinkSync(path)).toBe("shared/history.json");
    expect(vi.mocked(renameSync).mock.calls.map(([, dest]) => dest)).toEqual([target, target]);
  });

  it.each(['{"lastUsed":', '[]', 'null', '{"lastUsed":{"p/a":9},"thinking":[]}'])("never replaces corrupt state %s", raw => {
    fs.writeFileSync(path, raw);
    expect(updateConfig(path, { thinking: ["p/b", "max"] })).toBeUndefined();
    expect(fs.readFileSync(path, "utf8")).toBe(raw);
    expect(fs.readdirSync(dir)).toEqual(["pi-model-sort.json"]);
  });

  it("keeps valid legacy entries and leaves untouched invalid entries and unknown fields alone", () => {
    put(path, { lastUsed: { "p/a": 1, "p/future": "unknown" }, extra: { opaque: true } });
    expect(updateConfig(path, { thinking: ["p/a", "high"] })).toEqual({ lastUsed: { "p/a": 1 }, thinking: { "p/a": "high" } });
    expect(get()).toEqual({ lastUsed: { "p/a": 1, "p/future": "unknown" }, thinking: { "p/a": "high" }, extra: { opaque: true } });
  });
});
