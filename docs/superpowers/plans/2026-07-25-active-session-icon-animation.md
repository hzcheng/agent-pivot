# Active Session Icon Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent machine-scoped animation selector for the circular icon at the start of a running Active Session row, with the existing blue border, a halo, all six bundled Sharingan variants, and no animation.

**Architecture:** Normalize the new setting at the HTML renderer boundary, pass it through full rendering and every incremental message that can replace the current workspace card, and emit `data-session-icon-fx` only on running Active Session rows. Keep History rows and message protocols unchanged. Implement all visuals with scoped SCSS pseudo-elements over the existing terminal icon and reuse the already packaged Sharingan assets.

**Tech Stack:** TypeScript, VS Code contribution configuration, HTML string rendering, SCSS/CSS, Node.js test runner and assertion scripts, Gulp.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-07-25-active-session-icon-animation-design.md`.
- The setting is exactly `projectSteward.aiSessionRunningIconAnimation`, defaults to `current`, and has machine scope.
- Its exact values, in order, are `current`, `halo`, `sharingan-itachi`, `sharingan-obito-kakashi`, `sharingan-sasuke`, `sharingan-shisui`, `sharingan-madara`, `sharingan-madara-eternal`, and `none`.
- The new setting remains independent from `projectSteward.aiSessionRunningCardAnimation`.
- Only `.active-ai-session-row` icons become circular; History/SESSIONS icons retain their 7px rounded-square geometry.
- Only `data-execution-state="running"` rows receive `data-session-icon-fx`. Starting, stopped, and defensive unknown states remain unanimated.
- Keep icon dimensions at 26px, responsive dimensions at 21px, and terminal SVG dimensions at 17px/14px.
- Unknown setting values normalize to `current`.
- `current` retains the existing 2.6-second blue border; Sharingan uses `1.8s linear infinite`.
- Reduced motion keeps the selected static visual but stops movement. Forced colors keeps a system-visible icon border.
- The terminal SVG stays below every overlay as the missing-asset fallback.
- Do not add assets, network requests, session fields, bridge fields, or Webview message protocol fields.
- SCSS is the source of truth; regenerate `media/styles.css` with Gulp.

---

### Task 1: Lock the setting and renderer contract with failing tests

**Files:**
- Modify: `package.json:164-201`
- Modify: `README.md:175-195`
- Modify: `src/webview/webviewContent.ts:24-70, 130-150, 279-405, 733-800, 973-1040`
- Modify: `src/dashboard/webviewUpdateMessages.ts:68-154`
- Modify: `src/aiSessions/dashboardController.ts:10-25, 132-147`
- Modify: `src/openWorkspaces/dashboardController.ts:20-40, 106-123, 235-250`
- Modify: `src/dashboard.ts:985-1000, 1435-1450`
- Modify: `src/dashboard/lifecycleController.ts:3-25`
- Modify: `tests/integration/dashboard/webviewState.test.js:350-450`
- Modify: `tests/integration/dashboard/sessionRuntimeFlow.test.js:200-310`
- Modify: `tests/contract/openProjects/dashboardController.test.js:15-50`
- Modify: `scripts/run-dashboard-webview-checks.js:285-365, 413-690, 3490-3550`
- Modify: `scripts/run-ai-session-safety-checks.js:4860-4930, 5280-5335, 5470-5510, 6960-7160`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `scripts/run-workspace-parity-checks.js`

**Interfaces:**
- Consumes: the machine setting value and each current-workspace card's existing Active Session view models.
- Produces: normalized rendered HTML in full, workspace, OPEN-workspaces, and AI-session updates without changing their message versions or serialized fields.

- [ ] **Step 1: Add failing configuration and row-rendering assertions**

In `scripts/run-ai-session-safety-checks.js`, assert the exact contribution:

```js
const runningIconAnimation = packageJson.contributes.configuration.properties[
    'projectSteward.aiSessionRunningIconAnimation'
];
assert.deepStrictEqual(runningIconAnimation.enum, [
    'current',
    'halo',
    'sharingan-itachi',
    'sharingan-obito-kakashi',
    'sharingan-sasuke',
    'sharingan-shisui',
    'sharingan-madara',
    'sharingan-madara-eternal',
    'none',
]);
assert.strictEqual(runningIconAnimation.default, 'current');
assert.strictEqual(runningIconAnimation.scope, 'machine');
assert.strictEqual(runningIconAnimation.enumDescriptions.length, 9);
```

Extend the existing `sessionTabsHtml` fixture to pass:

```js
{ runningIconAnimation: 'sharingan-madara-eternal' }
```

Assert that both running rows contain
`data-session-icon-fx="sharingan-madara-eternal"`, while the stopped and
starting row tags do not contain `data-session-icon-fx`.

In `tests/integration/dashboard/webviewState.test.js`, add
`ACTIVE-SESSION-ICON-ANIMATION-001` coverage that renders:

```js
getAiSessionsDiv(surface, { runningIconAnimation: 'sharingan-itachi' })
```

and proves:

- the running Active row has the exact effect attribute;
- starting and stopped Active rows have no effect attribute;
- a History row has neither the effect attribute nor `active-ai-session-row`;
- an invalid value on a running row becomes `current`;
- `none` remains `none`.

- [ ] **Step 2: Add failing full/incremental propagation assertions**

In `scripts/run-dashboard-webview-checks.js`, pass distinct icon selections
through all renderer entry points by adding
`runningIconAnimation: 'sharingan-itachi'` to the existing
`buildAiSessionsUpdatedMessage` fixture,
`runningIconAnimation: 'sharingan-sasuke'` to the existing
`buildWorkspaceUpdatedMessage` fixture, and
`runningIconAnimation: 'sharingan-obito-kakashi'` to the existing
`buildOpenWorkspacesUpdatedMessage` fixture.

Assert each returned `html` contains the matching
`data-session-icon-fx`. For the full renderer config fixture, return
`sharingan-shisui` for `aiSessionRunningIconAnimation` and assert the same.

Update the AI-session controller de-duplication fixture in
`scripts/run-ai-session-safety-checks.js` so changing only
`runningIconAnimation` from `sharingan-madara` to
`sharingan-madara-eternal` posts a second message with new HTML.

Update the OPEN-workspace controller fixture in
`scripts/run-open-project-safety-checks.js` so its semantic revision changes
when only the icon setting changes. This guards against a later OPEN update
replacing the correctly rendered Active Session icon with stale/default HTML.

Add the new getter with a harmless default to every controller fixture found
by:

```bash
rg -n "new AiSessionDashboardController|new OpenWorkspaceDashboardController" \
  src tests scripts
