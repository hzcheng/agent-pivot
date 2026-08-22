# Machine Agent v1: Reliable Background Attention Delivery

> Status: draft for product and technical review
> Date: 2026-08-22
> Parent direction: [`Agent Pivot Platform Vision`](../../product/agent-pivot-platform-vision.md)

## Document Relationship

This specification defines the next deliverable, not the entire Machine Agent
platform. It supersedes the unimplemented background-daemon design in
[`2026-07-31-ai-session-stop-notification-design.md`](2026-07-31-ai-session-stop-notification-design.md).
The shipped in-process notification behavior and its historical implementation
plan remain valid descriptions of the current product.

An implementation plan and PR checklist should be written only after this
specification is approved and its process-lifetime spike is resolved.

## Summary

Agent Pivot will add an independently running `agent-pivot-agent` process on
the machine that hosts an AI session. Its first capability is to observe
registered tmux-backed Codex, Claude, and Kimi sessions, persist attention
events and delivery work, and send configured notifications after VS Code or
the user's laptop disconnects.

The release is intentionally narrower than a web platform:

- VS Code remains the configuration and diagnostics client.
- Notification services such as ntfy, Feishu, or Telegram remain the external
  delivery surface.
- There is no hosted Control Plane, web dashboard, mobile command channel, or
  workflow engine in v1.
- The process and protocols use the future Machine Agent boundary so those
  capabilities can be added without replacing a notification-only daemon.

## Problem

The current notification pipeline is owned by the Extension Host:

```text
provider transcript
  → Extension Host lifecycle evaluation
  → Attention event
  → in-memory NotifyDispatcher
  → webhook
```

The Attention UI Bridge is a local UI extension. It cannot run while the
laptop UI host is suspended. The in-process notification dispatcher also
stops when the relevant Extension Host exits. A remote tmux session can
therefore continue and finish while no process remains to observe or deliver
its attention event.

The current dispatcher has an additional reliability gap: its debounce queue
is memory-only, and it records an event in the notified store before transport
success. A wake-up race in which the Extension Host resumes before Wi-Fi or a
proxy can cause a failed send to be treated as permanently delivered.

The product currently exposes an enabled notification setting without being
able to state whether delivery remains available after VS Code disconnects.

## Product Promise

When background mode reports `Protected`, Agent Pivot makes this promise:

> If a registered tmux-backed session and its session host remain running,
> Agent Pivot will durably observe a supported Attention event and retain each
> configured delivery until it succeeds, is acknowledged before sending,
> expires under visible policy, or is blocked by a visible configuration
> error—even when VS Code and the user's laptop are disconnected.

The promise is conditional on the session host remaining awake and able to
reach the destination eventually. It does not claim that an asleep local
laptop continues computing or sending.

Transport-level exactly-once delivery is not promised. An HTTP request may be
accepted by a destination and then time out before the Agent sees the response.
Retrying that ambiguous request can duplicate a notification on services that
do not support idempotency keys. Agent Pivot guarantees stable event identity,
no duplicate local scheduling, and success-after-ack persistence; it reports
the remaining transport limitation honestly.

## Primary User Journey

```text
1. User enables Background notification mode on a Remote SSH host.
2. Agent Pivot installs or activates the Machine Agent on that host.
3. User starts a Codex, Claude, or Kimi task in managed tmux.
4. VS Code registers the session with the Machine Agent.
5. User closes the laptop; SSH and the remote Extension Host disappear.
6. The provider completes or requires input on the remote host.
7. The Machine Agent derives one Attention event and stores delivery work.
8. The configured notification arrives on the user's phone or IM client.
9. The user reopens VS Code; the same event appears as Attention, not a second
   event, and no second successful delivery is scheduled.
```

## Goals

1. Keep background observation and delivery alive after VS Code and SSH
   disconnect from an awake session host.
2. Reuse the same provider lifecycle semantics and event identity as the
   existing Attention pipeline.
