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
- **MRU on interactive startup** — unspecified TUI sessions start on your most recently used authenticated model within the configured scope. Explicit model/provider/scope/thinking and restored-session selections always win.
- **Per-model thinking levels** — remembers the thinking level you last used on each model and restores it on every switch (`/model`, `Ctrl+P`, session restore), clamped to what each model supports
- **Persistent** — usage data lives in `~/.pi/agent/extensions/pi-model-sort.json`, survives restarts
- **No config needed** — install and forget; the extension starts tracking on first use
- **Zero setup** — with no recorded usage, models fall back to the default alphabetical order
- **Interactive pickers** — the sort applies to `/model` (`Ctrl+L`), both "Scope: all" and "Scope: scoped" views, and the `/scoped-models` config selector

No `settings.json` modifications. No manual maintenance. No database.

## Usage

The extension works automatically — there are no commands to learn.

```bash
# Install, then just use pi normally
/model                    # Most recently used models appear at the top
Ctrl+P / Ctrl+Shift+P     # Cycle through models in last-used order
```

Open `/model` and press `Tab` to switch between "Scope: all" and "Scope: scoped" — both views are sorted by recency.

### Model selection authority

MRU selection is an interactive default, not permission to replace a caller's model. Explicit `--model`, `--provider`, `--models`, `--thinking`, and session restore/continue/fork flags suppress startup MRU selection (including `--flag=value` forms). Resume, reload, and fork lifecycle events never select MRU. Candidates must remain within the session's configured model scope.

RPC, print, JSON, SDK/non-TUI sessions, and Fabric workers do not apply MRU model selection or remembered thinking levels, patch their registries, or write interactive usage history. In particular, `ctx.hasUI` is not an interactive-mode test: Pi RPC also exposes UI methods. Interactive sessions keep picker sorting and per-model thinking memory.

### Config File

The extension creates `~/.pi/agent/extensions/pi-model-sort.json` automatically on first model switch:

```json
{
  "lastUsed": {
    "anthropic/claude-sonnet-4-20250514": 1717000000000,
    "openai/gpt-4o": 1716995000000,
    "google/gemini-2.5-pro": 1716000000000
  },
  "thinking": {
    "deepseek/deepseek-v4-flash": "max",
    "anthropic/claude-sonnet-4-20250514": "high"
  }
}
```

No manual editing needed. To clear usage history, delete the file and `/reload`.

### Per-Model Thinking Levels

Pi keeps one global thinking level: switching models carries the current level over and clamps it to the new model, so you have to re-adjust it after every switch. This extension learns your per-model preference automatically:

- Change the level with `Ctrl+T` or `/thinking` — it's recorded for the active model
- Switch models — the model's last-used level is restored (including when cycling with `Ctrl+P`)
- The restored level is clamped to what the model supports, so a `max` remembered for one model can never push a claude model past `high`

Example: deepseek-v4-flash stays on `max`, luna on `xhigh`, claude models on `high` — set each once and every switch lands on the right level.

## Install

**With `pi install`** (recommended):

```bash
pi install npm:pi-model-sort
```

Or install from GitHub:

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

Session starts (startup / new)
  → Extension reads pi-model-sort.json
  → Monkey-patches ModelSelectorComponent.prototype:
      sortModels — sorts "Scope: all" view
      loadModelsFromSnapshot — sorts "Scope: scoped" scopedModelItems after load
        (loadModels on pi <= 0.80.3; renamed/split in 0.80.8)
  → Patches the interactive ModelRegistry instance getAvailable/getAll
  → Monkey-patches AgentSession.prototype._cycleScopedModel
  → Sort order: current model first → most recent → provider/id alphabetical
  → Patches survive modelRegistry.refresh()
  → Overrides initial model to MRU via pi.setModel()
      if pi core chose a different model (scopedModels[0], defaultModelPerProvider)
      only on unspecified TUI startup/new sessions, within the configured scope
      never for explicit CLI selection, resumed sessions, RPC/print/JSON/SDK, or Fabric workers
```

**Five patches + MRU startup override, full coverage:**

| Patch | What it affects |
|-------|----------------|
| `ModelSelectorComponent.prototype.sortModels` | `/model` TUI picker — "Scope: all" view |
| `ModelSelectorComponent.prototype.loadModelsFromSnapshot` (or `loadModels` on older pi) | `/model` TUI picker — "Scope: scoped" view (configured cycling models) |
| `AgentSession.prototype._cycleScopedModel` | `Ctrl+P` / `Ctrl+Shift+P` cycling order (non-destructive swap, cycling does not update last-used to avoid feedback loop) |
| `ModelRegistry.getAvailable()` | Interactive `/scoped-models` config selector |
| `ModelRegistry.getAll()` | Interactive catalogue enumeration |
| `pi.setModel()` on `session_start` | MRU default only for unspecified interactive startup and `/new` |

When no scoped models are configured, Ctrl+P falls through to `_cycleAvailableModel` which calls `getAvailable()` — already sorted by the registry patch.

> **Why cycling doesn't update last-used:** Updating timestamps during Ctrl+P cycling creates a feedback loop — each cycle makes the selected model most-recent, re-sorts it to position 0, and `(currentIndex + 1) % len` always lands on the second model. Models would toggle forever between the top 2. Manual model selection (`/model`, session restore) still updates last-used.

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