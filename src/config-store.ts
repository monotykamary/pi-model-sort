import { randomUUID } from "node:crypto";
import {
  accessSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { parseConfig, type ModelSortConfig, type ThinkingUpdate } from "./index.js";

export interface ConfigDelta {
  lastUsed?: readonly [key: string, timestamp: number];
  thinking?: ThinkingUpdate;
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Follow the final symlink as the previous writeFileSync did, including a
// dangling link whose target directory exists. Lock the canonical target so
// sessions reaching it through different links use the same lock.
function resolveTarget(path: string): string {
  for (let links = 0; links < 40; links++) {
    const dir = realpathSync.native(dirname(path));
    const target = join(dir, basename(path));
    try {
      if (!lstatSync(target).isSymbolicLink()) return target;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return target;
      throw error;
    }
    const link = readlinkSync(target);
    path = isAbsolute(link) ? link : `${dir}${sep}${link}`;
  }
  throw new Error("Too many model-sort config symlinks");
}

function readStoredConfig(path: string): { data: unknown; mode?: number } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { data: {} };
    throw error;
  }
  if (!stat.isFile()) throw new Error("Model-sort config is not a regular file");
  return { data: JSON.parse(readFileSync(path, "utf8")) as unknown, mode: stat.mode & 0o7777 };
}

export function readConfig(path: string): ModelSortConfig {
  try {
    return parseConfig(readStoredConfig(resolveTarget(path)).data);
  } catch {
    return { lastUsed: {}, thinking: {} };
  }
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function acquireLock(path: string): boolean {
  const deadline = performance.now() + 100;
  do {
    try {
      mkdirSync(path, { mode: 0o700 });
      return true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    Atomics.wait(lockWait, 0, 0, Math.min(5, remaining));
  } while (performance.now() < deadline);
  return false;
}

function replaceConfig(path: string, data: unknown, mode: number | undefined): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", mode === undefined ? 0o666 : 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(data, null, 2) + "\n", "utf8");
      if (mode !== undefined) fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort, only our own file */ }
    throw error;
  }
}

/** Read, merge just this event, and publish under one cross-process lock. */
export function updateConfig(path: string, delta: ConfigDelta): ModelSortConfig | undefined {
  if (!delta.lastUsed && !delta.thinking) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const target = resolveTarget(path);
    const lock = `${target}.lock`;
    // Never remove a lock we didn't acquire, even if it looks old. A killed
    // writer may leave a lock behind; in that case sessions stay in-memory.
    if (!acquireLock(lock)) return;
    try {
      const { data, mode } = readStoredConfig(target);
      // Preserve unknown fields and untouched entries, including individual
      // entries the runtime parser doesn't understand. Reject malformed roots
      // or maps before publishing rather than treating them as an empty file.
      if (!isRecord(data) || ("lastUsed" in data && !isRecord(data.lastUsed)) || ("thinking" in data && !isRecord(data.thinking))) return;
      const merged = { ...data };
      let changed = false;
      if (delta.lastUsed) {
        const [key, timestamp] = delta.lastUsed;
        const lastUsed = data.lastUsed as Record<string, unknown> | undefined;
        const previous = lastUsed?.[key];
        if (typeof previous !== "number" || !Number.isFinite(previous) || timestamp > previous) {
          merged.lastUsed = { ...lastUsed, [key]: timestamp };
          changed = true;
        }
      }
      if (delta.thinking) {
        const [key, level] = delta.thinking;
        const thinking = data.thinking as Record<string, unknown> | undefined;
        if (thinking?.[key] !== level) {
          merged.thinking = { ...thinking, [key]: level };
          changed = true;
        }
      }
      if (changed) {
        if (mode !== undefined) accessSync(target, constants.W_OK);
        replaceConfig(target, merged, mode);
      }
      return parseConfig(merged);
    } finally {
      try { rmdirSync(lock); } catch { /* storage is best effort */ }
    }
  } catch {
    return undefined;
  }
}