3. Persist events and per-sink delivery state before asynchronous delivery.
4. Retry recoverable failures across network interruption and Agent restart.
5. Make the effective notification guarantee and degradation reason visible.
6. Preserve the current foreground mode for users who do not opt in.
7. Establish an independently runnable, zero-`vscode` Machine Agent package
   suitable for future Control Plane synchronization.
8. Preserve the current metadata-only notification privacy contract.

## Non-Goals

- A hosted Control Plane or user account system.
- A Web dashboard or native mobile application.
- Mobile replies, terminal input, or remote task control.
- Workflow orchestration.
- Keeping local work running while the local operating system sleeps.
- Installing or configuring tmux.
- Monitoring unmanaged arbitrary processes.
- Uploading source code, prompts, responses, or complete transcripts.
- Guaranteed exactly-once delivery by third-party notification services.
- Making background mode the default before its environment matrix is proven.

## Supported Environments

The proposed v1 release gate is intentionally narrow:

| Session environment | Runtime | v1 behavior |
| --- | --- | --- |
| Linux Remote SSH host | Managed tmux | Required `Protected` support |
| Linux Dev Container whose host/container remains running | Managed tmux | Supported after the same survival tests pass |
| macOS local host | Managed tmux | Agent may run; laptop sleep pauses task and Agent, then wake-up reconciliation applies |
| WSL | Managed tmux | Preview until shutdown and process-lifetime behavior is proven |
| Native Windows | Direct terminal | Foreground mode only in v1 |
| Any host | Direct terminal | Foreground mode; the runtime normally ends with its VS Code terminal |

The UI derives a capability result from the actual runtime and Agent health.
It must not label an unsupported or unproven combination as protected.

## Product Modes

Replace the implicit boolean guarantee with an explicit mode:

| Mode | Sender | User-visible guarantee |
| --- | --- | --- |
| `foreground` | VS Code Extension Host | Notifications only while the responsible Extension Host is running |
| `sessionHost` | Machine Agent | Registered supported sessions remain observed after VS Code disconnects |

`foreground` remains the default. Enabling `sessionHost` is explicit and
machine-scoped because installation, credentials, connectivity, and runtime
capabilities differ by local or remote host.

The existing `agentPivot.notify.enabled` consent remains the master outbound
network switch. A future implementation plan will decide whether mode is a new
setting or a migration from a proposed daemon setting; the product behavior
must not infer background protection from `enabled` alone.

## Architecture

```text
Session host
┌───────────────────────────────────────────────────────────────────┐
│ Provider + managed tmux runtime                                   │
│        │ writes provider-owned lifecycle data                     │
│        ▼                                                          │
│ agent-pivot-agent                                                 │
│   Session Registry → Provider Observer → Attention Reconciler     │
│                                             │                     │
│                                             ▼                     │
│                                    Durable Event Store            │
│                                             │                     │
│                                             ▼                     │
│                                      Delivery Outbox              │
│                                      ├─ sink A state              │
│                                      └─ sink B state              │
│                                             │                     │
│                                             ▼                     │
│                                  Notification Transports          │
│                                             │                     │
│                                             └── outbound HTTPS ───┼──►
│                                                                   │
│ VS Code Extension Host, when present                              │
│   · installs/configures Agent                                     │
│   · registers and retires sessions                                │
│   · acknowledges Attention                                        │
│   · shows capability, health, backlog, and diagnostics            │
└───────────────────────────────────────────────────────────────────┘
```

When `sessionHost` mode is healthy, the Machine Agent is the only notification
sender for sessions it owns. The Extension Host continues to render Attention
but does not send the same event. A degraded Agent must not silently enable a
second sender and create races; fallback to foreground sending requires an
explicit, visible mode transition with shared event reconciliation.

## Package And Repository Boundary

V1 is implemented in this repository but as an independent product artifact.
The target structure is conceptually:

```text
packages/
  runtime-core/       provider lifecycle and Attention identity, no vscode
  machine-agent/      executable, registry, reconciliation, outbox, health
  protocol/           versioned records and capability contracts
src/                  VS Code Extension and integration adapters
```

