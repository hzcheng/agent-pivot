# Task 7 Report: Safe Reusable AI Conversation Viewer

## Status

DONE

- Base: `a2bc701ae8b5cb39515ad0fe89059d9f6f3fe384`
- Branch: `docs/active-session-conversation-outline-design`
- Feature commit: `d73886e feat: add safe AI conversation viewer`
- Root-review fix: `92eb3f5 fix: harden conversation viewer refresh recovery`
- Final scoped review verdict: `READY`
- No push was performed.

## Files

- Created `src/aiSessions/conversation/markdown.ts`
- Created `src/aiSessions/conversation/viewer.ts`
- Created `src/webview/conversationViewerScripts.js`
- Created `media/conversationViewer.scss`
- Generated `media/conversationViewer.css`
- Generated `media/conversationViewerScripts.js`
- Packaged `media/purify.min.js`
- Created `tests/unit/aiSessions/conversationMarkdown.test.js`
- Created `tests/integration/dashboard/conversationViewer.test.js`
- Created `tests/browser/conversationViewer.test.js`
- Modified `gulpfile.js`
- Modified `.vscodeignore`
- Created `.superpowers/sdd/task-7-report.md`

## TDD RED Evidence

The three required test files were created before their production modules.

```bash
node --test tests/unit/aiSessions/conversationMarkdown.test.js
```

Exited `1` because
`out/aiSessions/conversation/markdown` did not exist.

```bash
node --test tests/integration/dashboard/conversationViewer.test.js
```

Exited `1` because
`out/aiSessions/conversation/viewer` did not exist.

```bash
node --test --test-concurrency=1 \
  tests/browser/conversationViewer.test.js
```

Exited `1` with `ENOENT` because
`src/webview/conversationViewerScripts.js` did not exist.

The first TypeScript compilation after adding the Markdown implementation also
failed because the extension TypeScript library does not expose the browser
`URL` global. Importing Node's `URL` explicitly fixed the build without
weakening protocol validation.

Focused tests added during implementation and review were observed RED before
their corresponding production changes:

- latest navigation read only one bounded page instead of following the
  authoritative outline to its final interaction;
- local navigation retained the original selected item instead of updating
  selection and global position metadata;
- snapshot eviction retained the wrong anchor;
- page-local counts were rendered as global counts;
- repeated refreshes replaced the earliest unread marker;
- DOMPurify retained attributes beyond the exact allowlist;
- Webview asset URIs bypassed `asWebviewUri`;
- browser publications did not reject every stale request/subscription tuple;
- a missing initial target silently fell through to the latest item, with the
  RED assertion observing one page read instead of zero;
- a viewer that had been at latest retained the old final interaction after an
  authoritative append;
- a refresh that won the initial-load race was incorrectly treated as a live
  append and exposed a false pending indicator.

## Implementation

- `renderConversationMarkdown` uses one `markdown-it` instance with raw HTML,
  linkification, and forced line breaks disabled. Only exact `https:` links
  receive an `href`.
- `ConversationViewer` owns one reusable standalone panel, one active
  provider/session generation, one watch, and bounded snapshots.
- Outline and page reads are correlated by generation, monotonically newer
  request IDs, provider, session, and public revision. Late publications
  cannot replace newer state.
- Navigation follows authoritative outline order. It navigates within a loaded
  page without reading, uses cursors across page boundaries, and reads around
  the authoritative final interaction for Latest.
- Refresh preserves a historical selection, follows a newly appended final
  interaction only when the prior selection was latest, and fails closed if an
  initial target is no longer authoritative.
- Snapshots are bounded to 100 interactions and 4 MiB while retaining the
  selected anchor and a reload cursor toward evicted content.
- Watch failures retain stale content and expose a bounded error state; a
  successful later refresh clears it.
- The standalone panel uses a nonce-only script CSP, limits local roots to the
  media directory, converts every asset with `asWebviewUri`, and revalidates
  exact HTTPS URLs in the Host before opening them.
- The browser sanitizes with DOMPurify's exact tag/attribute policy, disables
  data and ARIA attribute expansion, and removes every non-HTTPS `href` in an
  `afterSanitizeAttributes` hook.
- The browser preserves historical scroll, auto-follows only within the
  Host-provided 8 px threshold, retains the earliest unread response across
  consecutive appends, anchors and highlights the selected interaction, and
  restores keyboard focus for explicit navigation.
