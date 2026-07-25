# AI Session YOLO Mode Design

## Goal

Let users configure whether Project Steward starts AI sessions in each
provider's approval-bypassing mode. The setting applies consistently when
creating a new session or resuming an inactive historical session.

## Configuration

Add the machine-scoped boolean setting
`projectSteward.aiSessionYoloMode`.

- The default is `false`.
- Only the literal boolean value `true` enables YOLO mode. A missing or invalid
  value falls back to the safe, provider-default launch behavior.
- The setting is read directly from the `projectSteward` configuration
  namespace for every provider process dispatch. It never passes through the
  legacy `dashboard.*` compatibility fallback.
- Changing the setting affects every process launched after the change while
  it remains enabled, without reloading VS Code.
- The setting is machine-scoped to match the existing AI runtime settings and
  to prevent Settings Sync from unintentionally enabling approval bypass on
  another execution host.

The setting description and README must make clear that YOLO mode bypasses
provider safety checks and affects only runtimes started after the change.

## Launch Behavior

New and resumed sessions use one explicit launch-options value:

```ts
interface AiSessionLaunchOptions {
    yolo: boolean;
}
```

The creation and resume controllers capture a single-use launch-spec factory,
not a concrete launch specification. The factory reads the current options and
calls the provider builder only at the runtime backend's final provider
dispatch boundary. Each provider builder owns the translation from the
provider-neutral option to its CLI argument:

| Provider | YOLO argument |
| --- | --- |
| Codex | `--dangerously-bypass-approvals-and-sandbox` |
| Kimi | `--yolo` |
| Claude | `--dangerously-skip-permissions` |

When `yolo` is false, builders produce the same arguments they produce today.
When it is true, they add the provider argument in a position accepted by both
new-session and resume forms.

The launch specification remains the common boundary for Direct Terminal and
tmux execution. Both runtime backends therefore receive identical provider
semantics without backend-specific YOLO logic.

The runtime coordinator snapshots identity, directory scope, marker path, and
the factory without evaluating it. Focused, blocked, conflict, cancelled, and
settings results therefore perform zero configuration reads and zero provider
builder calls. A direct or tmux dispatch evaluates the factory exactly once.
This also means a setting changed while a tmux fallback prompt is open is the
value used by the eventual accepted direct launch.

## Existing Runtime Semantics

The setting is a process-launch preference, not persistent session metadata.
Project Steward does not store the selected mode on pending or established
session records.

If New or Resume resolves to an already live runtime, existing focus and attach
behavior wins. Project Steward does not restart, migrate, or mutate that
runtime, regardless of the current setting. Closing it and resuming the
historical session starts a new process using the setting value at that time.

Changing the setting does not trigger dashboard refresh, runtime discovery, or
process restart.

## Component Boundaries

### Extension manifest and documentation

`package.json` declares the boolean, default, machine scope, and explicit
warning text. The README configuration reference describes the option and its
new-launch-only behavior.

### Controllers

`AiSessionCreationController` and `AiSessionResumeController` receive an
injected launch-options reader. They capture a defensive directory-scope
snapshot and a single-use factory that will read the option and call the
selected provider builder.

The coordinator and both runtime backends carry that factory without invoking
it through selection, refresh, lifecycle, duplicate, conflict, availability,
fallback, lock, and tmux target-collision checks. Direct Terminal invokes it
immediately before sending the provider launch. tmux invokes it after its final
target-occupancy check and immediately before `create-session` or
`create-window`.

For pending tmux ambiguity recovery, the durable request fingerprint is
versioned and deliberately excludes process launch options. YOLO is a launch
preference, not pending-runtime identity. New records use the stable `v3`
fingerprint; recovery still accepts legacy fingerprints after all non-launch
identity, request, marker, and locator fields match, without rebuilding or
redispatching the provider command.

### Provider definitions and command builders

Provider New and Resume builder signatures accept the explicit launch options.
Provider definitions forward the value without reading VS Code configuration.
Command builders remain pure and own provider-specific argument construction.

This avoids hidden configuration dependencies and prevents the generic runtime
backends from acquiring provider-specific branching.

## Error Handling and Safety

- Missing or malformed configuration is treated as `false`.
- The final provider-argument boundary also requires
  `options?.yolo === true`; truthy malformed values such as `"true"` cannot add
  a bypass flag.
- Existing workspace trust, provider availability, directory capability, and
  runtime-conflict checks remain unchanged and run before process creation.
- YOLO mode does not weaken Project Steward's own launch validation, command
  serialization, tmux metadata checks, or workspace-scope enforcement.
- Provider rejection of an unsupported argument follows the existing failed
  launch behavior; Project Steward does not silently retry without YOLO because
  that would violate the configured launch intent.
- No additional prompt is shown when YOLO mode is enabled. The manifest and
  README carry the persistent warning.

## Testing

Automated checks cover:

- manifest type, `false` default, machine scope, and warning text;
- safe fallback for missing, false, and malformed configuration values;
- direct `projectSteward` namespace reads and proof that legacy
  `dashboard.*` values cannot enable YOLO;
- New and Resume launch specifications for Codex, Kimi, and Claude with YOLO
  disabled and enabled;
- unchanged non-YOLO argument order and exact provider-specific YOLO arguments;
- zero option reads and builder calls on every no-dispatch controller and
  coordinator result, and exactly one of each on direct and tmux dispatch;
- setting changes made while a tmux fallback choice is pending;
- launch-option-independent pending ambiguity fingerprints plus legacy
  recovery compatibility;
- malformed truthy values rejected at the final flag boundary;
- Direct Terminal, tmux, POSIX, PowerShell, and Windows current-shell
  serialization regressions;
- no restart or mode mutation when an existing runtime is focused or attached;
- existing workspace scope, provider contract, runtime safety, and compilation
  checks.

## Non-goals

- A per-launch mode picker.
- Remembering mode per provider, project, session, or workspace.
- Displaying YOLO mode on session rows or runtime badges.
- Changing a live runtime's approval or sandbox policy.
- Adding intermediate permission presets beyond provider default and YOLO.

## Acceptance Criteria

- `projectSteward.aiSessionYoloMode` exists as a machine-scoped boolean and
  defaults to `false`.
- With the setting disabled, all New and Resume commands retain their existing
  behavior.
- With the setting enabled, newly created and newly resumed Codex, Kimi, and
  Claude processes receive the correct provider YOLO argument in Direct
  Terminal and tmux modes.
- Toggling the setting affects the next process launch without a VS Code reload
  and does not alter already live runtimes.
- Focus, block, conflict, cancel, settings, duplicate, unavailable, and target
  collision paths do not read launch configuration or build a provider launch
  specification.
- The main checkout and its existing user changes remain untouched; all work
  occurs on `feat/ai-session-yolo-mode` in the isolated worktree.