The implementation plan may introduce these directories incrementally rather
than perform a broad repository migration first. The enforced dependency
invariant is more important than the initial directory names:

```text
machine-agent ✕ vscode
runtime-core  ✕ vscode
```

`agent-pivot-agent` has its own entry point, version, tests, build target,
logs, and lifecycle commands. It is not an Extension Host worker thread or a
child whose correctness depends on the parent remaining alive.

## Responsibilities

### Machine Agent owns

- single-instance enforcement on one session host;
- versioned session registration ingestion;
- provider lifecycle observation and checkpointing;
- runtime and transcript reconciliation after restart;
- Attention event identity and durable event retention;
- per-sink delivery state, retry, expiry, and diagnostics;
- Agent health, capability, and version reporting;
- local metadata redaction before transport;
- safe retirement of sessions no longer alive.

### VS Code Extension owns

- informed consent and user-facing settings;
- Agent installation, upgrade request, and uninstall entry points;
- registering managed sessions with the Agent;
- writing or brokering credentials through an approved local contract;
- displaying Agent mode, location, heartbeat, version, and delivery health;
- publishing the same Attention state in the current UI;
- forwarding acknowledgement to the Agent when available;
- foreground delivery when explicitly configured in foreground mode.

### Provider adapters own

- locating provider-owned session data;
- parsing lifecycle signals with stable tokens;
- mapping provider facts to provider-neutral Attention reasons;
- exposing enough checkpoints to resume tailing after process restart;
- remaining testable without VS Code or live provider processes.

## Session Registration Contract

V1 needs a versioned registration record per managed session. The exact IPC
encoding is an implementation decision, but the semantic record includes:

```jsonc
{
  "schemaVersion": 1,
  "machineId": "local-stable-machine-id",
  "sessionKey": "codex:provider-session-id",
  "providerId": "codex",
  "providerSessionId": "provider-session-id",
  "workspaceId": "host-local-workspace-id",
  "runtime": {
    "backend": "tmux",
    "locator": { "layout": "project", "sessionName": "...", "windowName": "..." }
  },
  "lifecycleSource": { "kind": "provider-jsonl", "path": "..." },
  "runStartedAtMs": 0,
  "labels": { "project": "vscode-dashboard", "session": "review notifications" },
  "registrationOwnerId": "vscode-extension-instance-id",
  "registeredAtMs": 0,
  "registrationRevision": 1
}
```

Paths and tmux locators are host-private and never included in outbound
notifications or future synchronization by default. Registration updates are
atomic and monotonic. A stale VS Code window cannot overwrite a newer revision
or retire a live registration it does not own.

V1 may use validated atomic files for local communication. The schema must be
transport-neutral so a later local socket or Control Plane sync does not
change the domain model.

The Machine Agent, not an arbitrary file writer, is the revision authority. If
the selected v1 transport uses files, it must provide request/acknowledgement
semantics or an equivalent single-writer protocol rather than allowing several
VS Code windows to replace one shared snapshot concurrently.

## Attention Identity And Reconciliation

The Extension and Agent must derive the same stable `eventId` from the same
provider lifecycle signal. The algorithm is versioned. A component that does
not support the required identity version reports incompatibility and stops
sending; it must not invent a replacement event that could duplicate delivery.

The existing `eventId` remains host-local for compatibility with current
Attention acknowledgement. Any future cross-machine protocol identifies an
event by the composite `(machineId, eventId)` unless a separately versioned
global identity migration is approved.

On start, restart, registration update, transcript rotation, and reconnect,
the Agent reconciles from a persisted read checkpoint plus a bounded provider
history window. It never assumes that a missed file-watch callback means no
event occurred. File watching is an optimization; periodic reconciliation is
the correctness fallback.

The Agent records the event before creating delivery work. Event retention and
delivery retention are separate so an event can remain visible after every
sink has finished or expired.

## Trigger Semantics

V1 changes where lifecycle evaluation runs, not what provider output means.
It uses the current provider adapters and reasons:

