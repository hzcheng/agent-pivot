# Skill Folders & Scoped Enablement Design

> Status: approved direction, pending implementation plan
> Date: 2026-07-28
> Worktree: `.worktrees/feat-ai-skill-management` (branch `feat/ai-skill-management`)

## Background

Skill management v1 (2026-07-21 design) shipped discovery, effectiveness
diagnostics, toggling, folders-as-virtual-groups, drift/sync, and the
central store (`~/.skills` / `<project>/.skills`) with per-agent symlink
enablement plus a one-shot migration command.

Two structural problems surfaced in use:

1. **Virtual groups are a second, fragile source of truth.** Group
   assignments live in extension `globalState`, keyed by absolute skill
   paths. Any on-disk move (centralize, migrate, manual `mv`) strands the
   assignments, producing confusing "residue" folders in the panel.
2. **The central store is flat.** Real-world skill sets are hierarchical
   collections (`superpowers/*`, `xiaohongshu/yunxiao/*`,
   `xiaohongshu/reddoc/*`). Users want to maintain that hierarchy on disk
   and enable/disable whole folders at global or project level.

## Product direction

**The on-disk folder tree is the single source of truth.** The panel tree
mirrors `~/.skills` (global) and `<project>/.skills` (project) exactly.
Virtual groups and virtual collection suggestions are replaced by real
directories. Anything the user can do in the panel they can also do with
shell/git, and vice versa, with zero state drift.

**Persona**: multi-agent developer with dozens of skills organized into
topic folders, who wants per-skill and per-folder enablement, globally or
per project.

| Job to be done | Today | Product answer |
| --- | --- | --- |
| Organize skills into collections | Virtual groups (fragile) | Real folders inside the central store |
| Enable a skill everywhere / only here | User-scope links only | Scope-segmented iOS switches (global / this project) |
| Enable a whole collection at once | Group toggle (virtual) | Folder batch switch with indeterminate state |
| Rearrange a skill into another folder | Edit group name (no file change) | Drag-and-drop or "Move to folder…" performs a real `mv` |

## Storage model (source of truth)

```
~/.skills/                        ← global central store
├── superpowers/                  ← folder (arbitrary nesting depth)
│   ├── brainstorming/SKILL.md    ← skill = directory containing SKILL.md
│   └── writing-plans/SKILL.md
├── xiaohongshu/
│   ├── yunxiao/<skills>
│   └── reddoc/reddoc-assistant/SKILL.md
└── standalone-skill/SKILL.md     ← root-level skill (folder = "")

<project>/.skills/                ← project central store, same structure
```

- **Skill**: any directory at any depth containing `SKILL.md` (or
  `skill.md`, same parsing as today). Its **folder path** is the parent
  path relative to the store root (`superpowers`, `xiaohongshu/reddoc`,
  or `""` for root-level skills).
- **Folder**: any directory inside the store that is an ancestor of at
  least one skill and is not itself a skill.
- **Enablement** = top-level symlinks in agent roots, because agents scan
  exactly one level:
  - Global: `~/.kimi|claude|codex/skills/<skillName>` → central skill dir
  - Project: `<project>/.kimi|claude|codex/skills/<skillName>` → central
    skill dir (may point into either store)

## Enable matrix

Each skill has a 2 scopes × 3 agents link state. The skill card keeps its
current look; the detail panel shows **one row of three iOS switches
(kimi / claude / codex)**. A **"Global | This project" segmented
control lives in the filter row** and selects which scope *all* switches
in the global section read and write (user decision, 2026-07-28: one row
of switches + scope selector, never two rows). Project-section skills are
inherently project scope and are unaffected by the selector.

Folder headers carry the **same iOS switch in batch form** (user
decision, 2026-07-28), operating at the filter-row scope selection:

- **On** → link every skill under the folder (recursively) for all three
  agents at that scope.
- **Off** → remove every link under the folder at that scope.
- **Indeterminate** (some but not all member links present) → distinct
  visual state; clicking performs "on" (completes the set).

A card with at least one project-scope link shows a small **P** badge so
project enablement is visible without expanding the card.

## Panel structure

```
[filter row: All|kimi|claude|codex] [Global|This project] [Migrate to central]
▼ global                          (~/.skills)
  ▼ 📁 superpowers (14)                 [batch switch]
      <skill card> brainstorming …
  ▼ 📁 xiaohongshu (3)
      ▼ 📁 yunxiao (2)
      ▼ 📁 reddoc (1)
  <skill card> standalone-skill
  ── Unmanaged (real dirs in agent roots, Centralize button) ──
▼ project                       (<project>/.skills)
  (same structure)
```

