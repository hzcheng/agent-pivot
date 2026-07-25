# Multi-Provider Session History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each workspace select multiple AI providers in the Sessions tab and render one pinned-first, provider-adjacent history list with cross-provider batch archive.

**Architecture:** Add one host-owned normalized provider-selection model and persist it beside the legacy primary-provider record. Project one combined history list from the selected providers, render an accessible checkbox popup, and extend batch archive to use composite `{ provider, sessionId }` identities while reusing the existing provider archive primitive.

**Tech Stack:** TypeScript, VS Code workspace state, HTML string rendering, plain Webview JavaScript, SCSS/CSS, Node.js test runner, Playwright Chromium, Gulp, Webpack, VSIX packaging.

## Global Constraints

- Work only in the existing isolated worktree `/home/hzcheng/projects/repos/vscode-dashboard/.worktree/sharingan-running-animation`.
- The approved design is `docs/superpowers/specs/2026-07-25-multi-provider-session-history-design.md`.
- Upgrade migration preserves the exact currently selected provider as the only selected provider.
- At least one provider must remain selected.
- The primary provider sorts first; other selected providers follow registry order.
- Pinned and unpinned partitions both keep sessions from the same provider adjacent.
- Do not render provider section panels or provider headings.
- Pinned sessions appear together before every unpinned session.
- `All` selects visible unpinned, inactive sessions across every selected provider.
- Pinned sessions remain manually selectable; active sessions never become archive-eligible.
- The Active tab, creation/resume flow, icon animations, and card animations remain unchanged.
- Provider selection and batch archive are host-validated; the Webview is not a persistent source of truth.
- SCSS is the source of truth; regenerate `media/styles.css` and copied Webview assets through Gulp.
- Add no runtime dependency.
- Every production change follows a failing-test-first cycle and ends in an intentional commit.

---

### Task 1: Normalize, persist, and hydrate provider selection

**Files:**
- Create: `src/aiSessions/providerSelection.ts`
- Create: `tests/unit/aiSessions/providerSelection.test.js`
- Modify: `src/constants.ts`
- Modify: `src/aiSessions/workspaceStateStore.ts`
- Modify: `src/aiSessions/types.ts`
- Modify: `src/workspaces/viewModels.ts`
- Modify: `src/workspaces/sessionHydration.ts`
- Modify: `src/workspaces/sessionHydrationController.ts`
- Modify: `src/dashboard.ts`
- Modify: `tests/contract/persistence/stores.test.js`
- Modify: `tests/contract/aiSessions/projectHydrationController.test.js`
- Modify: `tests/contract/aiSessions/archiveAndHydration.test.js`

**Interfaces:**
- Produces:

```ts
export interface AiSessionProviderSelection {
    primaryProvider: AiSessionProviderId;
    selectedProviders: AiSessionProviderId[];
}

export interface NormalizeAiSessionProviderSelectionInput {
    registeredProviders: readonly AiSessionProviderId[];
    primaryProvider?: unknown;
    selectedProviders?: unknown;
    sessionCounts?: Partial<Record<AiSessionProviderId, number>>;
}

export function normalizeAiSessionProviderSelection(
    input: NormalizeAiSessionProviderSelectionInput
): AiSessionProviderSelection;
```

- Extends `WorkspaceAiSessionViewModel` with
  `selectedProviders: AiSessionProviderId[]`.
- Produces store methods:

```ts
getProviderSelections(): Record<string, AiSessionProviderSelection>;
setProviderSelection(
    workspaceScopeIdentity: string,
    selection: AiSessionProviderSelection
): Promise<void>;
```

- Later tasks consume the normalized selected-provider order from the view
  model and workspace action target.

- [ ] **Step 1: Write normalization tests**

Create `tests/unit/aiSessions/providerSelection.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    normalizeAiSessionProviderSelection,
} = require('../../../out/aiSessions/providerSelection');

const registeredProviders = ['codex', 'kimi', 'claude'];

test('SESSION-MULTI-PROVIDER-SELECTION-001 migrates one primary provider and normalizes ordered selections', () => {
    assert.deepEqual(normalizeAiSessionProviderSelection({
        registeredProviders,
        primaryProvider: 'kimi',
    }), {
        primaryProvider: 'kimi',
        selectedProviders: ['kimi'],
    });

    assert.deepEqual(normalizeAiSessionProviderSelection({
        registeredProviders,
        primaryProvider: 'kimi',
        selectedProviders: ['claude', 'unknown', 'codex', 'claude'],
    }), {
        primaryProvider: 'claude',
        selectedProviders: ['claude', 'codex'],
    });

    assert.deepEqual(normalizeAiSessionProviderSelection({
        registeredProviders,
        primaryProvider: 'unknown',
        selectedProviders: [],
        sessionCounts: { codex: 0, kimi: 3, claude: 1 },
    }), {
        primaryProvider: 'kimi',
        selectedProviders: ['kimi'],
    });
});
```