| Reason | Current source behavior | Default delivery policy |
| --- | --- | --- |
| `completed` | Produced by the normal end-of-turn/task-complete signal for Codex, Claude, and Kimi | Included; this is the most common stop event |
| `input-required` | Produced by supported structured question or approval requests | Included |
| `failed` | Currently produced only for supported Claude API-error records | Included |

Provider interruption signals that currently map to idle do not become
Attention merely because the Machine Agent exists. Adding or changing a
provider signal requires the normal adapter contract and fixture review; the
background process must not infer completion from tmux inactivity alone.

## Durable Delivery Outbox

Delivery state is per `eventId + sinkId`, not one global notified bit.

```text
pending
  → debounce
  → sending
      → delivered
      → retry-wait → pending
      → blocked
  → cancelled
  → expired
```

Required semantics:

1. Persist `pending` before scheduling debounce or network work.
2. Mark `delivered` only after the transport returns an accepted success
   response.
3. Persist an attempt number, timestamps, redacted result, and next retry time.
4. Retry network errors, timeouts, HTTP 408, HTTP 429, and HTTP 5xx with bounded
   exponential backoff and jitter; honor `Retry-After` where supported.
5. Treat other HTTP 4xx responses as `blocked` configuration or authorization
   failures and surface them in health diagnostics.
6. Resume `pending`, `retry-wait`, and orphaned `sending` records after Agent
   restart. An orphaned send is an ambiguous outcome and may be retried under
   the documented at-least-once transport limitation.
7. Never silently drop the oldest item because an in-memory queue is full.
   Backpressure and storage limits create a visible degraded state.
8. Keep sink outcomes independent. One successful sink never suppresses retry
   for another sink.
9. Use the stable event ID as an idempotency key when a transport supports it.
10. Retain enough completed state to prevent replay during the configured
    deduplication window.

The storage engine is chosen during implementation planning after a focused
crash-consistency evaluation. Whether it is an atomic local record store or an
embedded database, tests must prove the state-machine semantics above. Storage
format convenience must not weaken them.

## Acknowledgement, Cancellation, And Freshness

Acknowledgement and delivery are related but distinct:

- acknowledgement removes Attention from the user's actionable queue;
- if a delivery is still pending or in debounce, acknowledgement cancels it;
- an in-flight or already delivered external message cannot be retracted;
- acknowledging one event does not acknowledge a later run in the same
  session;
- acknowledgement is durable and uses the same versioned event ID.

After a long offline period, the Agent should not flood a user with stale
events. V1 proposes a default 24-hour delivery freshness window:

- fresh unacknowledged events resume delivery;
- expired events remain diagnosable but are not sent;
- multiple fresh events released together may be summarized under the existing
  rate-limit policy without losing their individual event identities.

The default and configurability require product review before implementation.

## Process Lifetime And Supervision

Process survival is the highest-risk technical assumption and must be proven
before the implementation plan is approved.

The spike must run on a real Remote SSH Linux host and answer:

1. Does a detached Node process survive VS Code Remote Server shutdown, SSH
   disconnect, and terminal teardown in the supported environment?
2. Which signals and process-group behavior occur during remote shutdown?
3. Is `systemd --user` available, and does the user session remain alive after
   logout without requiring an unsafe or surprising system change?
4. What explicit degraded mode is available where no service manager exists?
5. How are crash restart, version upgrade, log ownership, and uninstall
   handled without two Agents running concurrently?

The target lifecycle interface is stable regardless of the selected adapter:

```text
agent-pivot-agent start
agent-pivot-agent stop
agent-pivot-agent status
agent-pivot-agent doctor
agent-pivot-agent version
```

Preferred supervision order for the spike is:

1. platform service manager when it can be installed with informed consent;
2. proven detached-process mode with explicit limitations;
3. foreground notification fallback when background survival cannot be
   established.

The product must never call a mode `Protected` solely because a PID exists.
Health requires a current heartbeat, compatible protocol version, successful
registry access, usable credential state, and a proven process-lifetime mode.

## Installation And Upgrade

The VS Code extension may bootstrap the Agent, but the Agent artifact is
independently runnable and versioned. Installation must be atomic:

- stage a versioned artifact;
- verify its version and integrity;
- request the old Agent to quiesce after persisting checkpoints;
- acquire the single-instance lock;
- start the new version;
- verify heartbeat and protocol compatibility;
- retain a diagnosable rollback path if activation fails.

An extension update must not overwrite the executable of a running process in
place. Multiple VS Code windows coordinate through the Agent lock and protocol
rather than racing to install or restart it.

Uninstall must remove service-manager registration when present, stop the
Agent, and explain which retained diagnostic or delivery files will be
deleted. Extension uninstall hooks are not guaranteed, so the Agent also needs
a bounded idle-retirement policy and a documented manual cleanup command.

## Credentials And Privacy

Background delivery cannot depend on VS Code SecretStorage being readable
after the Extension Host exits. V1 therefore needs a deliberate host-local
credential handoff.

Required behavior:

- SecretStorage remains the VS Code-side source during configuration.
- The Agent receives only credentials for enabled sinks on that machine.
- Host-local credential material is never written to `settings.json`, Settings
  Sync, logs, notifications, or future Control Plane projections.
- If platform keychain integration is unavailable, an owner-only file is an
  explicit documented compromise, written atomically with restrictive
  permissions and redacted diagnostics.
- Credential removal invalidates pending work for that sink visibly rather
  than reporting successful delivery.
- Notification payloads keep the current metadata-only default: provider,
  reason, duration, hostname, basename project label, optional session label,
  and correlation ID.

Enabling background mode requires informed consent that identifies the machine
on which the Agent and credentials will reside.

## Health And Product Experience

Settings and commands should expose one effective state:

| State | Meaning |
| --- | --- |
| `Protected` | Agent is healthy and the current supported runtime remains observed after disconnect |
| `Foreground only` | Extension can send, but closing it removes the sender |
| `Recovering` | Agent is reconciling persisted state or retrying delivery |
| `Blocked` | Configuration, credentials, protocol, storage, or supervision prevents the promise |
| `Unsupported` | The current runtime or host cannot provide background observation |

The status surface includes:

- sending machine and hostname;
- Agent version and protocol version;
- supervision type and last heartbeat;
- number of registered live sessions;
- pending, retrying, blocked, and expired delivery counts;
- last successful and failed delivery time with a redacted destination;
- current guarantee in plain language;
- `Send Test Notification`, `Doctor`, `Restart`, and `Open Logs` actions.

Examples:

```text
Background notifications: Protected
Sender: dev-server-03 · Linux user service
3 sessions watched · heartbeat 8 seconds ago · no pending deliveries
```

```text
Background notifications: Foreground only
The Machine Agent is not running. Closing VS Code will stop notifications.
```

For a local laptop that can sleep:

```text
Background notifications pause while this computer sleeps. Local tasks also
pause and will be reconciled after wake.
```

## Diagnostics And Metrics

The Agent keeps bounded, rotating, redacted local logs and a structured health
snapshot readable by VS Code. Every event and delivery attempt uses the short
correlation ID already present in notification messages.

Diagnostics distinguish:

- event not observed;
- event observed but policy-filtered;
- waiting in debounce;
- waiting for network retry;
- blocked by credentials or HTTP response;
- delivered with acknowledged response;
- expired under freshness policy;
- Agent or protocol unhealthy.

No failure silently downgrades a protected session. Optional future telemetry
must be separately consented and contain no project path, session label,
provider transcript, URL credentials, or message body.

## Failure Behavior

| Failure | Required result |
| --- | --- |
| Extension exits | Healthy Agent continues observing registered supported sessions |
| SSH disconnects | Healthy Agent and tmux session continue on the remote host |
| Agent restarts | Checkpoints and unfinished deliveries reconcile from durable state |
| File-watch event is missed | Periodic reconciliation finds the lifecycle transition |
| Network is unavailable | Delivery remains retryable and visible; it is not marked delivered |
| One sink succeeds, one fails | Successful sink remains delivered; failed sink retries independently |
| Credentials are invalid | Sink becomes blocked with a visible remediation path |
| Protocol versions conflict | Background sending stops visibly rather than risking duplicate identity |
| Storage cannot persist | Agent enters blocked state before claiming the event is protected |
| Host sleeps or powers off | No real-time guarantee; recovery begins after the host resumes |
| Runtime disappears | Agent performs a final bounded reconciliation, then retires registration |
| Agent cannot be supervised | UI reports foreground-only or unsupported; no silent protected claim |