- Folder nodes are collapsible; collapse state persists across refreshes
  (same mechanism as today's group collapse).
- Scope sections: `global` = user store, `project` = project store,
  matching today's two top-level sections.
- **Unmanaged**: real-directory skills still living in agent roots keep
  the existing source-group rendering with the Centralize action, so the
  migration path remains visible.
- Within each tree level, entries sort like a file explorer: subfolders
  first (by name), then skills (by name).

## Interactions

- **Per-agent toggle** (existing message, extended with `scope`):
  create/remove one top-level symlink; refuses when the link path exists
  as a real directory or belongs to a different central directory.
- **Folder batch toggle** (new message `folder-toggle-skill-links`):
  walks skills under the folder recursively, applies setCentralLink for
  each agent at the scope, and reports per-skill failures without
  stopping the batch.
- **Move to folder…** (replaces the "Set group…" editor): input accepts
  `foo` or `foo/bar`; performs `mv <skillDir> <storeRoot>/foo/bar/<name>`
  creating intermediate directories; refuses when the destination
  exists. Every existing link to the skill (both scopes, all agents) is
  re-created pointing at the new location after the move.
- **Drag-and-drop onto a folder node**: same move as above; dropping
  onto `global` / `project` section roots moves to the store root.
- **Collection suggestions**: "superpowers"-style known collections now
  offer *create folder and move members into it* (a real on-disk
  reorganization) instead of virtual grouping.
- **Centralize** unchanged: moves an unmanaged skill into the store root
  (folder `""`); user files it into a folder afterwards.

## Conflicts

Two skills with the same name in different folders cannot both link into
the same agent root. Rules:

- Creating a conflicting link is refused with a visible error.
- If a conflict already exists on disk (manual linking), both cards show
  a `⚠ name conflict` chip and effectiveness marks the loser `shadowed`.

## Backend changes

| Module | Change |
| --- | --- |
| `types.ts` | `SkillRecord.folder: string`; `SkillCentralInfo.links` becomes scope-nested: `Partial<Record<SkillScope, Partial<Record<SkillAgentId, string>>>>` |
| `discovery.ts` | Recursive central-store scan (skill = dir with SKILL.md, folder = relpath, follow symlinks); top-level agent-root links attributed by scope + agent; same-name central skills in different folders stay separate records |
| `effectiveness.ts` | Visibility computed per scope: user scope reads `links.user`, project scope reads `links.project`; conflict losers become `shadowed` |
| `centralService.ts` | `setCentralLink` unchanged; add `setFolderLinks(storeRoot, folder, scope, enable)` batch with per-skill report; add `moveSkillToFolder(record, targetFolder)` with link re-creation |
| `dashboardController.ts` | `handleCentralToggle` gains `scope`; new `handleFolderToggle`; new `handleMoveToFolder`; group-store/suggestion code paths removed from the panel view model |
| `webviewSkillContent.ts` | Tree rendering rewritten (nested folder nodes, unmanaged section, scope segmented control, P badge, batch switches, conflict chip) |
| `webviewDashboardScripts.js` | Filter-row scope selector state (client-side, persisted in webview state); folder toggle + move messages; drag-and-drop posts folder moves; collapse capture/restore extended to folder nodes |
| `dashboard.ts` | New message handlers (`folder-toggle-skill-links`, `move-skill-to-folder`) with validation scoped to known records |

### Removed

- Virtual skill groups (`skillGroupStore` read/write in the panel),
  group editor UI, group drag-and-drop, virtual collection rendering.
  Stored globalState data is left untouched but ignored.
- The `agents`-source special case in effectiveness stays, but the
  source-group ordering loses its `central` pseudo-source: central
  records organize by folder instead.

## Data flow

1. `scanSkills` walks both central stores recursively, then agent roots
   (top level), merges links into central records, applies per-scope
   effectiveness.
2. Controller builds the panel view: folder tree per scope + unmanaged
   source groups + conflict annotations.
3. Webview renders the tree; switch clicks post scoped toggle messages;
   host mutates symlinks, re-scans, and posts authoritative HTML.
4. Move/drag operations `mv` on disk, re-create links, re-scan, and the
   authoritative refresh lands the card in its new folder.

## Error handling

- All filesystem mutations are non-destructive: losers park under
  `.disabled`, moves refuse to overwrite, link removal refuses real
  directories, and every failure surfaces as a warning toast plus a
  refresh.
- Batch folder operations continue past per-skill errors and summarize
  failures in the toast.

## Testing

- `run-skill-management-checks.js`: recursive discovery, folder paths,
  scope-nested links, per-scope effectiveness, folder batch toggle
  (incl. partial/indeterminate semantics), move-to-folder with link
  re-creation, conflict refusal + conflict rendering, tree rendering,
  wiring, and removal of virtual-group rendering.
- Browser tests: scope segmented control interaction, folder batch
  switch, drag-and-drop folder move, collapse persistence for folder
  nodes.
- Contract/dashboard checks: updated message surface and rendering
  assertions.
- README updated for the folder model.
