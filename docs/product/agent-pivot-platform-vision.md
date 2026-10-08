# Agent Pivot Platform Vision

> Status: product direction draft
> Date: 2026-08-22
> Horizon: long-term product direction, not an implementation commitment

## Purpose Of This Document

Agent Pivot today is a VS Code command surface for switching, monitoring, and
resuming Codex, Claude, and Kimi sessions. This document describes the larger
product that the current extension can grow into without making VS Code, one
AI provider, or one machine the permanent system boundary.

The document is intentionally stable and directional. It defines the product
thesis, boundaries, shared domain model, trust model, and capability sequence.
Individual releases must have narrower design specifications that state what
is actually committed. The first such slice is
[`Machine Agent v1: Reliable Background Attention Delivery`](../superpowers/specs/2026-08-22-machine-agent-v1-background-attention-design.md).

## Product Thesis

AI coding work is moving from one foreground chat to many concurrent tasks:

- multiple providers work on different parts of one project;
- tasks continue in tmux or on remote development machines after the visible
  terminal disconnects;
- users move between workspaces, machines, IDE windows, and mobile devices;
- some tasks can proceed autonomously while others need a review, decision, or
  approval;
- the useful unit is no longer a chat tab, but a task with runtime state,
  history, artifacts, and human checkpoints.

Agent Pivot should become the local-first control layer for that work:

> **Observe, resume, review, and orchestrate AI tasks across providers,
> machines, and clients without losing user control or project context.**

VS Code remains an important client and execution entry point. It is not the
long-term owner of task state, background observation, or delivery guarantees.

## User Outcomes

The platform direction is successful when a user can:

1. See which tasks are running, waiting, completed, or failed across their
   machines.
2. Leave VS Code or close a laptop while a task continues on an awake remote
   host, and still receive a reliable attention notification.
3. Open VS Code, a web dashboard, or a mobile client and see the same task
   identity and current state.
4. Review a bounded result or request, acknowledge it, and return to the exact
   project and session that produced it.
5. Allow providers to participate in a governed workflow, such as Kimi
   proposing and implementing while Codex reviews, with explicit loop limits
   and human approval gates.
6. Understand what data leaves each machine and revoke a machine or client
   without affecting provider-owned source and transcript storage.

## Product Principles

### IDE-independent, not IDE-absent

VS Code should remain a first-class experience, but platform behavior must not
depend on an Extension Host staying alive. The same machine and task model must
be consumable by future web, mobile, CLI, and API clients.

### Provider-neutral, with provider-specific adapters

The shared product model describes sessions, runs, lifecycle signals,
attention, and artifacts. Provider adapters translate Codex, Claude, Kimi, and
future provider data into that model. Provider-specific facts must not leak
into every client or workflow definition.

### Session-host authority

The machine on which a provider session runs is authoritative for observing
that session. It owns the provider-local transcript access, runtime liveness,
and unsynchronized event outbox. Remote clients receive projections and submit
bounded commands; they do not infer lifecycle from stale UI state.

### Local-first and metadata-minimal

Code, complete transcripts, prompts, and responses remain on the session host
by default. Cross-machine sync begins with metadata: identity, lifecycle,
attention reason, timestamps, health, and explicitly approved summaries or
artifacts. Additional content requires a visible product choice and a narrower
authorization scope.

### Event-driven and recoverable

Important state transitions are durable events, not transient callbacks.
Disconnects, process restarts, and temporary network failures must not erase an
attention event or remote command. Components reconcile from persisted state
after recovery.

### Progressive trust

The platform should expand in this order:

1. observe;
2. notify;
3. acknowledge;
4. execute a small set of structured remote actions;
5. automate multi-step workflows under explicit policy.

Arbitrary remote shell execution is not a baseline platform capability.

### Human authority remains explicit

Automation may advance through pre-approved low-risk states. Scope expansion,
high-risk mutations, exhausted review loops, and ambiguous outcomes stop at a
human gate. Every remote action and automated transition is attributable and
auditable.