```

Use:

```js
getRunningIconAnimation: () => undefined,
```

except in the focused propagation/de-duplication tests.

- [ ] **Step 3: Add a failing configuration-refresh assertion**

In the existing lifecycle-controller test in
`scripts/run-dashboard-webview-checks.js`, send a configuration event affecting
only:

```text
projectSteward.aiSessionRunningIconAnimation
```

Assert it follows the non-TODO Dashboard refresh path exactly once.

- [ ] **Step 4: Run the focused tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/webviewState.test.js
node --test tests/integration/dashboard/sessionRuntimeFlow.test.js
node --test tests/contract/openProjects/dashboardController.test.js
node scripts/run-dashboard-webview-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-open-project-safety-checks.js
node scripts/run-workspace-parity-checks.js
```

Expected: assertions fail for the missing contribution, renderer option,
effect attribute, controller getter, and configuration refresh key.

- [ ] **Step 5: Add the bounded setting**

Add this sibling contribution after
`projectSteward.aiSessionRunningCardAnimation` in `package.json`:

```json
"projectSteward.aiSessionRunningIconAnimation": {
    "type": "string",
    "enum": [
        "current",
        "halo",
        "sharingan-itachi",
        "sharingan-obito-kakashi",
        "sharingan-sasuke",
        "sharingan-shisui",
        "sharingan-madara",
        "sharingan-madara-eternal",
        "none"
    ],
    "enumDescriptions": [
        "A rotating blue border surrounds the running Active Session terminal icon.",
        "A bright rotating halo surrounds the running Active Session terminal icon.",
        "Itachi Uchiha's Mangekyo Sharingan replaces and rotates over the running Active Session icon.",
        "Obito Uchiha and Kakashi Hatake's Mangekyo Sharingan replaces and rotates over the running Active Session icon.",
        "Sasuke Uchiha's Mangekyo Sharingan replaces and rotates over the running Active Session icon.",
        "Shisui Uchiha's Mangekyo Sharingan replaces and rotates over the running Active Session icon.",
        "Madara Uchiha's Mangekyo Sharingan replaces and rotates over the running Active Session icon.",
        "Madara Uchiha's Eternal Mangekyo Sharingan replaces and rotates over the running Active Session icon.",
        "No animation; show the ordinary circular terminal icon."
    ],
    "default": "current",
    "scope": "machine",
    "description": "Animation shown on the icon of an Active Session row while that session is executing."
}
```

