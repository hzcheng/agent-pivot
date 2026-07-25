# Madara Sharingan Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independent original and Eternal Madara Mangekyō Sharingan running-card animation modes to the existing six-mode implementation.

**Architecture:** Extend the existing bounded configuration, renderer allowlist, and SCSS asset map without changing the DOM or running-session data flow. Bundle the two reviewed Wikimedia SVGs unchanged, pin their bytes and attribution, and extend the exact VSIX contract.

**Tech Stack:** TypeScript, SCSS/CSS, Node.js test runner, Gulp, VSCE, JSON contribution metadata.

## Global Constraints

- Exact mode names are `sharingan-madara` and `sharingan-madara-eternal`.
- Exact asset paths are `media/sharingan/mangekyou-sharingan-madara.svg` and `media/sharingan/mangekyou-sharingan-madara-eternal.svg`.
- Source SVGs remain visually and byte-for-byte unmodified.
- Both variants use the existing `1.8s linear infinite` rotation only while the card is running.
- Reduced motion leaves the eye visible and stops rotation.
- Hover, ordinary SVG fallback, and all existing modes remain unchanged.
- No runtime network access or new DOM/protocol state is allowed.
- Both assets and their attribution must ship in the exact VSIX allowlist.

---

### Task 1: Bundle and register both Madara variants

**Files:**
- Create: `media/sharingan/mangekyou-sharingan-madara.svg`
- Create: `media/sharingan/mangekyou-sharingan-madara-eternal.svg`
- Modify: `tests/unit/tooling/sharinganAssets.test.js`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `src/webview/webviewContent.ts`
- Modify: `tests/integration/dashboard/styles.test.js`
- Modify: `media/styles.scss`
- Modify generated: `media/styles.css`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: the existing `AI_SESSION_RUNNING_CARD_ANIMATIONS` allowlist and `[data-session-fx^="sharingan-"]` shared style behavior.
- Produces: two valid setting values and two local SVG mappings that every full and incremental renderer path accepts.

- [ ] **Step 1: Extend the asset test first**

Append these entries to `assets` in
`tests/unit/tooling/sharinganAssets.test.js`:

```js
{
    name: 'Madara',
    file: 'media/sharingan/mangekyou-sharingan-madara.svg',
    sha256: '88f2e23d621ce3170514afbe38491bdcff289e988d15664d67574bf2575b36e7',
    source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Madara.svg',
},
{
    name: 'Madara Eternal',
    file: 'media/sharingan/mangekyou-sharingan-madara-eternal.svg',
    sha256: '2afd4d1ffa8f32b61eb9a2060ec75dfd262b4abfe26edf7f57f3ec7973292d3c',
    source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Madara_(Eternal).svg',
},
```

- [ ] **Step 2: Run the asset test and observe RED**

Run:

```bash
node --test tests/unit/tooling/sharinganAssets.test.js
```

Expected: the Madara cases fail with `ENOENT` because the two local SVG files
do not exist.

- [ ] **Step 3: Download the exact source vectors and add attribution**

Download the original files without transformation:

```bash
curl -LfsS 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Mangekyou_Sharingan_Madara.svg' \
  -o media/sharingan/mangekyou-sharingan-madara.svg
curl -LfsS 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Mangekyou_Sharingan_Madara_%28Eternal%29.svg' \
  -o media/sharingan/mangekyou-sharingan-madara-eternal.svg
sha256sum media/sharingan/mangekyou-sharingan-madara.svg \
  media/sharingan/mangekyou-sharingan-madara-eternal.svg
```

Expected hashes, in order:

```text
88f2e23d621ce3170514afbe38491bdcff289e988d15664d67574bf2575b36e7
2afd4d1ffa8f32b61eb9a2060ec75dfd262b4abfe26edf7f57f3ec7973292d3c
```

Add both exact bundled paths and Commons source URLs to the existing table in
`THIRD_PARTY_NOTICES.md`. Keep the existing ShounenSuki, Narutopedia,
unmodified-file, and CC BY-SA 3.0 statements.

- [ ] **Step 4: Verify asset integrity is GREEN**

Run:

```bash
node --test tests/unit/tooling/sharinganAssets.test.js
```

Expected: 8 tests pass.

- [ ] **Step 5: Extend configuration and renderer tests before implementation**

In `package.json` and the expected enum in
`scripts/run-ai-session-safety-checks.js`, insert after
`sharingan-shisui`:

```json
"sharingan-madara",
"sharingan-madara-eternal"
```

Add matching `enumDescriptions`:

```text
Madara Uchiha's Mangekyo Sharingan replaces and rotates over the project kind icon.
Madara Uchiha's Eternal Mangekyo Sharingan replaces and rotates over the project kind icon.
```

Extend `README.md` with both exact values. Add both values to the renderer-mode
loop in `scripts/run-dashboard-webview-checks.js`, and use each new value in
one existing full or incremental render assertion.

Add to `sharinganAssets` in
`tests/integration/dashboard/styles.test.js`:

```js
['sharingan-madara', 'sharingan/mangekyou-sharingan-madara.svg'],
['sharingan-madara-eternal', 'sharingan/mangekyou-sharingan-madara-eternal.svg'],
```

