# Sharingan Running Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four independently selectable, authentic Mangekyō Sharingan running-card animations that replace and rotate the workspace project-kind icon.

**Architecture:** Extend the existing bounded `data-session-fx` configuration and renderer contract with four values. Bundle unmodified, checksum-pinned Wikimedia Commons SVGs as licensed media assets, then let SCSS overlay the selected image on the existing project icon so full and incremental Webview paths need no new protocol or DOM structure.

**Tech Stack:** TypeScript, VS Code contribution configuration, HTML string rendering, SCSS/CSS, Node.js test runner and assertion scripts, Gulp, VSIX ZIP verification.

## Global Constraints

- The setting values are exactly `sharingan-itachi`, `sharingan-obito-kakashi`, `sharingan-sasuke`, and `sharingan-shisui`.
- Existing `current`, `sweep`, `orbit`, `halo`, `ripple`, `breath`, and `none` behavior remains unchanged.
- A selected Sharingan rotates linearly once every 1.8 seconds while the existing card is running.
- CURRENT WORKSPACE and an already-running OTHER WINDOWS navigation card follow the same activation scope as `halo`; do not add session, provider, or bridge data.
- `prefers-reduced-motion: reduce` keeps the selected eye visible and disables only its rotation.
- Bundle the four selected upstream SVG files unmodified and select CC BY-SA 3.0 for all four.
- Keep each SVG's license separate from the project's MIT license and package `THIRD_PARTY_NOTICES.md` in the VSIX.
- Keep the ordinary project-kind SVG under the overlay so a missing image visually falls back to the ordinary icon.
- SCSS is the source of truth; regenerate `media/styles.css` with Gulp and never edit the generated file independently.
- The approved design source of truth is `docs/superpowers/specs/2026-07-25-sharingan-running-animation-design.md`.

---

## File structure

- `src/webview/webviewContent.ts`
  - Owns the bounded allowlist that normalizes configured running-card effects.
- `package.json`
  - Exposes the four new machine-scoped setting values and character-specific descriptions.
- `README.md`
  - Documents all supported values and links third-party attribution.
- `scripts/run-dashboard-webview-checks.js`
  - Proves full renderer and all incremental message builders preserve the new values for current and navigation cards.
- `scripts/run-ai-session-safety-checks.js`
  - Locks the exact setting enum/descriptions and controller/full-render propagation.
- `scripts/run-open-project-safety-checks.js`
  - Locks open-workspace controller propagation and message de-duplication when only a Sharingan selection changes.
- `media/sharingan/*.svg`
  - Stores the four unmodified, checksum-pinned third-party SVG assets.
- `THIRD_PARTY_NOTICES.md`
  - Records source, author, selected license, bundled path, and modification status.
- `tests/unit/tooling/sharinganAssets.test.js`
  - Verifies each bundled byte stream against its reviewed upstream SHA-256 and checks attribution coverage.
- `media/styles.scss`
  - Maps `data-session-fx` values to assets, overlays and rotates the selected image, preserves fallback, and disables rotation for reduced motion.
- `media/styles.css`
  - Generated, minified CSS artifact.
- `tests/integration/dashboard/styles.test.js`
  - Verifies compiled mappings, geometry, hover behavior, animation timing, reduced motion, and generated CSS parity.
- `scripts/run-release-packaging-checks.js`
  - Requires the notice and all four assets in the exact reviewed VSIX contents and compares packaged bytes to source bytes.

---

### Task 1: Extend the running-animation configuration and renderer contract

**Files:**
- Modify: `src/webview/webviewContent.ts:24-39`
- Modify: `package.json:164-183`
- Modify: `README.md:175-186`
- Modify: `scripts/run-dashboard-webview-checks.js:285-365, 485-520, 600-635`
- Modify: `scripts/run-ai-session-safety-checks.js:5260-5310, 5447-5560, 7060-7140`
- Modify: `scripts/run-open-project-safety-checks.js:1980-2060`

**Interfaces:**
- Consumes: `runningCardAnimation?: string` already passed through full render, workspace updates, open-workspace updates, and AI-session updates.
- Produces: normalized `data-session-fx` values for all four Sharingan settings without changing any message type or function signature.

- [ ] **Step 1: Add failing renderer and propagation assertions**

In `scripts/run-dashboard-webview-checks.js`, expand the accepted renderer loop:

```js
for (const animation of [
    'current',
    'sweep',
    'orbit',
    'halo',
    'sharingan-itachi',
    'sharingan-obito-kakashi',
    'sharingan-sasuke',
    'sharingan-shisui',
    'ripple',
    'breath',
]) {
    const animationHtml = webviewContent.getCurrentWorkspaceGroupContent(
        runningCard,
        false,
        animation,
    );
    assert.ok(animationHtml.includes(`data-session-fx="${animation}"`),
        `the current workspace card must accept the ${animation} running animation`);
    assert.ok(animationHtml.includes('<div class="project-session-fx"></div>'));
}
```

Use the new values in the existing incremental-message fixtures:

```js
const aiMessage = dashboardUpdateMessages.buildAiSessionsUpdatedMessage({
    groups: [],
    cards: [workspaceCard],
    sequence: 7,
    generatedAt: '2026-07-17T00:00:00.000Z',
    todoSearchItems,
    runningCardAnimation: 'sharingan-itachi',
});
const workspaceMessage = dashboardUpdateMessages.buildWorkspaceUpdatedMessage({
    card: workspaceCard,
    runningCardAnimation: 'sharingan-sasuke',
});
const openWorkspacesMessage = dashboardUpdateMessages.buildOpenWorkspacesUpdatedMessage({
    groups: [],
    cards: [workspaceCard, navigationCard],
    collapsed: false,
    semanticRevision: 'b'.repeat(64),
    otherWindowsStatus: 'ready',
    todoSearchItems,
    runningCardAnimation: 'sharingan-obito-kakashi',
});

assert.ok(aiMessage.html.includes('data-session-fx="sharingan-itachi"'));
assert.ok(workspaceMessage.html.includes('data-session-fx="sharingan-sasuke"'));
assert.ok(openWorkspacesMessage.html.includes(
    'data-session-fx="sharingan-obito-kakashi"'
));
```

Change the existing running navigation-card fixture to:

```js
const workspaceHtml = webviewContent.getOpenWorkspacesGroupContent(
    [makeWorkspaceCardFixture(3), navigationCard],
    false,
    'ready',
    'sharingan-shisui',
);
const otherWindowsHtml = workspaceHtml.slice(workspaceHtml.indexOf('OTHER WINDOWS'));
assert.ok(otherWindowsHtml.includes('data-session-fx="sharingan-shisui"'));
```

In `scripts/run-ai-session-safety-checks.js`, replace the exact setting
expectation with:

```js
const runningAnimation = packageJson.contributes.configuration.properties[
    'projectSteward.aiSessionRunningCardAnimation'
];
assert.deepStrictEqual(runningAnimation.enum, [
    'current',
    'sweep',
    'orbit',
    'halo',
    'sharingan-itachi',
    'sharingan-obito-kakashi',
    'sharingan-sasuke',
    'sharingan-shisui',
    'ripple',
    'breath',
    'none',
]);
assert.deepStrictEqual(runningAnimation.enumDescriptions.slice(4, 8), [
    "Itachi Uchiha's Mangekyo Sharingan replaces and rotates over the project kind icon.",
    "Obito Uchiha and Kakashi Hatake's Mangekyo Sharingan replaces and rotates over the project kind icon.",
    "Sasuke Uchiha's Mangekyo Sharingan replaces and rotates over the project kind icon.",
    "Shisui Uchiha's Mangekyo Sharingan replaces and rotates over the project kind icon.",
]);
assert.strictEqual(
    runningAnimation.description,
    'Animation shown on a workspace card while one or more AI sessions are executing. '
        + 'OTHER WINDOWS uses only its existing aggregate running state and does not '
        + 'expose provider or session identities.',
);
```

Change `runCurrentWorkspaceRenderingChecks()` to:

```js
const config = {
    get: (key, defaultValue) =>
        key === 'aiSessionRunningCardAnimation' ? 'sharingan-itachi' : defaultValue,
    displayProjectPath: false,
    searchIsActiveByDefault: false,
    showAddGroupButtonTile: false,
};
// ...existing full render...
assert.ok(currentTags[0].includes('data-session-fx="sharingan-itachi"'));
```

In the AI-session controller de-duplication check, use these exact values and
assertions:

```js
let runningCardAnimation = 'sharingan-itachi';
// ...first refresh...
assert.ok(messages[0].html.includes('data-session-fx="sharingan-itachi"'));

runningCardAnimation = 'sharingan-obito-kakashi';
// ...next refresh...
assert.ok(messages[1].html.includes(
    'data-session-fx="sharingan-obito-kakashi"'
));
```