Document the exact values as a separate bullet in `README.md`.

- [ ] **Step 6: Implement normalization and running-row markup**

Near the existing card-effect allowlist in
`src/webview/webviewContent.ts`, add:

```ts
const AI_SESSION_RUNNING_ICON_ANIMATIONS = new Set([
    'current',
    'halo',
    'sharingan-itachi',
    'sharingan-obito-kakashi',
    'sharingan-sasuke',
    'sharingan-shisui',
    'sharingan-madara',
    'sharingan-madara-eternal',
    'none',
]);

function normalizeRunningIconAnimation(value: string | undefined): string {
    return value && AI_SESSION_RUNNING_ICON_ANIMATIONS.has(value) ? value : 'current';
}
```

Extend `AiSessionRenderOptions`:

```ts
interface AiSessionRenderOptions {
    showRootChips?: boolean;
    runningIconAnimation?: string;
}
```

Pass `options.runningIconAnimation` from `getActiveAiSessionPanel` to
`getActiveAiSessionRow`. In the row function compute:

```ts
var iconFx = model.executionState === 'running'
    ? normalizeRunningIconAnimation(runningIconAnimation)
    : '';
```

Emit:

```ts
${iconFx ? ` data-session-icon-fx="${iconFx}"` : ''}
```

on the Active row only. Do not add the attribute in `getCodexSessionRow`.

- [ ] **Step 7: Thread the setting through every HTML replacement path**

Add `runningIconAnimation?: string` after the existing card-animation argument
or property in:

- `getCurrentWorkspaceGroupContent`;
- `getOpenWorkspacesGroupContent`;
- private `getWorkspaceCardDiv`;
- `BuildWorkspaceUpdatedMessageInput`;
- `BuildOpenWorkspacesUpdatedMessageInput`;
- `BuildAiSessionsUpdatedMessageInput`;
- `AiSessionDashboardControllerOptions`;
- `OpenWorkspaceDashboardControllerOptions`.

Pass it only into the current card's call to `getAiSessionsDiv`:

```ts
getAiSessionsDiv(getWorkspaceAiSessionSurface(card), {
    showRootChips: rootCount > 1,
    runningIconAnimation,
})
```

Read `aiSessionRunningIconAnimation` with fallback `current` in the full
`getStewardContent` path and in both relevant controller constructions in
`src/dashboard.ts`.

Include `getRunningIconAnimation()` in
`OpenWorkspaceDashboardController.getViewSemanticRevision()` so a selection
change cannot be suppressed by de-duplication. The AI-session controller
already hashes rendered message HTML; passing the value into the builder is
sufficient there.

Add `projectSteward.aiSessionRunningIconAnimation` next to the existing card
animation in `NON_TODO_DASHBOARD_CONFIGURATION_SECTIONS`.

- [ ] **Step 8: Run focused GREEN checks**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/webviewState.test.js
node --test tests/integration/dashboard/sessionRuntimeFlow.test.js
node --test tests/contract/openProjects/dashboardController.test.js
node scripts/run-dashboard-webview-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-open-project-safety-checks.js
node scripts/run-workspace-parity-checks.js
git diff --check
```

Expected: compilation and all focused renderer/controller checks pass.

- [ ] **Step 9: Commit the configuration and renderer contract**

```bash
git add package.json README.md \
  src/webview/webviewContent.ts \
  src/dashboard/webviewUpdateMessages.ts \
  src/aiSessions/dashboardController.ts \
  src/openWorkspaces/dashboardController.ts \
  src/dashboard.ts src/dashboard/lifecycleController.ts \
  tests/integration/dashboard/webviewState.test.js \
  tests/integration/dashboard/sessionRuntimeFlow.test.js \
  tests/contract/openProjects/dashboardController.test.js \
  scripts/run-dashboard-webview-checks.js \
  scripts/run-ai-session-safety-checks.js \
  scripts/run-open-project-safety-checks.js \
  scripts/run-workspace-parity-checks.js