## Verification And Release Gates

Deterministic tests cover:

- provider lifecycle fixtures produce byte-identical event identity in the
  Extension and Agent paths;
- registration revisions reject stale writers;
- crash points around every Outbox transition recover safely;
- transport success is recorded only after accepted response;
- retryable and blocked HTTP classifications;
- per-sink independence, acknowledgement races, freshness, and summarization;
- Agent single-instance, protocol mismatch, upgrade, and graceful shutdown;
- logs and status snapshots contain no configured credentials or full paths.

Real-environment acceptance is required for release. At minimum:

1. Start a managed tmux provider task on a Remote SSH Linux host, close VS
   Code, disconnect SSH, complete the task, and receive the notification.
2. Repeat while the laptop is closed long enough for the remote VS Code Server
   to shut down.
3. Make the destination unreachable before completion, restore connectivity,
   and verify the pending item delivers without being lost.
4. Stop the Agent after the event is persisted, restart it through the
   supported supervisor, and verify delivery resumes.
5. Attach two VS Code windows to the same managed runtime and verify one local
   event identity and no duplicate local scheduling.
6. Reopen VS Code after delivery and verify the same Attention event appears
   without a new delivery.
7. Acknowledge during debounce and verify pending delivery is cancelled.
8. Force invalid credentials and verify the UI reports `Blocked`, not
   `Protected` or delivered.

The completed environment, timestamps, process tree, Agent log, redacted
delivery evidence, and phone/IM evidence are retained in the manual-test
record. Existing sleep/disconnect manual coverage must be extended rather than
treated as a deterministic CI substitute.

## Rollout

1. Ship the Machine Agent package and diagnostics behind an internal or
   experimental setting; do not send notifications through it yet.
2. Complete the real process-lifetime spike and publish the supported matrix.
3. Enable background delivery for explicit test users with dual-send
   prohibited by configuration and assertions.
4. Measure local health and collect manual evidence for disconnect, retry, and
   upgrade scenarios.
5. Offer `sessionHost` mode as opt-in only after all release gates pass.
6. Keep foreground mode available as a visible fallback and rollback path.

## Implementation Slices After Approval

The later implementation plan should produce small, serial, independently
reviewable PRs from one feature branch:

1. Process-lifetime spike report and final supervision decision.
2. Shared protocol and event-identity boundaries with no behavior change.
3. Independently runnable Agent skeleton, lock, health, and diagnostics.
4. Versioned Session Registry and provider observation reconciliation.
5. Durable per-sink Outbox and failure recovery.
6. Extension installation, credential handoff, mode, and status integration.
7. Real-environment acceptance records, documentation, and opt-in rollout.

No PR should claim background reliability before the Outbox, health state, and
real disconnect acceptance path are all present.

## Decisions Required Before Implementation Planning

1. Approve Linux Remote SSH + managed tmux as the required v1 protected
   environment.
2. Approve `agent-pivot-agent` as the product/process boundary while keeping it
   in this repository for v1.
3. Select the supervision strategy from the process-lifetime spike evidence.
4. Select the crash-consistent local storage implementation without changing
   the Outbox semantics.
5. Confirm the proposed 24-hour delivery freshness default.
6. Decide whether Agent installation is bundled with the extension artifact or
   downloaded from a separately signed release artifact.
7. Confirm which notification channels are release-gating; existing channels
   may remain supported without all becoming background-mode gates.

These decisions are intentionally explicit. They prevent the first delivery
feature from accidentally defining an unsafe or incompatible long-term Machine
Agent platform.