- [ ] **Step 2: Extend persistence and hydration tests**

In `tests/contract/persistence/stores.test.js`, seed both legacy and new state:

```js
const state = makeState({
    'workspaceActiveAiSessionProvider.v2': {
        'scope-a': 'codex',
        'scope-b': 'unknown',
        'scope-c': 'kimi',
    },
    'workspaceAiSessionProviderSelection.v1': {
        'scope-a': {
            primaryProvider: 'codex',
            selectedProviders: ['codex', 'claude', 'claude', 'unknown'],
        },
        'scope-b': { primaryProvider: 'unknown', selectedProviders: [] },
    },
});
```

Assert:

```js
assert.deepEqual(store.getProviderSelections(), {
    'scope-a': {
        primaryProvider: 'codex',
        selectedProviders: ['codex', 'claude'],
    },
});
await store.setProviderSelection('scope-d', {
    primaryProvider: 'claude',
    selectedProviders: ['claude', 'kimi'],
});
assert.deepEqual(state.values['workspaceAiSessionProviderSelection.v1']['scope-d'], {
    primaryProvider: 'claude',
    selectedProviders: ['claude', 'kimi'],
});
assert.equal(
    state.values['workspaceActiveAiSessionProvider.v2']['scope-d'],
    'claude'
);
```

Update the workspace hydration fixture to return:

```js
getProviderSelection: scope => scope === WORKSPACE.scopeIdentity
    ? { primaryProvider: 'codex', selectedProviders: ['codex', 'kimi'] }
    : undefined,
```

and assert:

```js
assert.equal(hydrated.activeProvider, 'codex');
assert.deepEqual(hydrated.selectedProviders, ['codex', 'kimi']);
```

- [ ] **Step 3: Run the tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/providerSelection.test.js
node --test tests/contract/persistence/stores.test.js
node --test tests/contract/aiSessions/projectHydrationController.test.js
```

Expected: the unit test fails because `providerSelection` does not exist, and
the contract tests fail because the store and hydration controller expose only
one provider.

- [ ] **Step 4: Implement the pure normalizer**

Create `src/aiSessions/providerSelection.ts`:

```ts
'use strict';

import type { AiSessionProviderId } from '../models';

export interface AiSessionProviderSelection {
    primaryProvider: AiSessionProviderId;
    selectedProviders: AiSessionProviderId[];
}

export interface NormalizeAiSessionProviderSelectionInput {
    registeredProviders: readonly AiSessionProviderId[];
    primaryProvider?: unknown;
    selectedProviders?: unknown;
    sessionCounts?: Partial<Record<AiSessionProviderId, number>>;
}

export function normalizeAiSessionProviderSelection(
    input: NormalizeAiSessionProviderSelectionInput
): AiSessionProviderSelection {
    const registered = Array.from(new Set(input.registeredProviders));
    const registeredSet = new Set(registered);
    const requested = Array.isArray(input.selectedProviders)
        ? Array.from(new Set(input.selectedProviders.filter(
            (value): value is AiSessionProviderId =>
                typeof value === 'string' && registeredSet.has(value as AiSessionProviderId)
        )))
        : [];
    let primary = typeof input.primaryProvider === 'string'
        && registeredSet.has(input.primaryProvider as AiSessionProviderId)
        ? input.primaryProvider as AiSessionProviderId
        : undefined;

    if (!primary) {
        primary = requested[0]
            || registered.find(provider => Number(input.sessionCounts?.[provider] || 0) > 0)
            || registered[0]
            || 'codex';
    }
    const selected = requested.length ? requested : [primary];
    if (!selected.includes(primary)) {
        primary = selected[0];
    }

    return {
        primaryProvider: primary,
        selectedProviders: [
            primary,
            ...registered.filter(provider => provider !== primary && selected.includes(provider)),
        ],
    };
}
```

- [ ] **Step 5: Add the combined state record**

In `src/constants.ts` add:

```ts
export const WORKSPACE_AI_SESSION_PROVIDER_SELECTION_KEY =
    'workspaceAiSessionProviderSelection.v1';