In `scripts/run-open-project-safety-checks.js`, make its open-workspace
controller de-duplication fixture use:

```js
let runningCardAnimation = 'sharingan-shisui';
// ...first post...
assert.ok(posted[0].html.includes('data-session-fx="sharingan-shisui"'));

runningCardAnimation = 'sharingan-sasuke';
// ...next post...
assert.ok(posted[1].html.includes('data-session-fx="sharingan-sasuke"'));
```

- [ ] **Step 2: Run focused checks and verify RED**

Run:

```bash
npm run test-compile
node scripts/run-dashboard-webview-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-open-project-safety-checks.js
```

Expected: the dashboard check fails because each `sharingan-*` value
normalizes to `current`, and the safety check fails because the setting enum
still contains only the seven existing values.

- [ ] **Step 3: Add the four values to the renderer allowlist**

In `src/webview/webviewContent.ts`, replace the allowlist with:

```ts
const AI_SESSION_RUNNING_CARD_ANIMATIONS = new Set([
    'current',
    'sweep',
    'orbit',
    'halo',
    'sharingan-itachi',
    'sharingan-obito-kakashi',
    'sharingan-sasuke',
    'sharingan-shisui',
    'ripple',
    'breath',
    'none',
]);
```

Do not change `normalizeRunningCardAnimation`, renderer signatures, message
builders, controllers, or bridge data. Their existing generic string flow is
the behavior under test.

- [ ] **Step 4: Expose the setting values and descriptions**

Replace the relevant `package.json` enum and descriptions with:

```json
"enum": [
    "current",
    "sweep",
    "orbit",
    "halo",
    "sharingan-itachi",
    "sharingan-obito-kakashi",
    "sharingan-sasuke",
    "sharingan-shisui",
    "ripple",
    "breath",
    "none"
],
"enumDescriptions": [
    "Electric currents flow along the top and bottom card edges.",
    "A diagonal light beam sweeps across the card periodically.",
    "A glowing dot with a comet tail orbits along the card edge.",
    "A rotating glowing halo surrounds the project kind icon.",
    "Itachi Uchiha's Mangekyo Sharingan replaces and rotates over the project kind icon.",
    "Obito Uchiha and Kakashi Hatake's Mangekyo Sharingan replaces and rotates over the project kind icon.",
    "Sasuke Uchiha's Mangekyo Sharingan replaces and rotates over the project kind icon.",
    "Shisui Uchiha's Mangekyo Sharingan replaces and rotates over the project kind icon.",
    "Sonar ripples expand from the project kind icon.",
    "The whole card glow breathes softly.",
    "No animation; only a static tinted border."
],
"description": "Animation shown on a workspace card while one or more AI sessions are executing. OTHER WINDOWS uses only its existing aggregate running state and does not expose provider or session identities."
```

Update the README setting bullet to enumerate the four exact new values:

```markdown
- `projectSteward.aiSessionRunningCardAnimation`: animation shown on a workspace card while an AI session executes: `current` (default), `sweep`, `orbit`, `halo`, `sharingan-itachi`, `sharingan-obito-kakashi`, `sharingan-sasuke`, `sharingan-shisui`, `ripple`, `breath`, or `none`.
```

- [ ] **Step 5: Run focused checks and verify GREEN**

Run:

```bash
npm run test-compile
node scripts/run-dashboard-webview-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-open-project-safety-checks.js
git diff --check
```

Expected: all commands exit 0; unknown settings still normalize to `current`,
and `none` still omits `.project-session-fx`.

- [ ] **Step 6: Commit Task 1**

```bash
git add \
  src/webview/webviewContent.ts \
  package.json \
  README.md \
  scripts/run-dashboard-webview-checks.js \
  scripts/run-ai-session-safety-checks.js \
  scripts/run-open-project-safety-checks.js
git commit -m "feat: add Sharingan running animation settings"
```

---

### Task 2: Bundle checksum-pinned authentic SVGs and attribution

**Files:**
- Create: `media/sharingan/mangekyou-sharingan-itachi.svg`
- Create: `media/sharingan/mangekyou-sharingan-obito-kakashi.svg`
- Create: `media/sharingan/mangekyou-sharingan-sasuke.svg`
- Create: `media/sharingan/mangekyou-sharingan-shisui.svg`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `tests/unit/tooling/sharinganAssets.test.js`
- Modify: `README.md:260-266`

