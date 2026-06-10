import { describe, expect, it } from "vitest";
import { buildModelKey, parseModelKey, sortByLastUsed } from "../src/index.js";

describe("buildModelKey", () => {
  it("builds a key from provider and model id", () => {
    expect(buildModelKey("anthropic", "claude-sonnet-4-20250514")).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("builds a key for openai provider", () => {
    expect(buildModelKey("openai", "gpt-4o")).toBe("openai/gpt-4o");
  });
});

describe("parseModelKey", () => {
  it("parses a simple provider/modelId key", () => {
    expect(parseModelKey("anthropic/claude-sonnet-4")).toEqual([
      "anthropic",
      "claude-sonnet-4",
    ]);
  });

  it("parses a key where modelId contains slashes", () => {
    expect(parseModelKey("openrouter/anthropic/claude-sonnet-4")).toEqual([
      "openrouter",
      "anthropic/claude-sonnet-4",
    ]);
  });

  it("returns undefined for keys without a slash", () => {
    expect(parseModelKey("noprovider")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseModelKey("")).toBeUndefined();
  });

  it("round-trips through buildModelKey", () => {
    const provider = "openrouter";
    const modelId = "anthropic/claude-sonnet-4";
    const key = buildModelKey(provider, modelId);
    expect(parseModelKey(key)).toEqual([provider, modelId]);
  });
});

describe("sortByLastUsed", () => {
  const models = [
    { provider: "anthropic", id: "claude-opus-4" },
    { provider: "anthropic", id: "claude-sonnet-4" },
    { provider: "openai", id: "gpt-4o" },
    { provider: "google", id: "gemini-2.5-pro" },
    { provider: "openai", id: "gpt-4.1" },
  ];

  it("sorts by last-used descending when all have timestamps", () => {
    const lastUsed: Record<string, number> = {
      "google/gemini-2.5-pro": 300,
      "openai/gpt-4.1": 500,
      "openai/gpt-4o": 100,
      "anthropic/claude-sonnet-4": 400,
      "anthropic/claude-opus-4": 200,
    };

    const sorted = sortByLastUsed(models, lastUsed, null);
    expect(sorted.map((m) => buildModelKey(m.provider, m.id))).toEqual([
      "openai/gpt-4.1",        // 500
      "anthropic/claude-sonnet-4", // 400
      "google/gemini-2.5-pro", // 300
      "anthropic/claude-opus-4",   // 200
      "openai/gpt-4o",             // 100
    ]);
  });

  it("puts current model first regardless of timestamp", () => {
    const lastUsed: Record<string, number> = {
      "google/gemini-2.5-pro": 999,       // Most recent
      "openai/gpt-4o": 500,
      "anthropic/claude-sonnet-4": 100,   // Least recent — but current
    };

    const sorted = sortByLastUsed(models, lastUsed, "anthropic/claude-sonnet-4");
    expect(sorted[0]).toEqual({ provider: "anthropic", id: "claude-sonnet-4" });
  });

  it("treats missing entries as timestamp 0 (sorted last)", () => {
    const lastUsed: Record<string, number> = {
      "anthropic/claude-opus-4": 200,
      "openai/gpt-4o": 100,
    };

    const sorted = sortByLastUsed(models, lastUsed, null);
    // Models with timestamps come before those without
    const keys = sorted.map((m) => buildModelKey(m.provider, m.id));
    const withTimestamps = keys.filter((k) => k in lastUsed);
    const withoutTimestamps = keys.filter((k) => !(k in lastUsed));

    expect(withTimestamps).toEqual([
      "anthropic/claude-opus-4",
      "openai/gpt-4o",
    ]);

    // Without-timestamp models fall back to provider/id alphabetical
    expect(withoutTimestamps).toEqual([
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-pro",
      "openai/gpt-4.1",
    ]);
  });

  it("falls back to provider then id alphabetical for ties", () => {
    const lastUsed: Record<string, number> = {
      "anthropic/claude-opus-4": 200,
      "anthropic/claude-sonnet-4": 200, // Same timestamp as opus
    };

    const tied = [
      { provider: "anthropic", id: "claude-sonnet-4" },
      { provider: "anthropic", id: "claude-opus-4" },
    ];

    const sorted = sortByLastUsed(tied, lastUsed, null);
    expect(sorted.map((m) => m.id)).toEqual(["claude-opus-4", "claude-sonnet-4"]);
  });

  it("handles empty lastUsed map gracefully", () => {
    const sorted = sortByLastUsed(models, {}, null);
    // Should fall back to provider then id alphabetical
    expect(sorted.map((m) => buildModelKey(m.provider, m.id))).toEqual([
      "anthropic/claude-opus-4",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-pro",
      "openai/gpt-4.1",
      "openai/gpt-4o",
    ]);
  });

  it("handles empty models array", () => {
    const sorted = sortByLastUsed([], {}, null);
    expect(sorted).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const original = [...models];
    sortByLastUsed(models, {
      "openai/gpt-4o": 999,
    }, null);
    expect(models).toEqual(original);
  });

  it("sorts by provider alphabetically when no last-used data and no current model", () => {
    const crossProvider = [
      { provider: "google", id: "gemini-2.5-pro" },
      { provider: "openai", id: "gpt-4o" },
      { provider: "anthropic", id: "claude-sonnet-4" },
    ];

    const sorted = sortByLastUsed(crossProvider, {}, null);
    expect(sorted.map((m) => m.provider)).toEqual([
      "anthropic",
      "google",
      "openai",
    ]);
  });
});