### Capability is reported, not assumed

A local sleeping laptop, an awake remote host, a tmux runtime, and a direct
terminal have different guarantees. Clients must show the effective capability
and degradation reason instead of presenting one misleading `enabled` flag.

## Target Platform Shape

```text
Session host A                         Session host B
┌─────────────────────┐               ┌─────────────────────┐
│ Provider runtimes   │               │ Provider runtimes   │
│ Machine Agent       │               │ Machine Agent       │
│ Durable local state │               │ Durable local state │
└──────────┬──────────┘               └──────────┬──────────┘
           │ outbound authenticated connections │
           └────────────────┬────────────────────┘
                            ▼
                  ┌─────────────────────┐
                  │ Control Plane       │
                  │ Identity and policy │
                  │ State projections   │
                  │ Command routing     │
                  │ Audit and delivery  │
                  └──────┬──────┬───────┘
                         │      │
                   ┌─────▼──┐ ┌─▼────────┐
                   │ Web/PWA│ │ VS Code  │
                   └────────┘ └──────────┘
```

The Control Plane is a future component, not a dependency of the first
Machine Agent release. Until it exists, the Machine Agent can deliver directly
to user-configured notification services.

## External Architecture Patterns

The platform shape follows recurring patterns in mature machine-agent systems;
it does not require Agent Pivot to copy their product scope.