git commit -m "feat: configure Active Session icon animations"
```

---

### Task 2: Implement circular icon visuals and all nine modes

**Files:**
- Modify: `tests/integration/dashboard/styles.test.js:1-180, 280-320`
- Modify: `media/styles.scss:3260-3345, 3745-3930`
- Modify generated: `media/styles.css`
- Modify: `scripts/run-ai-session-safety-checks.js:5230-5290`

**Interfaces:**
- Consumes: the normalized `data-session-icon-fx` attribute on a running Active row.
- Produces: scoped circular, animated, responsive, reduced-motion, and forced-colors presentation without changing row layout or controls.

- [ ] **Step 1: Add a mutation-sensitive style contract first**

Add an `ACTIVE-SESSION-ICON-ANIMATION-001` validator to
`tests/integration/dashboard/styles.test.js`. Test compiled SCSS and prove the
validator fails after controlled mutations. Lock these declarations:

- `.active-ai-session-row .codex-session-icon` has `border-radius: 50%`;
- the base `.codex-session-icon` still has `border-radius: 7px`, `width: 26px`,
  `height: 26px`, and 17px SVG dimensions;
- the narrow rule still has 21px icon and 14px SVG dimensions;
- `current` has a circular border mask and
  `animation: steward-session-icon-spin 2.6s linear infinite`;
- `halo` has a distinct brighter conic/radial glow, keeps the terminal visible,
  and rotates without changing layout;
- all six icon-effect Sharingan selectors map to the exact existing asset;
- the shared Sharingan overlay uses `position: absolute`, `inset: 0`,
  `background-size: 100% 100%`, `border-radius: 50%`,
  `animation: steward-session-running-sharingan 1.8s linear infinite`, and
  `pointer-events: none`;
- no Sharingan rule hides `.codex-session-icon svg`;
- `none` has no pseudo-element animation rule;
- reduced motion disables current, halo, and Sharingan animation;
- forced colors sets the Active Session icon border to `CanvasText`;
- no effect selector targets a plain History row.

Extend the static safety assertions in
`scripts/run-ai-session-safety-checks.js` to use the new scoped selectors
instead of the old unqualified running-row selector.

- [ ] **Step 2: Run the style tests and observe RED**

Run:

```bash
node --test tests/integration/dashboard/styles.test.js
node scripts/run-ai-session-safety-checks.js
```

Expected: failures identify square Active icons, the old unscoped current
animation selector, and missing halo/Sharingan icon mappings.

- [ ] **Step 3: Scope circular geometry to Active rows**

Keep the existing base History icon rule unchanged and add:

```scss
.active-ai-session-row .codex-session-icon {
    position: relative;
    border-radius: 50%;
}
```

Do not change width, height, SVG size, grid columns, padding, or responsive
rules.

- [ ] **Step 4: Re-scope `current` and add `halo`**

Replace the old:

```scss
.codex-session-row[data-execution-state="running"] .codex-session-icon
```

with a selector requiring all three Active/running/current attributes. Preserve
the current gradient, mask, drop shadow, and 2.6-second animation; change its
pseudo-element radius to `50%`.

Add a separate Active/running/halo rule using an inert circular `::before`.
Give it a visibly brighter blue-white conic edge and outer glow while keeping
the layer within the existing icon footprint. Reuse
`steward-session-icon-spin` and do not hide the terminal SVG.

- [ ] **Step 5: Add the six Sharingan mappings**

Create one shared Active/running Sharingan overlay rule and these exact
mappings:

```scss
.active-ai-session-row[data-execution-state="running"][data-session-icon-fx="sharingan-itachi"] .codex-session-icon::after {
    background-image: url("sharingan/mangekyou-sharingan-itachi.svg");
}
.active-ai-session-row[data-execution-state="running"][data-session-icon-fx="sharingan-obito-kakashi"] .codex-session-icon::after {
    background-image: url("sharingan/mangekyou-sharingan-obito-kakashi.svg");
}
.active-ai-session-row[data-execution-state="running"][data-session-icon-fx="sharingan-sasuke"] .codex-session-icon::after {
    background-image: url("sharingan/mangekyou-sharingan-sasuke.svg");
}
.active-ai-session-row[data-execution-state="running"][data-session-icon-fx="sharingan-shisui"] .codex-session-icon::after {
    background-image: url("sharingan/mangekyou-sharingan-shisui.svg");
}
.active-ai-session-row[data-execution-state="running"][data-session-icon-fx="sharingan-madara"] .codex-session-icon::after {
    background-image: url("sharingan/mangekyou-sharingan-madara.svg");
}
.active-ai-session-row[data-execution-state="running"][data-session-icon-fx="sharingan-madara-eternal"] .codex-session-icon::after {
    background-image: url("sharingan/mangekyou-sharingan-madara-eternal.svg");
}
```

Apply them to the overlay pseudo-element rather than the icon container. Keep
the terminal SVG below it. Do not add a pseudo-element rule for `none`.

- [ ] **Step 6: Add reduced-motion and forced-colors behavior**

Extend the second `prefers-reduced-motion` block so `::before` for current and
halo and `::after` for Sharingan use:

```scss
animation: none !important;
transition: none !important;
```

Do not remove their backgrounds, images, masks, or borders.

Inside `@media (forced-colors: active)`, explicitly set:

```scss
.active-ai-session-row .codex-session-icon {
    border: 1px solid CanvasText;
}
```

Keep all overlays pointer-inert and preserve the existing focus-visible rule.

- [ ] **Step 7: Regenerate CSS and run focused GREEN checks**

Run:

```bash
npx gulp buildStyles
node --test tests/integration/dashboard/styles.test.js
node scripts/run-ai-session-safety-checks.js
npm run test:dashboard
npm run test:safety
git diff --check
```

Expected: style artifact parity, visual contract, Dashboard checks, and safety
checks all pass.

- [ ] **Step 8: Commit the visual implementation**

```bash
git add media/styles.scss media/styles.css \
  tests/integration/dashboard/styles.test.js \
  scripts/run-ai-session-safety-checks.js