```

In `src/aiSessions/workspaceStateStore.ts`, validate the combined record with
the pure normalizer. Keep `getActiveProviders()` as the legacy fallback and
mirror the primary provider after the combined record is persisted:

```ts
async setProviderSelection(
    workspaceScopeIdentity: string,
    selection: AiSessionProviderSelection
): Promise<void> {
    if (!workspaceScopeIdentity) {
        return;
    }
    const selections = this.getProviderSelections();
    selections[workspaceScopeIdentity] = {
        primaryProvider: selection.primaryProvider,
        selectedProviders: [...selection.selectedProviders],
    };
    await this.state.update(WORKSPACE_AI_SESSION_PROVIDER_SELECTION_KEY, selections);

    const activeProviders = this.getActiveProviders();
    activeProviders[workspaceScopeIdentity] = selection.primaryProvider;
    await this.state.update(WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY, activeProviders);
}
```

`getProviderSelections()` must discard malformed workspace keys and malformed
selection objects. Do not synthesize legacy entries in this getter; hydration
performs migration using the legacy primary when the combined entry is absent.

- [ ] **Step 6: Propagate selection through hydration**

Change `WorkspaceSessionHydrationControllerOptions` from `getActiveProvider` to:

```ts
getProviderSelection: (
    workspaceScopeIdentity: string
) => AiSessionProviderSelection | undefined;
```

Pass the selection into `hydrateWorkspaceAiSessions`, and call
`normalizeAiSessionProviderSelection` in `buildWorkspaceAiSessionViewModel`
using:

```ts
const selection = normalizeAiSessionProviderSelection({
    registeredProviders: input.providers.map(provider => provider.id),
    primaryProvider: input.providerSelection?.primaryProvider
        || input.activeProvider,
    selectedProviders: input.providerSelection?.selectedProviders,
    sessionCounts: Object.fromEntries(
        providers.map(provider => [provider.id, provider.count])
    ),
});
```

Return:

```ts
activeProvider: selection.primaryProvider,
selectedProviders: selection.selectedProviders,
```

Update the dashboard wiring:

```ts
getProviderSelection: scopeIdentity => {
    const stored = aiSessionWorkspaceStateStore.getProviderSelections()[scopeIdentity];
    if (stored) {
        return stored;
    }
    const legacy = aiSessionWorkspaceStateStore.getActiveProviders()[scopeIdentity];
    return legacy
        ? { primaryProvider: legacy, selectedProviders: [legacy] }
        : undefined;
},
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/providerSelection.test.js
node --test tests/contract/persistence/stores.test.js
node --test tests/contract/aiSessions/projectHydrationController.test.js
node --test tests/contract/aiSessions/archiveAndHydration.test.js
```

Expected: all focused tests pass and the legacy fixture still hydrates one
provider.

- [ ] **Step 8: Commit**

```bash
git add src/constants.ts \
  src/aiSessions/providerSelection.ts \
  src/aiSessions/workspaceStateStore.ts \
  src/aiSessions/types.ts \
  src/workspaces/viewModels.ts \
  src/workspaces/sessionHydration.ts \
  src/workspaces/sessionHydrationController.ts \
  src/dashboard.ts \
  tests/unit/aiSessions/providerSelection.test.js \
  tests/contract/persistence/stores.test.js \
  tests/contract/aiSessions/projectHydrationController.test.js \
  tests/contract/aiSessions/archiveAndHydration.test.js
git commit -m "feat: persist multi-provider session selection"
```

---

### Task 2: Project and render one pinned-first history list

**Files:**
- Create: `src/aiSessions/historyProjection.ts`
- Create: `tests/unit/aiSessions/historyProjection.test.js`
- Modify: `src/models.ts`
- Modify: `src/webview/webviewContent.ts`
- Modify: `media/styles.scss`
- Modify: `media/styles.css`
- Modify: `tests/integration/dashboard/webviewState.test.js`
- Modify: `tests/integration/dashboard/styles.test.js`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes `WorkspaceAiSessionViewModel.selectedProviders`.
- Produces:

```ts
export interface AiSessionHistoryProjection {
    pinned: AiSessionViewModel[];
    unpinned: AiSessionViewModel[];
}

