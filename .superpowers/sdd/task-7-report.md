# Task 7 Report: Safe Reusable AI Conversation Viewer

## Status

DONE

- Base: `a2bc701ae8b5cb39515ad0fe89059d9f6f3fe384`
- Branch: `docs/active-session-conversation-outline-design`
- Feature commit: `d73886e feat: add safe AI conversation viewer`
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
