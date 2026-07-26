# Task 9 Report: Sidebar Conversation Outline

## Status

DONE

- Base: `d3ae04546b28ec407c899255c29059e5150f5c70`
- Branch: `docs/active-session-conversation-outline-design`
- Feature commit:
  `b596147 feat: render Active Session conversation outlines`
- Root-review fix commit:
  `11ee86a fix: align conversation outlines with host contracts`
- Independent final review: Critical 0, Important 0, Minor 0.
- No push was performed.

## Files

- Modified `src/webview/webviewProjectScripts.js`
- Generated `media/webviewProjectScripts.js`
- Modified `media/styles.scss`
- Generated `media/styles.css`
- Modified `tests/integration/dashboard/webviewState.test.js`
- Modified `tests/browser/activeSessionConversationOutline.test.js`
- Modified `docs/testing/behavior-contracts.json`
- Created `.superpowers/sdd/task-9-report.md`

No Task 10 Host routing or wiring file was modified.

## TDD RED Evidence

The integration and browser expectations were added before production
rendering:

```bash
npm run test-compile
node --test --test-concurrency=1 \
  tests/integration/dashboard/webviewState.test.js
node --test --test-concurrency=1 \
  tests/browser/activeSessionConversationOutline.test.js
```

Compilation passed. The integration suite then reported `53/54` because
`applyAiSessionConversationOutlineResult` did not exist. The six Task 8
browser cases remained green while the six new Task 9 cases failed because no
result handler, marker rendering, correlated state UI, bounded scrolling, or
retry timer existed.

The browser waits were bounded to five seconds before using this run as RED
evidence. This kept missing UI failures deterministic rather than relying on
Playwright's unbounded default.

A later review found four contract gaps. The strengthened three-test slice
first reported `0/3`:

```bash
node --test --test-concurrency=1 \
  --test-name-pattern='renders only an exact current focused expansion result|distinguishes loading|reveals first and live latest' \
  tests/browser/activeSessionConversationOutline.test.js
```

Those failures proved that:

1. an over-limit nested summary could still render;
2. a legal `reconnectingCodex` error without `retryAfterMs` was rejected;
3. keyboard navigation could focus an invisible marker;
4. a live tail replacement did not preserve the focused marker while
   following the new end.

After the fixes, the same slice reported `3/3`.

One intermediate retry test also reproduced a real Web timer risk:
`retryAfterMs: 60_001` was initially accepted and rendered a reconnecting
state. The envelope now rejects retry delays above 60 seconds.

A later root review required two Important corrections and one Minor
interaction correction. All three were specified before implementation, and
the unchanged production code reported `0/3` in the focused browser slice:

```bash
node --test --test-concurrency=1 \
  --test-name-pattern='renders the actual Task 6 capped shape|rejects every invalid public error pairing|safely renders markers' \
  tests/browser/activeSessionConversationOutline.test.js
```

The RED output showed:

1. Task 6's actual 2,001-interaction `buildConversationOutline` result retained
   `model-1` instead of applying the live capped tail beginning at `model-2`;
2. 17 invalid code/reason/retry combinations cleared the existing marker,
   changed its state, or installed a timer;
3. clicking a marker left `tabindex="0"` and `aria-selected="true"` on the
   previously keyboard-selected marker.

The same focused slice reported `3/3` after the minimal fixes.

## Implementation

- The Webview consumes only the exact Task 6 result envelope for the current
  request, subscription generation, project, provider, session, expanded row,
  and focused identity.
- Payloads and public errors require exact keys and semantic combinations.
  IDs/revisions are bounded nonblank strings; interactions are unique and
  capped at 2,000; counts are capped at 64,000; previews are capped at 160
  graphemes and 4,096 code units.
- A Task 6 outline may legitimately report more total interactions than its
  2,000 retained summaries even when source `partial` is false. The Webview
  accepts `totalInteractions >= interactions.length` and derives visible
  omission from `partial || totalInteractions > interactions.length`, yielding
  the exact `2,000+` count and `Older inputs omitted` state.
- Public errors use an exact semantic matrix: generic errors have no reason or
  retry deadline; missing-source, update, and reconnect reasons pair only with
  unavailable and no deadline; unsupported protocol pairs only with
  unsupported version and no deadline; retry-exhausted pairs only with
  unavailable and a positive safe deadline at most 60 seconds.