export function projectAiSessionHistory(
    selectedProviders: readonly AiSessionProviderId[],
    sessionsByProvider: Partial<Record<AiSessionProviderId, readonly AiSessionViewModel[]>>
): AiSessionHistoryProjection;
```

- Produces stable markup attributes consumed by Task 3:
  `data-ai-provider-menu-trigger`, `data-ai-provider-menu`,
  `data-ai-provider-option`, `data-provider`, and
  `data-selected-ai-session-providers`.
- Keeps each existing session row's `data-session-provider` and
  `data-session-id` attributes for Task 4.

- [ ] **Step 1: Write projection tests**

Create `tests/unit/aiSessions/historyProjection.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    projectAiSessionHistory,
} = require('../../../out/aiSessions/historyProjection');

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 keeps pinned and unpinned provider runs adjacent', () => {
    const projection = projectAiSessionHistory(['kimi', 'codex', 'claude'], {
        codex: [
            { id: 'c-pin', provider: 'codex', pinned: true },
            { id: 'c-new', provider: 'codex' },
            { id: 'c-old', provider: 'codex' },
        ],
        kimi: [
            { id: 'k-pin', provider: 'kimi', pinned: true },
            { id: 'k-new', provider: 'kimi' },
        ],
        claude: [
            { id: 'a-new', provider: 'claude' },
        ],
    });

    assert.deepEqual(projection.pinned.map(item => item.id), ['k-pin', 'c-pin']);
    assert.deepEqual(projection.unpinned.map(item => item.id), [
        'k-new', 'c-new', 'c-old', 'a-new',
    ]);
});
```

- [ ] **Step 2: Write renderer and style contracts**

Extend `tests/integration/dashboard/webviewState.test.js` with a fixture whose
primary provider is Kimi and whose selected providers are Kimi, Codex, and
Claude. Assert:

```js
assert.match(html, /data-selected-ai-session-providers="kimi,codex,claude"/);
assert.match(html, /data-ai-provider-menu-trigger/);
assert.match(html, /role="menuitemcheckbox"/);
assert.match(html, /aria-checked="true"/);
assert.ok(html.indexOf('k-pin') < html.indexOf('c-pin'));
assert.ok(html.indexOf('c-pin') < html.indexOf('k-new'));
assert.ok(html.indexOf('k-new') < html.indexOf('c-new'));
assert.ok(html.indexOf('c-new') < html.indexOf('a-new'));
assert.doesNotMatch(html, /ai-session-provider-section/);
```

Add a mutation-sensitive style validator requiring:

```text
.ai-session-provider-menu { position: absolute; z-index: 80 }
.ai-session-provider-option[aria-checked="true"]
.ai-session-provider-option:focus-visible
.ai-session-provider-badge
.ai-session-pinned-heading
@media (forced-colors: active)
```

and forbidding a provider-section container.

- [ ] **Step 3: Run tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/historyProjection.test.js
node --test tests/integration/dashboard/webviewState.test.js
node --test tests/integration/dashboard/styles.test.js
```

Expected: projection is missing, the renderer still emits one native select and
one provider's rows, and the new style contract fails.

- [ ] **Step 4: Implement the pure projection**

Create `src/aiSessions/historyProjection.ts`:

```ts
'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionViewModel } from './types';

export interface AiSessionHistoryProjection {
    pinned: AiSessionViewModel[];
    unpinned: AiSessionViewModel[];
}

export function projectAiSessionHistory(
    selectedProviders: readonly AiSessionProviderId[],
    sessionsByProvider: Partial<Record<AiSessionProviderId, readonly AiSessionViewModel[]>>
): AiSessionHistoryProjection {
    const pinned: AiSessionViewModel[] = [];
    const unpinned: AiSessionViewModel[] = [];
    for (const provider of selectedProviders) {
        for (const session of sessionsByProvider[provider] || []) {
            (session.pinned ? pinned : unpinned).push({ ...session, provider });
        }
    }
    return { pinned, unpinned };
}
```

- [ ] **Step 5: Extend the Webview surface and render the menu**

Add `selectedAiSessionProviders?: AiSessionProviderId[]` to `Project`. Add both
`selectedAiSessionProviders?: AiSessionProviderId[]` and
`providers?: AiSessionProviderSummary[]` to `AiSessionSurfaceViewModel`. Map
`aiSessions.selectedProviders` and `aiSessions.providers` in
`getWorkspaceAiSessionSurface`. For legacy `Project` inputs, synthesize the
three provider summaries from the existing arrays and unavailable flags before
rendering the menu.

Replace the native select with:

```ts
function getAiProviderOption(
    provider: AiSessionProviderSummary,
    selectedProviders: readonly AiSessionProviderId[],
): string {
    const selected = selectedProviders.includes(provider.id);
    const unavailable = provider.unavailable === true;
    return `<button type="button" role="menuitemcheckbox"
        class="ai-session-provider-option"
        data-ai-provider-option data-provider="${provider.id}"
        aria-checked="${selected}"
        aria-disabled="${selected && selectedProviders.length === 1}"
        ${unavailable ? 'data-provider-unavailable' : ''}>
        <span class="ai-session-provider-check" aria-hidden="true">${selected ? '✓' : ''}</span>
        <span>${escapeAttribute(provider.label)}</span>
        <span class="ai-session-provider-count">${provider.count}</span>
        ${unavailable ? '<span class="ai-session-provider-unavailable">Unavailable</span>' : ''}
    </button>`;
}
```

Render a trigger with `aria-haspopup="menu"` and `aria-expanded="false"`.
Render the popup with `role="menu"` and `hidden`. Put the comma-separated
normalized provider order on `data-selected-ai-session-providers`.

Render history using `projectAiSessionHistory`. Emit one `PINNED` heading only
when `projection.pinned.length > 0`, then render all unpinned rows directly.
Add a lightweight provider badge to every history row. Do not emit provider
headings or provider containers.

- [ ] **Step 6: Add compact styles and regenerate artifacts**

Add scoped SCSS for the trigger, absolute popup, options, checked/focus states,
provider badge, pinned heading, unified empty state, narrow width, and forced
colors. Keep existing 26px/21px circular icon sizes.

Run:

```bash
npx gulp --production
```

Expected: `media/styles.css` and `media/webviewProjectScripts.js` are regenerated
without errors.

- [ ] **Step 7: Run focused verification**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/historyProjection.test.js
node --test tests/integration/dashboard/webviewState.test.js
node --test tests/integration/dashboard/styles.test.js
node scripts/run-ai-session-safety-checks.js
git diff --check
```

Expected: all commands pass; HTML order matches pinned-first/provider-adjacent
projection; SCSS and CSS match.

- [ ] **Step 8: Commit**

```bash
git add src/aiSessions/historyProjection.ts \
  src/models.ts \
  src/webview/webviewContent.ts \
  media/styles.scss media/styles.css \
  tests/unit/aiSessions/historyProjection.test.js \
  tests/integration/dashboard/webviewState.test.js \
  tests/integration/dashboard/styles.test.js \
  scripts/run-ai-session-safety-checks.js
git commit -m "feat: render selected provider session history"
```

---

### Task 3: Add accessible provider-menu interaction and host updates

**Files:**
- Modify: `src/aiSessions/commandController.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/webviewProjectScripts.js`
- Create: `tests/browser/sessionProviderMenu.test.js`
- Modify: `tests/contract/aiSessions/controllerBoundaries.test.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`

**Interfaces:**
- Consumes the normalized store and menu attributes from Tasks 1 and 2.
- Replaces `selectProvider(projectId, providerId)` with:

```ts
selectProviders(projectId: string, providerIds: unknown): Promise<void>;
```

- Adds one Webview message:

```text
type: select-ai-session-providers
projectId: string
selectedProviders: unknown
```

- Produces browser behavior for opening, closing, keyboard navigation, and
  at-least-one enforcement.

- [ ] **Step 1: Write controller and browser tests**

Update the controller-boundary fixture to provide:

```js
setProviderSelection: async (scope, selection) =>
    effects.push(['providers', scope, selection]),
```

Call:

```js
await controller.selectProviders('project', ['codex', 'claude']);
await controller.selectProviders('project', []);
await controller.selectProviders('missing', ['codex']);
```

Expect only the valid project/nonempty call to persist and refresh.

Create `tests/browser/sessionProviderMenu.test.js` using
`playwright-chromium`, the real rendered Sessions panel, and
`src/webview/webviewProjectScripts.js`. Assert:

```js
await trigger.click();
assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
await page.locator('[data-ai-provider-option][data-provider="claude"]').click();
assert.deepEqual(await page.evaluate(() => window.__postedMessages.at(-1)), {
    type: 'select-ai-session-providers',
    projectId: 'project-a',
    selectedProviders: ['codex', 'claude'],
});
```

With only Codex selected, assert the Codex option is `aria-disabled="true"` and
clicking or pressing Space posts no empty selection. Assert Arrow Down moves
focus and Escape closes the menu and restores trigger focus.

- [ ] **Step 2: Run tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/controllerBoundaries.test.js
node --test tests/browser/sessionProviderMenu.test.js
```

Expected: the controller has no `selectProviders` method and the Webview has no
popup interaction.

- [ ] **Step 3: Implement the host command**

Change `AiSessionCommandControllerOptions` to accept:

```ts
setProviderSelection: (
    workspaceScopeIdentity: string,
    selection: AiSessionProviderSelection
) => Thenable<unknown>;
```

Implement:

```ts
async selectProviders(projectId: string, providerIds: unknown): Promise<void> {
    if (!Array.isArray(providerIds) || providerIds.length === 0) {
        return;
    }
    const target = this.options.getWorkspaceTarget(projectId);
    if (!target) {
        return;
    }
    const normalized = normalizeAiSessionProviderSelection({
        registeredProviders: target.sessions.providers.map(provider => provider.id),
        primaryProvider: target.sessions.activeProvider,
        selectedProviders: providerIds,
        sessionCounts: Object.fromEntries(
            target.sessions.providers.map(provider => [provider.id, provider.count])
        ),
    });
    await this.options.setProviderSelection(
        target.workspace.scopeIdentity,
        normalized
    );
    this.options.refresh();
}
```

Route `select-ai-session-providers` in `src/dashboard.ts` and wire
`setProviderSelection` to the workspace state store.

- [ ] **Step 4: Implement popup interaction**

In `src/webview/webviewProjectScripts.js`, add:

```js
function getSelectedAiSessionProviders(projectDiv) {
    var region = projectDiv && projectDiv.querySelector('[data-ai-session-region]');
    return (region && region.getAttribute('data-selected-ai-session-providers') || '')
        .split(',')
        .filter(isAiSessionProvider);
}

function submitAiSessionProviderSelection(projectDiv, providers) {
    var projectId = projectDiv && projectDiv.getAttribute('data-id');
    if (!projectId || !providers.length || batchAiSessionState.pending)
        return;
    exitAiSessionBatchManagement();
    window.vscode.postMessage({
        type: 'select-ai-session-providers',
        projectId,
        selectedProviders: providers,
    });
}
```

Open and close the popup by toggling `hidden` and `aria-expanded`. On option
activation, preserve current order when removing, and append a newly selected
provider; refuse a removal that would produce an empty array. Handle Arrow
Up/Down, Home/End, Space, Enter, Escape, focus restoration, and outside click.
Close any other workspace's provider popup before opening a new one.

- [ ] **Step 5: Regenerate and run browser verification**

Run:

```bash
npx gulp --production
npm run test-compile
node --test tests/contract/aiSessions/controllerBoundaries.test.js
node --test tests/browser/sessionProviderMenu.test.js
node --test tests/integration/dashboard/webviewState.test.js
```

Expected: all tests pass, the last provider cannot be removed, and the posted
message always contains at least one valid provider.

- [ ] **Step 6: Commit**

```bash
git add src/aiSessions/commandController.ts \
  src/dashboard.ts \
  src/webview/webviewProjectScripts.js \
  media/webviewProjectScripts.js \
  tests/browser/sessionProviderMenu.test.js \
  tests/contract/aiSessions/controllerBoundaries.test.js \
  tests/integration/dashboard/webviewState.test.js
git commit -m "feat: select multiple AI session providers"
```

---

### Task 4: Make batch management cross-provider

