# AI Hub redesign notes

Status: discovery proposal. This document records the current review and the
product direction before implementation work begins.

## Current review

The dashboard's top-level AI tab is an asset/configuration surface, not the
live-session surface in OPEN. It exposes PROMPTS, SKILLS, MCP, and HOOKS.
PROMPTS currently owns the complete AI-panel HTML shell and lazy-load protocol;
SKILLS is rendered into that shell and updates itself through a separate
message. This reverses ownership for a multi-feature surface and makes new
sections need to integrate through the prompt feature.

The current prompt card is too tall for its primary job: scanning and choosing
a reusable prompt. It spends persistent vertical space on a two-line preview,
a drag handle, and a hover action overlay. It also only models a flat library,
so there is no durable way to assemble several prompts for one product task.

The current Skills surface exposes its storage implementation (Global/Project
panes, source folders, agent links, duplicate copies, diagnostics, and direct
filesystem actions) at the same level. Those are legitimate advanced details,
but they compete with the primary question: which skills will each agent use
for this project?

## Product direction

### Prompt library and workflows

Keep a **Prompt** as a reusable template. Add an ordered **Workflow** (also
called a prompt bundle) as a collection of prompt references. A prompt may be
in zero or more workflows; it is never copied just because it is used in two
workflows.

This supports a feature workflow such as:

1. Plan the feature
2. Implement the change
3. Review and prepare the PR

The Prompts page lives in a narrow VS Code sidebar, so it must not use a
two-column workflow rail and template list. Use a single-column drill-in
instead: the landing page lists Workflows and the Prompt library; selecting a
workflow replaces that list with a back affordance and its ordered prompt rows.
A row is one line for the name, one quiet line for the purpose, and an overflow
menu. The full text and edit form open only on selection. Within a workflow,
rows show a small step number. The default prompt remains an independent
property, not an implicit first workflow step.

Initial data model:

```ts
interface PromptWorkflowV1 {
    id: string;
    name: string;
    description?: string;
    promptIds: string[]; // ordered references; each id must exist in PromptV1
}
```

The first release should support create, rename, reorder, add existing prompt,
and remove-from-workflow. It should not introduce "run all prompts" until the
terminal/session handoff semantics are designed; inserting a multi-step plan
blindly into a terminal is unsafe and hard to undo.

### Skills: task-facing by default, storage-facing on demand

Replace the two always-visible Global/Project panes with one selected scope:
**This project** or **Global library**. Keep agent filters in a compact row.
Order the resulting list by user intent:

1. Enabled in this project
2. Available to add
3. Needs attention

A normal skill row shows name, one-line description, and the agents that can
use it. Selecting a row opens details and advanced actions. Filesystem paths,
copy provenance, conflicts, and synchronization controls move into that detail
view. Diagnostics remain discoverable in a dedicated "Needs attention" group,
instead of being scattered as warning glyphs through the main list.

The primary actions must be phrased as outcomes: **Use in this project**,
**Remove from project**, **Enable for Codex**, and **Review duplicate**. They
should not require the user to understand central stores or symlink topology.

## Architecture direction

Create an AI Hub shell owned by the dashboard, with separate feature sections:

```text
AI Hub shell
├── Prompts section
├── Skills section
├── MCP section
└── Hooks section
```

Each section owns its renderer, protocol validation, mutations, and local UI
state. The shell owns top-level navigation, lazy loading, and restoration. This
removes the current dependency where PromptDashboardController renders the
Skills surface.

## Safe delivery slices

1. Extract the AI Hub shell without changing the existing experience or
   message contracts.
2. Deliver compact prompt rows and a selected-prompt editor.
3. Add PromptWorkflowV1, migration, and focused workflow tests.
4. Replace Skills' split-pane layout with selected scope + intent-based
   sections, retaining advanced actions in details.
5. Add MCP and Hooks only when they have a clear task and content model.

## Decisions to make before implementation

- Are workflows global only in v1, or should a project be able to define its
  own workflows?
- Should a workflow be insertable one step at a time into the active terminal,
  or only organize/reveal prompts in v1?
- Which two or three workflows should be treated as first-class acceptance
  examples?