| Product pattern | Relevant evidence | Lesson for Agent Pivot |
| --- | --- | --- |
| GitHub Actions self-hosted runners | A runner process on the execution machine connects outward over HTTPS, receives work, reports status, and can be installed as a service. See [GitHub's self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners) and [service management guidance](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners). | Put the durable execution-side process on the session host, use outbound connectivity, and treat service installation, health, and upgrades as product behavior. |
| Elastic Agent and Fleet | Fleet centrally manages enrollment, versions, policies, status, and logs while also supporting a standalone Agent mode. See [Elastic Fleet management](https://www.elastic.co/guide/en/fleet/current/manage-agents-in-fleet.html/). | Keep a useful standalone Machine Agent now, then add optional central management without replacing the host process. |
| OpenTelemetry Collector | The Collector explicitly supports agent and gateway deployment patterns that can be combined. See [Collector deployment patterns](https://opentelemetry.io/docs/collector/deploy/) and the [gateway pattern](https://opentelemetry.io/docs/collector/deploy/gateway/). | Separate host-local collection and buffering from future central routing and aggregation. Do not make the gateway authoritative for facts only the host can observe. |
| HashiCorp Boundary | Boundary separates controllers, workers, and clients; workers report health and last-seen state, and outbound-only network policies are supported. See [Boundary workers](https://developer.hashicorp.com/boundary/docs/concepts/workers) and [worker TLS connections](https://developer.hashicorp.com/boundary/docs/secure/encryption/connections-tls). | Model Machine Agent identity, capability, heartbeat, and revocation separately from user clients, and avoid requiring public inbound access to development hosts. |

These precedents support four decisions in this vision: a separately managed
host process, outbound authenticated connectivity, explicit health and version
reporting, and an optional control plane layered above a still-useful local
agent. They do not justify importing CI job execution, telemetry collection,
or network proxying into Agent Pivot's product scope.

## Platform Components

### Machine Agent

The Machine Agent is an independently running process on each session host.
It is the long-term foundation for capabilities that must survive an IDE
disconnect.

Its bounded responsibilities are:

- discover or receive registrations for supported sessions;
- observe provider lifecycle data through versioned adapters;
- reconcile runtime liveness and lifecycle signals;
- persist attention events and per-destination delivery work;
- report its own health and supported capabilities;
- synchronize projections to a future Control Plane;
- validate and execute explicitly supported commands;
- keep a local audit trail without storing complete conversation content by
  default.

Notification is its first capability, not its permanent product identity. The
executable and package should therefore use `agent-pivot-agent`, rather than
making `notifyd` the public architectural boundary.

### VS Code Extension

The extension remains the richest local project client. It launches and
resumes sessions, renders project context, opens transcripts, and offers Agent
installation, configuration, health, and diagnostics. It must consume shared
task projections instead of being the only owner of background task truth.

### Control Plane

The future Control Plane provides an authenticated rendezvous point for
machines and clients that cannot directly reach one another because of NAT,
corporate networks, or offline periods. Machine Agents initiate outbound
connections; machines do not expose public listener ports.

The Control Plane owns:

- user, organization, device, and client identity;
- latest synchronized projections and bounded history;
- capability-aware command routing;
- authorization policy and audit records;
- push notification fan-out when configured;
- device revocation and protocol compatibility policy.

It does not become the default store for complete provider transcripts or
source repositories.

### Web, Mobile, CLI, And API Clients

Clients consume one versioned platform API and render capabilities appropriate
to their surface. A mobile client may first show status and acknowledge an
attention event; it does not need to reproduce a terminal or accept arbitrary
commands. Web can later provide cross-machine task views and workflow
administration. VS Code can continue to provide code-local navigation.

### Workflow Engine

The workflow engine coordinates typed steps, artifacts, reviews, policies, and
human gates. It is a consumer of the shared task and command model, not logic
embedded in one provider transcript or one webview.

A future review loop may express:

```text
Kimi propose
  → Codex review
  → Kimi revise while Critical or Important findings remain
  → human gate after the configured loop limit
  → Kimi implement when approved
  → Codex review implementation until no Critical findings remain
```

The engine must persist the state and evidence of each transition. A provider
being idle means it is available for a new command; it is not itself a durable
workflow scheduler.

A `Task` is the user's durable objective, not a synonym for one provider
session or one workflow. A task may begin as an unstructured session, use one
workflow to produce a plan, use another workflow to implement it, and retain
all of those runs and artifacts under one task history. Reusable workflow
definitions and their concrete workflow runs are separate identities.

## Shared Domain Model

The platform should converge on these provider-neutral identities:

| Entity | Meaning | Authority |
| --- | --- | --- |
| `Machine` | One registered execution host | Machine Agent and identity service |
| `Workspace` | A project or multi-root execution scope on a machine | Session host |
| `Task` | A durable user objective spanning sessions, runs, artifacts, and optional workflows | User or task service |
| `Session` | A stable provider conversation identity | Provider adapter |
| `Run` | One active execution interval within a session | Session host |
| `LifecycleEvent` | Provider-derived transition such as running or stopped | Session host |
| `AttentionEvent` | A durable item requiring awareness or action | Session host, synchronized outward |
| `Artifact` | A typed, explicitly retained output such as a plan or review | Producing task/workflow |
| `Command` | An authenticated, idempotent request for a supported action | Issuing client plus executing Agent |
| `WorkflowDefinition` | A reusable versioned graph of steps, policies, and gates | Workflow service |
| `WorkflowRun` | One execution of a workflow definition for a task | Workflow service |

Identifiers must be globally unambiguous once data crosses a machine boundary.
Events and commands carry schema versions, causal references, timestamps, and
idempotency keys. Clients must tolerate unknown optional capabilities and
reject incompatible required protocol versions visibly.

## State And Connectivity Model

The product must distinguish three layers:

1. **Authoritative local state**: provider files, runtime liveness, the local
   event log, pending deliveries, and pending commands.
2. **Synchronized projections**: bounded task metadata and health that web or
   mobile clients can query.
3. **Ephemeral presence**: whether a VS Code window, web client, or phone is
   currently connected.

Presence must never be required to retain an event. Offline clients can miss a
live update and reconcile later from the projection. A disconnected Machine
Agent remains authoritative for local sessions and uploads its ordered changes
after reconnection.

## Trust, Security, And Privacy Boundaries

The platform direction requires the following invariants:

- Machine Agents make outbound connections; no public inbound machine port is
  required.
- Every machine has an independently revocable identity.
- Credentials are encrypted or stored through platform-appropriate secret
  facilities where available; plaintext configuration and Settings Sync are
  not credential stores.
- Commands are typed, scoped, expiring, signed or authenticated, idempotent,
  and audited.
- The Agent enforces its own command allowlist even if a client or Control
  Plane is compromised.
- High-impact operations require policy and, where appropriate, a local or
  human confirmation.
- Metadata redaction is the default. Uploading code, transcript content, or a
  full filesystem path is a separate consent decision.
- Self-hosted Control Plane deployment remains a viable enterprise direction.

## Capability Sequence

The sequence describes dependency order, not release dates.

### Foundation: VS Code command surface

The current product discovers provider sessions, manages direct and tmux
runtimes, projects attention into the UI, and resumes work in context.

### Machine Agent v1: reliable background attention

Extract background observation and notification delivery from the Extension
Host. Prove a remote tmux task can complete after VS Code disconnects and still
produce one recoverable notification event.

### Machine directory and read-only Control Plane

Register Machine Agents, synchronize bounded task projections, and provide a
cross-machine web view. This phase is read-only apart from device management.

### Mobile attention handling

Add PWA or mobile views for task status, push delivery, and attention
acknowledgement. Acknowledgement synchronizes back to the authoritative host.

### Structured remote actions

Introduce a small capability-negotiated command set such as stop, continue,
choose an offered option, or approve a workflow gate. Do not expose arbitrary
terminal input as a generic remote API.

### Workflow orchestration

Add durable provider-neutral workflows, typed artifacts, bounded review loops,
and human intervention policies. Workflow execution may live in a Control
Plane or a self-hosted coordinator while provider actions execute through the
appropriate Machine Agent.

## Repository And Delivery Boundaries

The Machine Agent should initially live in this repository because it shares
provider lifecycle adapters, event identity, and release compatibility with
the VS Code extension. It must still be a separately built, tested, versioned,
and runnable package with no `vscode` dependency.

The intended dependency direction is:

```text
runtime-core  ← VS Code extension
runtime-core  ← machine-agent
protocol      ← VS Code extension
protocol      ← machine-agent

machine-agent ✕ vscode
runtime-core  ✕ vscode
```

A future hosted Control Plane belongs in a separate repository because its
deployment, secrets, persistence, security review, and release cadence differ
from desktop and machine software. The Machine Agent may be split later when
it has an independent installer, release cadence, maintainership boundary, and
stable protocol. Repository separation must follow a real product boundary,
not create one prematurely.

## Product Health Measures

Future releases should measure outcomes rather than only feature presence:

- percentage of registered running tasks whose final lifecycle state is
  observed;
- attention delivery latency and success by mode;
- pending and expired delivery counts;
- Machine Agent availability and protocol compatibility;
- duplicate or unreconciled event incidence;
- time from attention to acknowledgement;
- percentage of remote commands completed, rejected, expired, or ambiguous;
- workflow loops requiring human intervention and their resolution.

Telemetry must remain opt-in and must not contain source or transcript content.
Local diagnostics should expose the same health facts without requiring
telemetry.

## Long-Term Non-Goals

Agent Pivot is not intended to:

- provide, proxy, or resell model access;
- replace provider-owned authentication or transcript storage;
- become a general remote shell or endpoint-management product;
- promise work continues while its actual execution host is asleep or powered
  off;
- silently upload repositories or complete conversations;
- remove human accountability from high-impact development operations.

## Open Product Decisions

The following choices should be made before their dependent phase begins:

1. Whether the Control Plane is hosted, self-hosted, or offered in both forms.
2. Which task metadata and artifact types may synchronize by default.
3. Whether web/mobile are PWA-first or require native applications.
4. Which structured remote actions form the first write-capable release.
5. Where workflow coordination runs in hosted and self-hosted deployments.
6. Which organization, retention, compliance, and audit controls are required
   before team use.

These questions do not block Machine Agent v1. That release should establish
the durable local event, capability, and identity foundations without
pretending the future Control Plane already exists.