**Interfaces:**
- Consumes: the four reviewed Wikimedia Commons original-file URLs and CC BY-SA 3.0 terms.
- Produces: four local immutable media paths consumed by SCSS and a packaged attribution document.

- [ ] **Step 1: Add a failing asset-integrity test**

Create `tests/unit/tooling/sharinganAssets.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const assets = [
    {
        name: 'Itachi',
        file: 'media/sharingan/mangekyou-sharingan-itachi.svg',
        sha256: '230f3a336593fd37e76b45f799ea9a131d8ccb55596f0c10786af3653bfd6545',
        source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Itachi.svg',
    },
    {
        name: 'Obito and Kakashi',
        file: 'media/sharingan/mangekyou-sharingan-obito-kakashi.svg',
        sha256: 'b79b7530aee85e94de533c4e37c1e62bda6b175e5febba68803e51e31b3563af',
        source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Kakashi.svg',
    },
    {
        name: 'Sasuke',
        file: 'media/sharingan/mangekyou-sharingan-sasuke.svg',
        sha256: '89c58267e340231a6034efc2b6fdde03eb9a9534176dd619cb414736930aea52',
        source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Sasuke.svg',
    },
    {
        name: 'Shisui',
        file: 'media/sharingan/mangekyou-sharingan-shisui.svg',
        sha256: '10c540d932e9546afaf07f8a59b117ffd3346cb89febe2a5a810bf2d33dff377',
        source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Shisui.svg',
    },
];

for (const asset of assets) {
    test(`SHARINGAN-ASSET-INTEGRITY-001 preserves the reviewed ${asset.name} SVG`, () => {
        const bytes = fs.readFileSync(path.join(root, asset.file));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256);
        assert.match(bytes.toString('utf8'), /<svg[\s>]/);
    });
}

test('SHARINGAN-ASSET-ATTRIBUTION-001 attributes every bundled SVG', () => {
    const notice = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(notice, /Creative Commons Attribution-ShareAlike 3\.0/);
    assert.match(notice, /ShounenSuki/);
    for (const asset of assets) {
        assert.ok(notice.includes(asset.file), `missing bundled path ${asset.file}`);
        assert.ok(notice.includes(asset.source), `missing source ${asset.source}`);
    }
});
```

- [ ] **Step 2: Run the integrity test and verify RED**

Run:

```bash
node --test tests/unit/tooling/sharinganAssets.test.js
```

Expected: FAIL with `ENOENT` because the first reviewed SVG is not bundled yet.

- [ ] **Step 3: Download the exact reviewed upstream originals**

Run:

```bash
mkdir -p media/sharingan
curl -fsSL \
  https://upload.wikimedia.org/wikipedia/commons/1/17/Mangekyou_Sharingan_Itachi.svg \
  -o media/sharingan/mangekyou-sharingan-itachi.svg
curl -fsSL \
  https://upload.wikimedia.org/wikipedia/commons/4/40/Mangekyou_Sharingan_Kakashi.svg \
  -o media/sharingan/mangekyou-sharingan-obito-kakashi.svg
curl -fsSL \
  https://upload.wikimedia.org/wikipedia/commons/7/7a/Mangekyou_Sharingan_Sasuke.svg \
  -o media/sharingan/mangekyou-sharingan-sasuke.svg
curl -fsSL \
  https://upload.wikimedia.org/wikipedia/commons/b/bc/Mangekyou_Sharingan_Shisui.svg \
  -o media/sharingan/mangekyou-sharingan-shisui.svg
sha256sum media/sharingan/*.svg
```

Expected hashes, paired with their file names:

```text
230f3a336593fd37e76b45f799ea9a131d8ccb55596f0c10786af3653bfd6545  mangekyou-sharingan-itachi.svg
b79b7530aee85e94de533c4e37c1e62bda6b175e5febba68803e51e31b3563af  mangekyou-sharingan-obito-kakashi.svg
89c58267e340231a6034efc2b6fdde03eb9a9534176dd619cb414736930aea52  mangekyou-sharingan-sasuke.svg
10c540d932e9546afaf07f8a59b117ffd3346cb89febe2a5a810bf2d33dff377  mangekyou-sharingan-shisui.svg
```

Do not format, optimize, rename XML IDs, or otherwise modify the downloaded
bytes.

