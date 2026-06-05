<div align="center">

# 🔄 pi-model-sort

**Sort models by last usage in [pi](https://github.com/earendil-works/pi-coding-agent)**

_Your most-used models appear first — no more scrolling past providers you never touch._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## The Problem

Pi's `/model` selector sorts models alphabetically by provider. If you have Anthropic + OpenAI + Google + Ollama all configured, your most-used model might be buried behind twenty other models. Every time you open the picker, you scroll past providers you haven't touched in weeks. There's no built-in way to say *"show me what I actually use."*

## The Solution

`pi-model-sort` tracks every model selection and reorders the `/model` picker so your most recently used models appear at the top.

- **Automatic tracking** — every `/model` switch, `Ctrl+P` cycle, and session restore is recorded with a Unix timestamp
- **Sort order** — current model first → most recently used descending → provider/id alphabetical fallback
- **Persistent** — usage data lives in `~/.pi/agent/extensions/pi-model-sort.json`, survives restarts
- **No config needed** — install and forget; the extension starts tracking on first use
- **Zero setup** — with no recorded usage, models fall back to the default alphabetical order
- **Everywhere** — the sort applies to `/model` (`Ctrl+L`), both "Scope: all" and "Scope: scoped" views, `--list-models` CLI, and the `/scoped-models` config selector

No `settings.json` modifications. No manual maintenance. No database.

## Usage

The extension works automatically — there are no commands to learn.

```bash
# Install, then just use pi normally
/model                    # Most recently used models now appear at the top
pi --list-models          # CLI output is also sorted by last usage
```

Open `/model` and press `Tab` to switch between "Scope: all" and "Scope: scoped" — both views are sorted by recency.

### Config File

The extension creates `~/.pi/agent/extensions/pi-model-sort.json` automatically on first model switch:

```json
{
  "lastUsed": {
    "anthropic/claude-sonnet-4-20250514": 1717000000000,
    "openai/gpt-4o": 1716995000000,
    "google/gemini-2.5-pro": 1716000000000
  }
}
```

No manual editing needed. To clear usage history, delete the file and `/reload`.

## Install

**With `pi install`** (recommended):

```bash
pi install https://github.com/monotykamary/pi-model-sort
```

**With npm**:

```bash
npm install pi-model-sort
```

Or in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/monotykamary/pi-model-sort"
  ]
}
```

Then `/reload` or restart pi.

For quick one-off tests:

```bash
pi -e ./model-sort.ts
```

## How It Works

```
model_select event fires
  → Extension records timestamp
  → Writes to pi-model-sort.json
  → Next /model opens with updated sort

Session starts
  → Extension reads pi-model-sort.json
  → Monkey-patches ModelSelectorComponent.prototype:
      sortModels — sorts "Scope: all" view
      loadModels — sorts "Scope: scoped" scopedModelItems after load
  → Monkey-patches ModelRegistry.prototype.getAvailable/getAll
  → Sort order: current model first → most recent → provider/id alphabetical
  → Patches survive modelRegistry.refresh()
```

**Four patches, full coverage:**

| Patch | What it affects |
|-------|----------------|
| `ModelSelectorComponent.prototype.sortModels` | `/model` TUI picker — "Scope: all" view |
| `ModelSelectorComponent.prototype.loadModels` | `/model` TUI picker — "Scope: scoped" view (configured cycling models) |
| `ModelRegistry.prototype.getAvailable()` | `/scoped-models` config selector, model resolution |
| `ModelRegistry.prototype.getAll()` | `--list-models` CLI output |

The SDK doesn't expose a sort order for model lists. Monkey-patching the component and registry methods is the only way to control ordering without rebuilding the entire picker UI.

The patches survive `modelRegistry.refresh()` because they wrap the original methods. On reload, the extension detects the prototypes are already patched and just updates the last-used data source.

## Comparison with Alternatives

| Approach | Pros | Cons |
|----------|------|------|
| **pi-model-sort** (this) | Automatic, zero-config, persistent, applies everywhere | Monkey-patches internal prototypes |
| `enabledModels` in `settings.json` (manual) | Built-in, no extension needed | Allowlist — must list models manually; doesn't sort, just scopes |
| Custom `/model` replacement extension | Full control over UI | Rebuilds the entire picker component from scratch (~400 lines of TUI code) |
| Manually ordering `models.json` | Controls `--list-models` output | Static, doesn't react to actual usage; doesn't affect `/model` picker |

## Development

```bash
npm install
npm test          # Vitest unit tests
npm run typecheck # TypeScript validation
npm run lint:dead # Dead code detection (knip)
```

### Structure

```
.
├── model-sort.ts       # Main extension
├── src/
│   └── index.ts        # Sort logic, types, and utilities
├── __tests__/
│   └── sort.test.ts    # Unit tests for sortByLastUsed
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── knip.json
```

## License

MIT