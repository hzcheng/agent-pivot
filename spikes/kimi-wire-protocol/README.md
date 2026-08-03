# Kimi Wire Protocol Spike (R4.1)

**Conclusion: hosted mode is feasible for Kimi.** `kimi --wire` is a complete
JSON-RPC 2.0 server over stdio, covering every capability the hosted
conversation runtime needs. Verified against kimi-cli 1.49.0 on 2026-08-02.

## How to run the probes

```bash
node spikes/kimi-wire-protocol/probe.js         # initialize → prompt → token stream
node spikes/kimi-wire-protocol/resume-probe.js <sessionId>  # resume + full history replay
```

`probe.js` runs a real (tiny) model turn and costs a few hundred tokens.

## Protocol surface (from kimi_cli/wire/jsonrpc.py + live verification)

Client → server methods:

| Method | Params | Purpose |
|---|---|---|
| `initialize` | `{protocol_version, client, capabilities?, external_tools?, hooks?}` | Handshake. Returns server name/version and the session's slash commands |
| `prompt` | `{user_input: string \| ContentPart[]}` | Start a turn |
| `steer` | `{user_input}` | Inject user input mid-turn |
| `cancel` | – | Interrupt the running turn |
| `replay` | – | Replay the resumed session's recorded events |
| `set_plan_mode` | `{enabled}` | Toggle plan mode |

Server → client:

- `event` notifications: `TurnBegin`, `StepBegin`, `ContentPart`
  (token-level `text`/`think` deltas), `ToolCall`, `ToolCallPart`,
  `ToolResult`, `StatusUpdate` (context tokens), `TurnEnd`,
  `Notification`, …
- `request` (expects a client response): `ApprovalRequest`,
  `QuestionRequest`, `ToolCallRequest`, `HookRequest` — this is the
  inline-approval channel.

## Verified behavior

1. **Handshake**: `initialize` → `{protocol_version: "1.10", server: {name:
   "Kimi Code CLI", version: "1.49.0"}, slash_commands: [...]}`.
2. **Live turn**: `prompt` → `TurnBegin → StepBegin → ContentPart(think)×N →
   ContentPart(text) → StatusUpdate → TurnEnd`, then the prompt response
   `{"status":"finished"}`. Thinking and text stream token-by-token.
3. **Resume + replay**: `kimi --wire --resume <sessionId> --work-dir
   <original cwd>` then `replay` streams the entire recorded wire.jsonl back
   as structured events (verified on an 8.4 MB session: TurnBegin / ToolCall /
   ToolResult / StatusUpdate / … in order). The work-dir must match the
   session's original directory (its storage is keyed by work-dir hash);
   a mismatch silently starts a fresh empty session.

## Implications for hosted mode (R4.x)

- New turns, streaming, telemetry (`StatusUpdate.context_tokens`), inline
  approvals (`ApprovalRequest` via server `request`), mid-turn steering and
  cancel are all protocol-native. No log inference needed.
- History for resumed sessions comes from `replay` as the same event shapes —
  the conversation viewer can reuse one event-to-blocks pipeline for live and
  replayed content.
- Slash commands are discoverable from `initialize`.

## Risks / open questions

- `--wire` is flagged **experimental**; pin and contract-test against a
  minimum kimi-cli version (this spike: 1.49.0, protocol 1.10).
- `ApprovalRequest`/`QuestionRequest` flows were mapped from source
  (`wire/types.py`) but not exercised live in this spike.
- Hosted processes die with the extension host; sessions persist on disk and
  resume cleanly, but tmux remains the right backend for unattended runs.