- [ ] **Step 4: Add the complete third-party notice**

Create `THIRD_PARTY_NOTICES.md` with:

```markdown
# Third-Party Notices

Project Steward includes the following unmodified SVG files authored by
ShounenSuki, sourced from Narutopedia through Wikimedia Commons, and
distributed under the
[Creative Commons Attribution-ShareAlike 3.0 Unported license](https://creativecommons.org/licenses/by-sa/3.0/).

| Bundled file | Original source |
| --- | --- |
| `media/sharingan/mangekyou-sharingan-itachi.svg` | https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Itachi.svg |
| `media/sharingan/mangekyou-sharingan-obito-kakashi.svg` | https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Kakashi.svg |
| `media/sharingan/mangekyou-sharingan-sasuke.svg` | https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Sasuke.svg |
| `media/sharingan/mangekyou-sharingan-shisui.svg` | https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Shisui.svg |

The files are distributed without modification. The Project Steward source
code remains licensed under the repository's MIT license; the files listed
above remain licensed under CC BY-SA 3.0.

Naruto and its character names and designs are property of their respective
rights holders. Their inclusion does not imply endorsement.
```

Append this README acknowledgement:

```markdown
- Mangekyō Sharingan running-animation assets are attributed in [Third-Party Notices](THIRD_PARTY_NOTICES.md).
```

- [ ] **Step 5: Run the integrity test and verify GREEN**

Run:

```bash
node --test tests/unit/tooling/sharinganAssets.test.js
git diff --check
```

Expected: five tests pass and every expected checksum matches.

- [ ] **Step 6: Commit Task 2**

```bash
git add \
  media/sharingan \
  THIRD_PARTY_NOTICES.md \
  tests/unit/tooling/sharinganAssets.test.js \
  README.md
git commit -m "feat: bundle licensed Sharingan animation assets"
```

---

### Task 3: Overlay and rotate the selected eye with accessible motion behavior

**Files:**
- Modify: `media/styles.scss:2436-2570, 3619-3705, 3835-3855`
- Modify: `tests/integration/dashboard/styles.test.js`
- Generate: `media/styles.css`
- Modify: `scripts/run-ai-session-safety-checks.js:5260-5280`

**Interfaces:**
- Consumes: the four `data-session-fx` values from Task 1 and local asset paths from Task 2.
- Produces: one shared `steward-session-running-sharingan` keyframe and four exact CSS background-image mappings.

- [ ] **Step 1: Add failing compiled-style assertions**

Add this helper and test to `tests/integration/dashboard/styles.test.js`:

```js
const sharinganAssets = [
    ['sharingan-itachi', 'sharingan/mangekyou-sharingan-itachi.svg'],
    ['sharingan-obito-kakashi', 'sharingan/mangekyou-sharingan-obito-kakashi.svg'],
    ['sharingan-sasuke', 'sharingan/mangekyou-sharingan-sasuke.svg'],
    ['sharingan-shisui', 'sharingan/mangekyou-sharingan-shisui.svg'],
];

function findSharinganRule(source, mode) {
    const matches = cssRules(source).filter(rule => rule.selectors.some(selector =>
        (
            selector.includes(`[data-session-fx="${mode}"]`)
            || selector.includes(`[data-session-fx=${mode}]`)
        )
        && selector.endsWith('.project-kind-icon::after')));
    assert.equal(matches.length, 1,
        `SHARINGAN-RUNNING-ANIMATION-001 expected one rule for ${mode}`);
    return matches[0];
}

function findSharinganSharedRule(source, suffix) {
    const matches = cssRules(source).filter(rule => rule.selectors.some(selector =>
        (
            selector.includes('[data-session-fx^="sharingan-"]')
            || selector.includes('[data-session-fx^=sharingan-]')
        )
        && selector.endsWith(suffix)));
    assert.equal(matches.length, 1,
        `SHARINGAN-RUNNING-ANIMATION-001 expected one shared rule for ${suffix}`);
    return matches[0];
}

function validateSharinganAnimations(source) {
    for (const [mode, asset] of sharinganAssets) {
        assertDeclarations(findSharinganRule(source, mode),
            'SHARINGAN-RUNNING-ANIMATION-001', [`background-image: url("${asset}")`]);
    }
    assertDeclarations(findSharinganSharedRule(source, '.project-kind-icon::after'),
        'SHARINGAN-RUNNING-ANIMATION-001', [
            'position: absolute',
            'inset: 0',
            'background-position: center',
            'background-repeat: no-repeat',
            'background-size: 100% 100%',
            'animation: steward-session-running-sharingan 1.8s linear infinite',
            'pointer-events: none',
        ]);
    assertDeclarations(findSharinganSharedRule(source, ':hover .project-kind-icon'),
        'SHARINGAN-RUNNING-ANIMATION-001', [
            'background: transparent',
            'border-color: transparent',
        ]);
    assert.equal(cssRules(source).some(rule => rule.selectors.some(selector =>
        (
            selector.includes('[data-session-fx^="sharingan-"]')
            || selector.includes('[data-session-fx^=sharingan-]')
        )
        && selector.endsWith('.project-kind-icon svg'))), false,
        'SHARINGAN-RUNNING-ANIMATION-001 must retain the ordinary SVG fallback');
    assert.ok(source.includes('@keyframes steward-session-running-sharingan'));
}

test('SHARINGAN-RUNNING-ANIMATION-001 maps and rotates each authentic eye', () => {
    validateSharinganAnimations(compiledStyles);
    assert.throws(() => validateSharinganAnimations(compileStyles(styles.replace(
        'animation: steward-session-running-sharingan 1.8s linear infinite;',
        'animation: none;'
    ))), /SHARINGAN-RUNNING-ANIMATION-001/);
});
```