- Disposal aborts active reads, disposes the watch, clears retained snapshots,
  and invokes the injected focus fallback.

## Contract Clarification

The brief says navigation is authoritative but its displayed
`ConversationViewerOptions` omitted the only way to obtain a
`ConversationOutline`. The implemented options therefore add:

```ts
readOutline(
    provider: AiSessionProviderId,
    sessionId: string,
    signal: ConversationAbortSignal
): Promise<ConversationOutline>;
```

Production construction must bind this function directly to the coordinator.
That binding remains Task 10 work; Task 7 does not wire the viewer into the
Dashboard.

The brief also asks one six-page fixture to exceed both 100 interactions and
4 MiB while each valid page is limited to 512 KiB. Six valid pages can contain
at most 3 MiB, so those bounds cannot be crossed simultaneously. Tests preserve
the intended coverage with two valid cases:

- six 20-interaction pages exceed the 100-interaction bound;
- ten individually valid pages exceed the 4 MiB aggregate bound.

## Review

The first read-only review found one Critical and five Important issues:
authoritative navigation/selection, global counts, pending-response retention,
exact DOMPurify attributes, Webview media URI conversion, and browser
publication correlation. Each received a focused failing regression before its
fix.

The next scoped pass confirmed those findings resolved and found three
Important race/authority issues: missing initial targets, latest-following
refresh, and refresh winning initial load. Each was reproduced RED and fixed.

The final tightly scoped re-review reported `READY` and no remaining proven
Critical or Important defects. The reviewer did not modify the worktree.

## Final GREEN Evidence

The exact Task 7 verification command was run after the final fixes:

```bash
npm run test-compile \
  && npx gulp --production \
  && node --test tests/unit/aiSessions/conversationMarkdown.test.js \
  && node --test tests/integration/dashboard/conversationViewer.test.js \
  && node --test --test-concurrency=1 \
    tests/browser/conversationViewer.test.js \
  && cmp src/webview/conversationViewerScripts.js \
    media/conversationViewerScripts.js \
  && cmp node_modules/dompurify/dist/purify.min.js media/purify.min.js \
  && git diff --check
```

Output: exit `0`; TypeScript compiled, production assets built, Markdown tests
reported `2/2`, viewer integration tests `10/10`, browser viewer tests `7/7`,
both packaged assets matched their sources, and the diff check was clean.

Relevant conversation and browser regressions:

```bash
node --test \
  tests/unit/aiSessions/conversation*.test.js \
  tests/contract/aiSessions/conversation*.test.js \
  tests/integration/dashboard/conversation*.test.js

node --test --test-concurrency=1 tests/browser/*.test.js
```

Output: exit `0`; conversation tests reported `69/69`, and the complete browser
suite reported `44/44`.

The repository deterministic suite was also run during final hardening:

```bash
npm run test:deterministic:run
```

Output: exit `0`; its unit phase reported `455/455`, integration phase
`171/171`, and the contract phase completed without failure.

Task-owned TypeScript lint:

```bash
npx tslint -c tslint.json \
  src/aiSessions/conversation/viewer.ts \
  src/aiSessions/conversation/markdown.ts \
  --format stylish
```

Output: exit `0`, no warnings.

`npm run lint:ci` still exits `1` only for the pre-existing
`src/aiSessions/conversation/codexAppServerClient.ts` semicolon baseline
(`0=5`). `git diff --exit-code a2bc701 --` for that file exits `0`, proving
Task 7 did not modify it.

## Concerns

No Task 7 implementation concern remains. Dashboard construction and
registration are intentionally deferred to Task 10, as required by the brief.

## Root Review Follow-up

An independent root review after the initial Task 7 commits found four
Important defects. All four were reproduced with tests before production
changes:

1. Hidden or non-live Webviews could lose a publication because the boolean
   result of `postMessage` was ignored and no panel view-state replay existed.
2. `staleRevision` from a page read was treated as a generic failure instead
   of performing one bounded authoritative outline/page retry.
3. A live tail refresh replaced the retained 20-interaction window, dropping
   the oldest visible interaction. The original browser fixture bypassed this
   Host behavior by sending 21 interactions directly.
4. A partial 2,000-interaction tail used its local selected index rather than
   the authoritative global position.

### Follow-up RED Evidence

After adding the first six Host regressions:

```bash
npm run test-compile \
  && node --test tests/integration/dashboard/conversationViewer.test.js
```

Compilation passed. The integration run exited `1`, reporting `10` pass and
`6` expected failures:

- view-state listener count was `0`, expected `1`;
- initial, navigation, and persistent-stale cases each read one outline rather
  than the expected two;
- refresh publication omitted `input-1`;
- the final partial-tail position was `2,000`, expected `2,001`.

The real Host-to-browser regression was then run:

```bash
node --test --test-concurrency=1 \
  tests/browser/conversationViewer.test.js
```

It exited `1`, reporting `7` pass and `1` expected failure: after the Host
refreshed a 20-item tail to interactions 2–21, the DOM contained zero copies of
`host-input-1`, expected one.

The final product ruling required exact-ID fail-closed behavior rather than
nearest-index fallback when an interaction disappears during the retry race.
Two more tests were added and observed RED:

```bash
node --test tests/integration/dashboard/conversationViewer.test.js
```

It exited `1`, reporting `16` pass and `2` expected failures:

- initial `r1[input-1]` → stale page → `r2[input-2]` performed two page reads,
  expected one and unavailable state;
- an established `input-1` selection removed by refresh performed a second
  page read, expected retention of the old stale snapshot.

### Follow-up Fixes

- The Host retains only the latest current-generation/current-request
  publication. A failed delivery immediately rebuilds a bootstrap document,
  and a hidden-to-visible transition rebuilds the latest bootstrap again.
  The view-state listener is disposed with the panel.
- Only exact `ConversationError('staleRevision')` triggers recovery. The same
  generation/request may read one fresh outline and perform one cursor-free
  authoritative `around` page read. A second stale error is not retried.
- Initial targets, established selections, and requested navigation targets
  must remain present by exact interaction ID. Missing initial IDs render
  unavailable without another page read; missing established IDs retain and
  publish the previous snapshot as stale.
- Refresh reconstructs retained data in authoritative outline order, keeps
  only loaded IDs still present in the outline, replaces refreshed messages by
  interaction ID, reconstructs exact public message/state fields, drops old
  revision cursors, and then applies the existing 100-interaction/4 MiB
  eviction.
- Partial-tail positions add the omitted authoritative prefix
  (`totalInteractions - interactions.length`) to the local selected index.
  The display denominator remains bounded as `2,000+`.
- The browser boundary test now obtains its initial and refresh publications
  from the real compiled `ConversationViewer`, then verifies retained history,
  a stable 9 px historical scroll with pending content, and 8 px auto-follow.

The follow-up implementation and tests were committed as:

```text
92eb3f5 fix: harden conversation viewer refresh recovery
```

### Follow-up GREEN Evidence

The exact focused command was rerun after the final exact-ID change:

```bash
npm run test-compile \
  && npx gulp --production \
  && node --test tests/unit/aiSessions/conversationMarkdown.test.js \
  && node --test tests/integration/dashboard/conversationViewer.test.js \
  && node --test --test-concurrency=1 \
    tests/browser/conversationViewer.test.js \
  && cmp src/webview/conversationViewerScripts.js \
    media/conversationViewerScripts.js \
  && cmp node_modules/dompurify/dist/purify.min.js media/purify.min.js \
  && git diff --check
```

Output: exit `0`; compilation and production asset build passed, Markdown
reported `2/2`, Host viewer integration `18/18`, browser viewer `8/8`, both
asset comparisons matched, and the diff check was clean.

Fresh full relevant regression:

```bash
node --test \
  tests/unit/aiSessions/conversation*.test.js \
  tests/contract/aiSessions/conversation*.test.js \
  tests/integration/dashboard/conversation*.test.js

node --test --test-concurrency=1 tests/browser/*.test.js
```

Output: exit `0`; conversation tests reported `77/77`, and the complete browser
suite reported `45/45`.

Fresh architecture and Dashboard checks:

```bash
npm run test:architecture-guards
npm run test:dashboard:run
```

Both exited `0`.

Task-owned TypeScript lint and `git diff --check` exited `0`. Repository lint
remains classified exactly as before: its only failure is the unchanged
`codexAppServerClient.ts` semicolon baseline (`0=5`).

The final tightly scoped read-only review returned `READY`: exact-ID initial
failure, established-selection stale retention, and one bounded retry for
present IDs were all confirmed. No proven Critical or Important finding
remains.