git commit -m "feat: animate circular Active Session icons"
```

---

### Task 3: Register behavior coverage and complete release verification

**Files:**
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: the committed renderer/configuration and visual commits.
- Produces: an auditable behavior contract and a verified release artifact that reuses the existing six bundled assets.

- [ ] **Step 1: Register the behavior contract**

Add:

```json
{
  "id": "ACTIVE-SESSION-ICON-ANIMATION-001",
  "domain": "webview",
  "title": "Running Active Session rows render the selected circular icon animation",
  "priority": "P1",
  "status": "automated",
  "owners": [
    "tests/integration/dashboard/webviewState.test.js",
    "tests/integration/dashboard/styles.test.js"
  ],
  "evidence": [
    "src/webview/webviewContent.ts",
    "media/styles.scss",
    "media/styles.css"
  ]
}
```

Add this behavior to `MAIN-RUNTIME-SESSION-RECOVERY`, and append the two feature
commit hashes to that capability. Update the coverage audit `head` to the
visual implementation commit. Do not add the plan/design documentation commits
as behavior commits.

- [ ] **Step 2: Run behavior and deterministic verification**

Run:

```bash
npm run test:behavior-contracts
npm run test:deterministic
npm run test:dashboard
npm run test:safety
git diff --check
```

Expected: all commands pass with the new behavior discoverable by the catalog.

- [ ] **Step 3: Commit the coverage audit**

```bash
git add docs/testing/behavior-contracts.json \
  docs/testing/main-capability-coverage.json
git commit -m "docs: audit Active Session icon animation coverage"
```

- [ ] **Step 4: Run complete verification from the final commit**

Run:

```bash
npm run test:ci:linux
git status --short
git log -4 --oneline
```

Expected:

- the complete Linux CI command exits 0;
- release packaging succeeds without any allowlist change because all six SVG
  assets are already in the exact VSIX contract;
- the feature worktree is clean;
- the three implementation/audit commits follow the design and plan commits.

- [ ] **Step 5: Optional local install only when requested**

Use the repository's local-install workflow rather than manually copying
extension files:

```bash
npm run install-local
```

Then reload the correct VS Code extension host and test all nine setting
values, running/non-running state transitions, narrow width, reduced motion,
and History-row isolation.