**Files:**
- Create: `src/aiSessions/archiveBatchAcrossProviders.ts`
- Modify: `src/aiSessions/archiveController.ts`
- Modify: `src/aiSessions/types.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/webviewProjectScripts.js`
- Modify: `tests/contract/aiSessions/archiveAndHydration.test.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes selected providers from the authoritative workspace target.
- Produces:

```ts
export interface AiSessionArchiveItem {
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface AggregateAiSessionArchiveResult {
    archived: AiSessionArchiveItem[];
    running: AiSessionArchiveItem[];
    missing: AiSessionArchiveItem[];
    rejected: AiSessionArchiveItem[];
    rejectedCount: number;
    failed: AiSessionArchiveItem[];
    malformedCount: number;
}
```

- Replaces the provider-scoped request with:

```text
type: archive-ai-sessions
projectId: string
items: Array<{ provider, sessionId }>
```

- Changes batch Webview selection to composite keys and keeps the existing
  single completion-message/final-refresh boundary.

- [ ] **Step 1: Write aggregate archive tests**

Add tests covering two providers with the same session ID:

```js
const selection = resolveAggregateAiSessionArchiveSelection(
    [
        { provider: 'codex', sessionId: 'same' },
        { provider: 'claude', sessionId: 'same' },
        { provider: 'unknown', sessionId: 'same' },
        { provider: 'codex', sessionId: '' },
    ],
    {
        selectedProviders: ['codex', 'claude'],
        sessionsByProvider: {
            codex: [{ id: 'same', provider: 'codex' }],
            claude: [{ id: 'same', provider: 'claude', pinned: true }],
        },
    }
);
assert.deepEqual(selection.eligible.map(item => item.provider), ['codex', 'claude']);
assert.equal(selection.rejectedCount, 1);
assert.equal(selection.malformedCount, 1);
```

Test request execution with Codex archived and Claude failed. Assert one
confirmation with `eligibleCount: 2`, `pinnedCount: 1`, one completion
containing both composite results, and exactly one refresh.

Extend the Webview-state test so `All` selects unpinned/inactive rows from
Codex and Claude, skips a pinned row and an active row, and submits composite
items.

- [ ] **Step 2: Run tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/archiveAndHydration.test.js
node --test tests/integration/dashboard/webviewState.test.js
```

Expected: aggregate resolver is missing and the current manager scopes
selection to one provider.

- [ ] **Step 3: Implement aggregate validation**

Create `src/aiSessions/archiveBatchAcrossProviders.ts`. Reuse the existing
request limit and ID-length limit. Validate object shape, registered/selected
provider scope, session ID length, composite deduplication, and authoritative
history membership.

Use an unambiguous composite key:

```ts
export function getAiSessionArchiveItemKey(item: AiSessionArchiveItem): string {
    return JSON.stringify([item.provider, item.sessionId]);
}
```

Return eligible items with their authoritative `session` so pinned count does
not trust the Webview.

- [ ] **Step 4: Add one aggregate controller operation**

Replace `archiveSessions(projectId, providerId, sessionIds)` with:

```ts
async archiveSessions(projectId: string, items: unknown): Promise<void>
```

After the runtime guard, resolve one workspace target and validate against:

```ts
{
    selectedProviders: target.sessions.selectedProviders,
    sessionsByProvider: target.sessions.sessionsByProvider,
}
```

Confirm once:

```text
Archive <n> selected AI sessions? <p> selected session(s) are pinned.
```

Execute eligible items in their normalized order with:

```ts
this.archiveSessionItem(item.provider, item.sessionId)
```

Catch per-item exceptions as failures, report/log bounded composite results,
post one completion, call `refresh()` once after execution, and call
`syncActiveRuntime()` once.

- [ ] **Step 5: Convert the Webview batch manager to composite identity**

Replace `provider` plus `selectedIds` with a `selectedItems` map keyed by:

```js
function getAiSessionBatchItemKey(provider, sessionId) {
    return JSON.stringify([provider, sessionId]);
}
```

Entering management scopes only to `projectId`. `selectUnpinned` scans every
visible history row, skips `data-session-pinned` and `data-session-active`, and
adds `{ provider, sessionId }`. Manual checkbox toggling may add pinned rows but
never active rows.

Submit:

```js
window.vscode.postMessage({
    type: 'archive-ai-sessions',
    projectId: batchAiSessionState.projectId,
    items: Array.from(batchAiSessionState.selectedItems.values()),
});
```

Disable the provider menu while `pending`. On completion, exit management after
`finished`; on `cancelled` or `rejected`, clear pending without discarding the
visible selection.

- [ ] **Step 6: Update message types, safety checks, and focused tests**

Update `AiSessionBatchArchiveCompletedMessage` to remove the single provider
and carry aggregate results. Route `e.items` in `src/dashboard.ts`.

Run:

```bash
npx gulp --production
npm run test-compile
node --test tests/contract/aiSessions/archiveAndHydration.test.js
node --test tests/integration/dashboard/webviewState.test.js
node scripts/run-ai-session-safety-checks.js
git diff --check
```

Expected: cross-provider ID collisions remain distinct; `All` skips pinned and
active rows; partial failure produces one completion and one refresh.

- [ ] **Step 7: Commit**

```bash
git add src/aiSessions/archiveBatchAcrossProviders.ts \
  src/aiSessions/archiveController.ts \
  src/aiSessions/types.ts \
  src/dashboard.ts \
  src/webview/webviewProjectScripts.js \
  media/webviewProjectScripts.js \
  tests/contract/aiSessions/archiveAndHydration.test.js \
  tests/integration/dashboard/webviewState.test.js \
  scripts/run-ai-session-safety-checks.js
git commit -m "feat: archive sessions across AI providers"
```

---

### Task 5: Register behavior coverage, verify, package, and install

**Files:**
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes all four implementation commits and the existing circular-icon fix
  commit `990c2ef58ed185ecfa50ebc213ef7c5f44c1d807`.
- Produces auditable behavior ownership, a clean complete CI result, release
  VSIX artifacts, and an installed main extension in the active VS Code host.

- [ ] **Step 1: Register behavior contracts**

Add:

```json
{
  "id": "WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001",
  "domain": "webview",
  "title": "Sessions renders an accessible pinned-first multi-provider history",
  "priority": "P1",
  "status": "automated",
  "owners": [
    "tests/unit/aiSessions/providerSelection.test.js",
    "tests/unit/aiSessions/historyProjection.test.js",
    "tests/integration/dashboard/webviewState.test.js",
    "tests/browser/sessionProviderMenu.test.js"
  ],
  "evidence": [
    "src/aiSessions/providerSelection.ts",
    "src/aiSessions/historyProjection.ts",
    "src/webview/webviewContent.ts",
    "src/webview/webviewProjectScripts.js"
  ]
}
```

Add:

```json
{
  "id": "PERSIST-MULTI-PROVIDER-BATCH-ARCHIVE-001",
  "domain": "persistence",
  "title": "Batch archive validates and executes composite sessions across providers",
  "priority": "P1",
  "status": "automated",
  "owners": [
    "tests/contract/aiSessions/archiveAndHydration.test.js",
    "tests/integration/dashboard/webviewState.test.js"
  ],
  "evidence": [
    "src/aiSessions/archiveBatchAcrossProviders.ts",
    "src/aiSessions/archiveController.ts",
    "scripts/run-ai-session-safety-checks.js"
  ]
}
```

- [ ] **Step 2: Update the main capability audit**

Run:

```bash
git log --reverse --format='%H %s' 3b86a429fd29edbcc076db2a5e02e7a46bdd5cc1..HEAD
```

Update `MAIN-RUNTIME-SESSION-RECOVERY`:

- append `990c2ef58ed185ecfa50ebc213ef7c5f44c1d807`;
- append each implementation commit produced by Tasks 1–4;
- add `WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001`;
- add `PERSIST-MULTI-PROVIDER-BATCH-ARCHIVE-001`.

Set `audit.head` to the Task 4 implementation commit. Add every documentation-
only commit between the old audit head and the new head to
`ignoredDocumentationCommits`, including the prior Active Session audit, this
feature's design commit, and this implementation-plan commit. Use the full
hashes printed by the command; do not abbreviate them.

- [ ] **Step 3: Run behavior, deterministic, browser, and safety verification**

Run:

```bash
npm run test:behavior-contracts
npm run test:deterministic
npm run test:browser
npm run test:dashboard
npm run test:safety
git diff --check
```

Expected: every command exits 0 and both new behavior IDs are discoverable.

- [ ] **Step 4: Commit the audit**

```bash
git add docs/testing/behavior-contracts.json \
  docs/testing/main-capability-coverage.json
git commit -m "docs: audit multi-provider session coverage"
```

- [ ] **Step 5: Run complete verification from the final commit**

Run:

```bash
npm run test:ci:linux
git status --short
git log -7 --oneline
```

Expected:

- complete Linux CI exits 0;
- unit, contract, integration, browser, safety, Dashboard, architecture,
  release packaging, and coverage gates pass;
- release packaging produces the main and UI bridge VSIX files;
- the feature worktree is clean; and
- four implementation commits and one audit commit follow the design and plan
  commits.

- [ ] **Step 6: Build and install through the repository workflow**

Follow `.codex/skills/installing-vscode-extensions-locally/SKILL.md`. Inspect
the active host before installation:

```bash
env | rg '^(REMOTE_CONTAINERS|CODESPACES|SSH_CONNECTION|VSCODE_IPC_HOOK_CLI)='
which -a code
code --version
```

Then run:

```bash
SKIP_NPM_CI=1 npm run install-local
```

If the UI-only bridge cannot install inside a Dev Container, report that
environment limitation and install the main workspace extension VSIX with the
verified active remote CLI:

```bash
code --install-extension artifacts/project-steward-2.1.6.vsix --force
```

Verify:

```bash
code --list-extensions --show-versions | rg '^hzcheng\\.project-steward@'
unzip -p artifacts/project-steward-2.1.6.vsix extension/media/styles.css | sha256sum
sha256sum /home/hzcheng/.vscode-server/extensions/hzcheng.project-steward-2.1.6/media/styles.css
```

Expected: `hzcheng.project-steward@2.1.6` is listed and installed CSS has the
same hash as the packaged VSIX. Reload the active VS Code window before manual
testing.