- [ ] **Step 6: Run focused tests and observe RED**

Run:

```bash
node --test tests/integration/dashboard/styles.test.js
npm run test:dashboard
npm run test:safety
```

Expected: failures identify the missing renderer allowlist and SCSS mappings
for the new exact mode strings.

- [ ] **Step 7: Implement the two renderer and SCSS mappings**

Add both values to `AI_SESSION_RUNNING_CARD_ANIMATIONS` in
`src/webview/webviewContent.ts`.

Add to the existing Sharingan mapping block in `media/styles.scss`:

```scss
&[data-session-fx="sharingan-madara"] .project-kind-icon::after {
    background-image: url("sharingan/mangekyou-sharingan-madara.svg");
}

&[data-session-fx="sharingan-madara-eternal"] .project-kind-icon::after {
    background-image: url("sharingan/mangekyou-sharingan-madara-eternal.svg");
}
```

Do not duplicate or change the shared overlay, hover, keyframe, fallback, or
reduced-motion rules. Regenerate CSS:

```bash
npx gulp buildStyles
```

- [ ] **Step 8: Run focused GREEN checks**

Run:

```bash
npm run test-compile
node --test tests/unit/tooling/sharinganAssets.test.js
node --test tests/integration/dashboard/styles.test.js
npm run test:dashboard
npm run test:safety
git diff --check
```

Expected: compilation succeeds, asset tests pass 8/8, style tests pass 9/9,
dashboard and safety scripts pass, and `git diff --check` has no output.

- [ ] **Step 9: Commit the feature**

```bash
git add package.json README.md THIRD_PARTY_NOTICES.md \
  src/webview/webviewContent.ts media/styles.scss media/styles.css \
  media/sharingan/mangekyou-sharingan-madara.svg \
  media/sharingan/mangekyou-sharingan-madara-eternal.svg \
  tests/unit/tooling/sharinganAssets.test.js \
  tests/integration/dashboard/styles.test.js \
  scripts/run-dashboard-webview-checks.js \
  scripts/run-ai-session-safety-checks.js
git commit -m "feat: add Madara Sharingan animation variants"
```

### Task 2: Lock release packaging, audit coverage, and install

**Files:**
- Modify: `scripts/run-release-packaging-checks.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: the two new committed SVG paths and the feature commit hash.
- Produces: exact release archive coverage and a current main-capability audit.

- [ ] **Step 1: Prove the exact VSIX contract is RED**

Run:

```bash
npm run test:release-packaging
```

Expected: the exact main-VSIX entry assertion reports the two unapproved
Madara SVG entries.

- [ ] **Step 2: Extend exact-entry and byte-preservation checks**

Add both paths, alphabetically with the existing Sharingan entries, to
`expectedMainEntries`:

```js
'extension/media/sharingan/mangekyou-sharingan-madara-eternal.svg',
'extension/media/sharingan/mangekyou-sharingan-madara.svg',
```

Add both repository-relative paths to the packaged-byte comparison loop:

```js
'media/sharingan/mangekyou-sharingan-madara-eternal.svg',
'media/sharingan/mangekyou-sharingan-madara.svg',
```

Add both SVG paths to the evidence list for
`SHARINGAN-ASSET-INTEGRITY-001` in
`docs/testing/behavior-contracts.json`.

- [ ] **Step 3: Verify real packaging is GREEN**

Run:

```bash
npm run test:release-packaging
```

Expected: both VSIX archives package successfully, the main archive contains
45 exact entries, and release packaging checks pass.

- [ ] **Step 4: Commit packaging checks**

```bash
git add scripts/run-release-packaging-checks.js docs/testing/behavior-contracts.json
git commit -m "test: package Madara Sharingan assets"
```

- [ ] **Step 5: Update capability audit metadata**

Collect the two implementation hashes:

```bash
git rev-parse HEAD~1
git rev-parse HEAD
```

Append the feature commit to `MAIN-WORKSPACE-WEBVIEW.commits`, append the
packaging commit to `MAIN-RELEASE-PACKAGING.commits`, and set `audit.head` to
the full packaging commit hash in
`docs/testing/main-capability-coverage.json`.

Run:

```bash
npm run test:behavior-contracts
```

Expected: 39 tests and both catalog/coverage checks pass.

Commit:

```bash
git add docs/testing/main-capability-coverage.json
git commit -m "docs: audit Madara Sharingan coverage"
```

- [ ] **Step 6: Run final verification**

Run:

```bash
npm run test:ci:linux
git diff --check origin/main..HEAD
git status --short
```

Expected: complete Linux CI exits 0, the diff check has no output, and the
working tree is clean.

- [ ] **Step 7: Repackage and install into the active VS Code host**

Run the repository install workflow using the current VS Code Server CLI with
absolute VSIX paths if its relative-path handling fails. Verify:

```bash
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server \
  --list-extensions --show-versions
```

Expected installed main version:

```text
hzcheng.project-steward@2.1.6
```

Reload the VS Code window before testing either new setting value.