Extend `validateReducedMotion` so its second media block requires:

```js
for (const value of [
    '.ai-session-attention-indicator',
    '.project.session-running[data-session-fx^="sharingan-"] .project-kind-icon::after',
    'animation: none !important',
    'transition: none !important',
]) {
    assert.ok(sessionMotion.includes(value), `WEBVIEW-REDUCED-MOTION-001 missing ${value}`);
}
```

In `scripts/run-ai-session-safety-checks.js`, add
`steward-session-running-sharingan` to the keyframe list and require the
reduced-motion slice to include `data-session-fx^="sharingan-"`.

- [ ] **Step 2: Run style checks and verify RED**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/styles.test.js
node scripts/run-ai-session-safety-checks.js
```

Expected: the style test reports no Sharingan mapping and the safety script
reports the missing `steward-session-running-sharingan` keyframe.

- [ ] **Step 3: Add the four asset mappings and shared overlay**

Inside the existing sidebar `.project` running-animation block in
`media/styles.scss`, immediately after the `halo` block, add:

```scss
        &[data-session-fx^="sharingan-"] .project-kind-icon {
            position: relative;
            background: transparent;
            border-color: transparent;

            &::after {
                content: "";
                position: absolute;
                inset: 0;
                z-index: 1;
                background-position: center;
                background-repeat: no-repeat;
                background-size: 100% 100%;
                animation: steward-session-running-sharingan 1.8s linear infinite;
                pointer-events: none;
            }
        }

        &[data-session-fx="sharingan-itachi"] .project-kind-icon::after {
            background-image: url("sharingan/mangekyou-sharingan-itachi.svg");
        }

        &[data-session-fx="sharingan-obito-kakashi"] .project-kind-icon::after {
            background-image: url("sharingan/mangekyou-sharingan-obito-kakashi.svg");
        }

        &[data-session-fx="sharingan-sasuke"] .project-kind-icon::after {
            background-image: url("sharingan/mangekyou-sharingan-sasuke.svg");
        }

        &[data-session-fx="sharingan-shisui"] .project-kind-icon::after {
            background-image: url("sharingan/mangekyou-sharingan-shisui.svg");
        }

        &[data-session-fx^="sharingan-"]:hover .project-kind-icon {
            background: transparent;
            border-color: transparent;
        }
```

Do not hide or remove `.project-kind-icon > svg`; the opaque circular SVG
overlay covers it when loaded and leaves it available as the failure fallback.

- [ ] **Step 4: Add the shared keyframe and reduced-motion selector**

Near the existing running-animation keyframes in `media/styles.scss`, add:

```scss
@keyframes steward-session-running-sharingan {
    to {
        transform: rotate(1turn);
    }
}
```

Add this selector to the existing second reduced-motion selector list before
its declaration block:

```scss
    .project.session-running[data-session-fx^="sharingan-"] .project-kind-icon::after,