- Markers are built with `document.createElement`, populated with
  `textContent`, and receive only a numeric CSS ratio clamped to `[0.18, 1]`.
  Prompt text is never returned to the Host.
- The rail exposes oldest-to-newest markers, latest/current state, a 24 px
  target, roving `tabindex`, `role="option"`, `aria-selected`, and timestamp
  plus preview labels.
- Click first updates the same roving focus/selection state used by the
  keyboard, then click and Enter post only the opaque interaction ID and
  current public revision. Arrow keys and Home/End move focus and minimally
  reveal the destination without posting navigation.
- First render reveals the latest marker only when necessary. Live results
  follow the tail only if the prior rail was within a valid numeric threshold;
  otherwise historical scroll is retained. Matching authoritative HTML
  replacement restores scroll and marker focus by opaque interaction ID.
- Loading, empty, partial, stale, timeout, too-large, generic unavailable,
  Codex reconnecting, retry-exhausted, update-required, and unsupported
  protocol states are distinct.
- Retry creates a new correlated outline request. A positive bounded Host
  deadline disables it until expiry; reconnecting without a deadline remains
  immediately retryable. Timers are cleared on replacement, collapse,
  subsequent results, retry, and `pagehide`.
- The existing Task 8 request identity remains the outline correlation
  identity even after marker navigation advances the global request ID.

## Review

The scoped self-review and independent read-only review checked:

- the exact result/error/payload key sets and all nested bounds;
- request, generation, project, provider, session, revision, row, and focus
  correlation;
- safe text/title construction and numeric-only width input;
- opaque navigation without prompt leakage;
- loading/error/retry transitions and timer ownership;
- first, historical, live-tail, keyboard, and replacement scroll/focus rules;
- generated source parity and absence of Task 10 Host wiring.

The first independent review reported four Important findings, all reproduced
and fixed before commit:

1. accept legal `reconnectingCodex` errors without `retryAfterMs`;
2. retain marker focus while a live result follows the rail tail;
3. reveal keyboard-focused markers;
4. enforce Task 6's nested preview/count limits.

The final independent re-review reported Critical 0, Important 0, Minor 0.

The later root review reported two Important findings and one Minor finding:

1. the Webview rejected Task 6's real 2,001-total/2,000-summary capped shape;
2. public error code/reason/retry pairing was not fully fail-closed;
3. pointer activation did not update roving marker selection.

After RED-first fixes, the original scoped reviewer rechecked the complete
follow-up diff and reported Critical 0, Important 0, Minor 0. It also confirmed
that the auto-scroll threshold was not expanded and no Task 10 Host wiring was
added.

## Final GREEN Evidence

Fresh verification covered:

```bash
npm run test-compile
npx gulp --production
node --test --test-concurrency=1 \
  tests/integration/dashboard/webviewState.test.js
node --test --test-concurrency=1 \
  tests/browser/activeSessionConversationOutline.test.js
npm run test:deterministic:run
npm run test:browser:run
npm run test:safety:run
npm run test:dashboard:run
npm run test:architecture-baseline
npm run test:architecture-guards
node --test tests/unit/tooling/behaviorCatalog.test.js \
  tests/unit/tooling/mainCapabilityCoverage.test.js
npm run lint
npm run lint:ci
node scripts/check-behavior-contracts.js
git diff --check
cmp src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
node --check src/webview/webviewProjectScripts.js
node --check media/webviewProjectScripts.js
```

- TypeScript and the attention bridge compiled.
- Production Gulp assets built.
- Focused integration reported `54/54`.
- Focused browser reported `14/14`.
- The deterministic unit/contract/integration chain passed; its final
  integration stage reported `184/184`.
- The complete browser suite reported `59/59`.
- Safety, Dashboard Webview, architecture baseline, and architecture guards
  passed.
- Behavior catalog and main-capability unit checks reported `40/40`.
- Ordinary TSLint exited successfully with existing warnings.
- Diff whitespace, generated JavaScript parity, and both JavaScript syntax
  checks passed.

Two repository-baseline checks remain intentionally unchanged:

- `npm run lint:ci` reports only
  `src/aiSessions/conversation/codexAppServerClient.ts semicolon 0=5`; Task 9
  does not modify that file.
- `node scripts/check-behavior-contracts.js` reports the existing unaudited
  Task 1–8 implementation commits plus Task 9's already committed feature
  commit after the catalog audit head. Per Task 9 scope, the audit head was not
  advanced.
