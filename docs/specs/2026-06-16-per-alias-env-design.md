# Per-alias env / multi-account support

**Date:** 2026-06-16
**Status:** Design approved, pending implementation plan

## Problem

Maestro dispatches local coding CLIs (`claude`, `codex`, …) authenticated however
the user already has them set up. To run **two accounts of the same CLI** — e.g. a
personal and a work Claude login living in different `CLAUDE_CONFIG_DIR`s — the only
mechanism today is a hand-written shell alias listed in `providers.claude.aliases`. At spawn time the alias name is not a PATH
binary, so `resolveCommandSpec` (`src/agent-runner.mjs:145`) falls back to
`shellAliasCommandSpec` → `bash -ic '<alias> ...'`, which sources the user's
`.bashrc` to resolve the alias and its embedded env.

This works but is fragile:

- Requires an **interactive** bash (`-ic`) and the user's shell rc. Breaks in CI,
  non-login shells, and any environment without that alias defined.
- The account-selecting env (`CLAUDE_CONFIG_DIR`) is set **inside the shell**,
  invisible to maestro: not in `command.json` `env_keys`, not logged, not carried
  in export bundles.
- Every account is another rc alias to maintain by hand. Not shareable.

Maestro already has a per-**provider** env map (`providers.<p>.env` →
`resolveProviderEnv` in `src/setup/keys.mjs:130` → `providerEnv` → merged into the
child env at `src/agent-runner.mjs:249,272`). But it is one env for *all* aliases of
a provider, so it cannot model multiple accounts. `CLAUDE_CONFIG_DIR` is **not** in
`ENV_KEY_DENYLIST`, so it is already a permitted key.

## Goal

Let provider aliases carry their own `env` map so multiple accounts of the same CLI
work purely through `.maestro/config.json`, without shell aliases, with the env
visible to and managed by maestro.

## Non-goals

- No change to how authentication itself happens (still delegated to the CLI).
- No new provider adapters.
- No removal of the existing `bash -ic` fallback — plain string aliases keep working
  unchanged for back-compat.

## Design

### 1. Schema & data model

An entry in `providers.<p>.aliases` becomes **a string OR an object**.

- **String** — a bare command name. Exactly today's behavior, untouched.
- **Object** — a named account:

```json
"claude": {
  "default_alias": "work",
  "aliases": [
    "claude",
    { "name": "work",     "command": "claude", "env": { "CLAUDE_CONFIG_DIR": "~/.claude-work" } },
    { "name": "personal", "env": { "CLAUDE_CONFIG_DIR": "$CLAUDE_PERSONAL_DIR" } }
  ]
}
```

Field rules:

| Field     | Required | Default                          | Meaning |
|-----------|----------|----------------------------------|---------|
| `name`    | yes      | —                                | Selectable identity; what `default_alias`, role config, and `recent.aliases_by_provider` reference. Unique within the provider. |
| `command` | no       | provider base binary             | The actual executable to spawn. |
| `env`     | no       | `{}`                             | Env injected for this account. Values support `~`, `$VAR` refs, and literal paths. Keys must pass `ENV_KEY_DENYLIST`. |

The provider **base binary** for the `command` default is derived from the provider
key (e.g. `claude`), falling back to `default_alias` when that is itself a bare
string. (For built-in providers the base binary equals the provider key.)

**Back-compat:** `"claude"` is equivalent to `{ name: "claude", command: "claude" }`.

**Normalization:** a single helper `normalizeAlias(entry, providerBase)` collapses
both forms to one internal shape `{ name, command, env }`. Schema validation, the
TUI, and the spawn path all consume normalized aliases, so no other code branches on
string-vs-object. On save, an object whose `env` is empty **and** whose `command`
equals its `name` collapses back to a bare string (lossless round-trip, tidy config).

Lives in a shared module (e.g. `src/adapters/registry.mjs` or a new
`src/providers.mjs`) so validation, TUI, and runtime share one definition.

### 2. Spawn-path & env resolution

When a role resolves to provider `claude`, alias `work`:

1. **Resolve alias object** via `normalizeAlias` →
   `{ name: "work", command: "claude", env: {...} }`.