```

- [ ] **Step 5: Regenerate CSS and verify GREEN**

Run:

```bash
npx gulp buildStyles
npm run test-compile
node --test tests/integration/dashboard/styles.test.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-dashboard-webview-checks.js
git diff --check
```

Expected: every command exits 0; the committed `media/styles.css` exactly
matches compiled/minified SCSS, and all four asset URLs appear in generated
CSS.

- [ ] **Step 6: Commit Task 3**

```bash
git add \
  media/styles.scss \
  media/styles.css \
  tests/integration/dashboard/styles.test.js \
  scripts/run-ai-session-safety-checks.js
git commit -m "feat: animate authentic Sharingan workspace icons"
```

---

### Task 4: Lock VSIX contents and run complete verification

**Files:**
- Modify: `scripts/run-release-packaging-checks.js:250-325`

**Interfaces:**
- Consumes: `THIRD_PARTY_NOTICES.md`, all four SVGs, and the generated CSS from earlier tasks.
- Produces: an exact release archive contract that rejects missing, altered, or unexpectedly omitted licensed assets.

- [ ] **Step 1: Run the existing packaging gate and verify RED**

Run:

```bash
npm run test:release-packaging
```

Expected: FAIL at `main VSIX must contain exactly the reviewed release files`
because the new notice and `media/sharingan/*.svg` entries are present but not
yet approved in `expectedMainEntries`.

- [ ] **Step 2: Add the five reviewed archive entries**

In `runRealVsixArchiveChecks`, add these paths to `expectedMainEntries`:

```js
'extension/THIRD_PARTY_NOTICES.md',
'extension/media/sharingan/mangekyou-sharingan-itachi.svg',
'extension/media/sharingan/mangekyou-sharingan-obito-kakashi.svg',
'extension/media/sharingan/mangekyou-sharingan-sasuke.svg',
'extension/media/sharingan/mangekyou-sharingan-shisui.svg',
```

Keep `extension/THIRD_PARTY_NOTICES.md` beside `extension/LICENSE.md`, and keep
the SVGs beside the other `extension/media/...` entries.

- [ ] **Step 3: Compare every packaged licensed file to its source bytes**

After the exact-entry assertions, add:

```js
for (const relativePath of [
    'THIRD_PARTY_NOTICES.md',
    'media/sharingan/mangekyou-sharingan-itachi.svg',
    'media/sharingan/mangekyou-sharingan-obito-kakashi.svg',
    'media/sharingan/mangekyou-sharingan-sasuke.svg',
    'media/sharingan/mangekyou-sharingan-shisui.svg',
]) {
    assert.deepStrictEqual(
        mainEntries.get(`extension/${relativePath}`),
        fs.readFileSync(path.join(repositoryRoot, relativePath)),
        `main VSIX must preserve ${relativePath} byte-for-byte`,
    );
}
```

No `.vscodeignore` change is required: nested `media/sharingan/` assets and the
root notice are already included by the existing allow/ignore rules.

- [ ] **Step 4: Run packaging and deterministic feature checks**

Run:

```bash
node --test tests/unit/tooling/sharinganAssets.test.js
npm run test:dashboard
npm run test:safety
npm run test:integration
npm run test:release-packaging
git diff --check
```

Expected: all commands exit 0, and the real main VSIX contains the exact source
bytes for the notice and four SVGs.

- [ ] **Step 5: Run the complete Linux CI command**

Run:

```bash
npm run test:ci:linux
```

Expected: compile, behavior contracts, lint, deterministic tests, browser
tests, safety scripts, dashboard checks, architecture gates, release checks,
VSIX packaging, production build, and coverage all exit 0.

- [ ] **Step 6: Inspect the final diff and commit Task 4**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only the planned configuration, renderer, test, documentation,
license-notice, asset, SCSS/generated CSS, and packaging files are changed.

Commit:

```bash
git add scripts/run-release-packaging-checks.js
git commit -m "test: package licensed Sharingan assets"
```

---

## Final acceptance

- Each new setting renders its exact character-specific SVG on a running card.
- The selected eye fills and rotates with the project-kind icon surface at
  1.8 seconds per turn, stops for reduced motion, and restores the ordinary
  icon when running ends.
- CURRENT WORKSPACE and OTHER WINDOWS activation matches the established
  `halo` scope without new runtime or bridge data.
- All four upstream byte streams are pinned, attributed, locally packaged, and
  available without network access.
- Unknown values still use `current`; all seven existing values keep their
  current behavior.
- Focused checks, real VSIX verification, and `npm run test:ci:linux` pass.