2. **Build env** with a new `resolveAliasEnv(aliasObj, providerDef, baseEnv)`:
   merge provider-level `env` (existing `resolveProviderEnv` behavior) **then**
   alias-level `env`; alias wins on key conflict. Reuse the key-name check and
   `ENV_KEY_DENYLIST` from `resolveProviderEnv`, but resolve **values** with a
   tilde+`$VAR`-aware resolver lifted from `expandPathValue`
   (`src/setup/server-config.mjs:64`): `~/.claude-work` and inline `$VAR` both
   expand, and whole-string `$VAR` secret refs keep working. Unresolvable / empty
   values are dropped, as today.
3. **Build command:** `buildAgentCommand` (`src/agent-runner.mjs:156`) passes
   `alias.command` as the command name (not the alias `name`).
   `buildClaudeCommand` already accepts `alias`/`commandName` — feed it `command`.
4. **Spawn:** a real binary (`claude`) satisfies `directCommandExists`, so it runs
   **directly** — no `bash -ic`. The resolved alias env flows in as `providerEnv`
   (the call at `src/langgraph/nodes.mjs:854` switches from `resolveProviderEnv` to
   `resolveAliasEnv`), merged into the child env at `src/agent-runner.mjs:272`.
   Keys land in `command.json` `env_keys`; values are never logged.
5. **Plain string aliases** are unchanged: if `command` is not on PATH (e.g.
   a shell alias) the existing `shellAliasCommandSpec` `bash -ic`
   fallback still applies, so current setups keep working.

Net: structured aliases are portable (no `.bashrc`), observable (logged keys), and
shareable (`$VAR` refs survive export bundles).

### 3. TUI editor (full)

Extend `src/tui-providers.mjs`. The flat alias string-list edit becomes an account
manager.

- **Provider summary line** gains an account count (reuses the existing alias-count
  rendering).
- **List view:** each alias renders as `name → command (n env vars)`; bare strings
  render as `name → name (shell alias)`.
- **Actions:** `[a]dd account`, `[e]dit`, `[d]elete`, `[r]ename`. Add/edit walks
  `name` → `command` (default = provider base) → env entries as `KEY=value` lines in
  an add/remove loop. Empty-env + `command == name` collapses back to a bare string
  on save.
- **default_alias picker** lists account `name`s (reuses existing `pickOne` +
  `recent.aliases_by_provider`).
- **Validation on save:** unique names within the provider; env keys must pass
  `ENV_KEY_DENYLIST` (reject inline with a message); `$VAR` refs are stored
  **literally** — never resolved in the editor, so secrets are never rendered into
  config. Writes go through the existing `shareableDef` path so `$VAR` stays a ref.

### 4. Error handling

- Duplicate `name` within a provider → config validation error (caught by schema /
  `normalizeAlias`), surfaced at load and in the TUI before save.
- Env key failing the denylist → dropped at spawn (consistent with
  `resolveProviderEnv` today) and rejected in the TUI editor with a message.
- Unresolvable `$VAR` / empty value → dropped at spawn (today's behavior).
- `command` not found on PATH and not a shell alias → existing
  `agent_failed` / spawn error path; no new handling.

## Testing

- **Unit — `normalizeAlias`:** string↔object round-trip; collapse rule
  (empty env + command==name → string); provider-base default for `command`.
- **Unit — `resolveAliasEnv`:** provider+alias merge precedence (alias wins);
  `~` expansion; inline and whole-string `$VAR` expansion; denylist rejection;
  empty/unresolvable drop.
- **Spawn — `buildAgentCommand`:** structured alias → command = `alias.command`,
  env carried; injected `spawnProcess` stub asserts child env contains
  `CLAUDE_CONFIG_DIR` and that `bash -ic` is **not** used for a PATH binary.
- **TUI:** add / edit / delete / rename account; collapse-to-string on save;
  denylist rejection surfaced; default_alias picker lists names.
- **Regression:** existing 720 tests stay green; the string-alias `bash -ic` path
  the string-alias `bash -ic` path explicitly covered so back-compat cannot silently break.

## Touch points

- `src/adapters/registry.mjs` (or new `src/providers.mjs`) — `normalizeAlias`.
- `src/setup/keys.mjs` — `resolveAliasEnv`, tilde/`$VAR`-aware value resolution.
- `src/agent-runner.mjs:156` — `buildAgentCommand` reads `alias.command`.
- `src/langgraph/nodes.mjs:854` — call `resolveAliasEnv`.
- `src/tui-providers.mjs` — account editor.
- Config schema (provider/alias validation) — accept string|object aliases.
- Tests across the files listed above.
