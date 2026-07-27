# AI Conversation User Prompt Emphasis Design

## Context

AI Conversation currently renders User and Assistant messages with the same
card background, padding, label treatment, and left-border geometry. The User
border uses a different color, but the two roles still scan as peers. This
makes it harder to locate the prompts that define the structure of a long
conversation.

The selected visual direction is **Prompt primary block**: User input should be
the dominant structural landmark, while Assistant output should read as the
quieter response that follows it.

## Goals

- Make every User input immediately recognizable while scanning a long
  conversation.
- Preserve a full-width reading measure for long prompts, Markdown, and code.
- Keep Assistant responses readable without competing with User prompts.
- Retain correct appearance in VS Code dark, light, and high-contrast themes.
- Preserve all existing navigation, selection, focus, scrolling, sanitization,
  and live-refresh behavior.

## Non-goals

- No chat-bubble layout or right-aligned messages.
- No changes to conversation data, protocol messages, Markdown rendering, or
  provider adapters.
- No new user setting or configurable color.
- No changes to the Active Session outline card.

## Visual Design

### User prompt block

Each `.conversation-message-user` remains full width and becomes a visually
complete Prompt block:

- a subtle theme-derived background;
- a one-pixel perimeter border;
- a four-pixel accent border on the left;
- a small border radius;
- slightly more vertical separation from the preceding response;
- a compact `USER` pill using theme foreground/background tokens.

The prompt body keeps the normal editor foreground and normal text weight.
Making the complete prompt bold would reduce readability for long technical
input. The block shape, accent edge, background, and label create the emphasis
instead.

### Assistant response

Each `.conversation-message-assistant` becomes a quieter reading block:

- transparent background;
- no accent side border;
- restrained horizontal padding;
- a subtle bottom separator between response and the next prompt;
- the existing `ASSISTANT` label in the muted description color, without a
  pill.

Assistant content remains full width. It is not indented into a narrow column
and does not use a speech bubble.

### Theme and accessibility behavior

All colors come from VS Code theme variables already available to Webviews,
with safe fallback tokens where necessary. User and Assistant roles are not
distinguished by color alone: the User has a bordered container and pill,
while the Assistant has an open surface and bottom separator.

Keyboard focus and selected-interaction outlines continue to wrap the complete
message article. Focus indicators remain visually above the new borders. The
layout must stay legible under forced-colors mode; structural borders and role
text remain present even if theme colors are remapped.

## Implementation Boundaries

The existing role-specific classes and semantic articles are sufficient:

- `.conversation-message-user`
- `.conversation-message-assistant`
- `.conversation-role`
- `.conversation-markdown`

The change is intentionally CSS-led in `media/conversationViewer.css`. The Host
HTML and Webview protocol do not need a new field or role representation.
Production markup changes are permitted only if a browser test proves they are
required for accessibility; otherwise the existing DOM remains unchanged.

## State and Interaction Preservation

The following existing behaviors remain authoritative and unchanged:

- selected interaction styling;
- keyboard focus restoration;
- previous/next/latest/close controls;
- historical scroll anchoring and live-tail following;
- loading, partial, stale, and error states;
- sanitized Markdown and HTTPS-only links;
- new-response notification behavior.

The new styles must not change message identity attributes or the scroll
container geometry. User and Assistant articles remain in the same source
order and share the same available content width.

## Verification

Add one browser-owned behavior contract,
`CONVERSATION-VIEWER-USER-EMPHASIS-001`, covering production markup and CSS.
The browser test should render adjacent User and Assistant messages and verify:

- the User has a distinct non-transparent surface, perimeter border, accent
  edge, and pill-shaped role label;
- the Assistant has a transparent/open surface, no accent edge, and a bottom
  separator;
- both roles retain the same available outer width, proving the design did not
  become a chat-bubble layout;
- the User and Assistant text remains readable using theme-derived colors;
- focus and selected-interaction indicators remain present.

Run the focused browser owner first, then the existing AI Conversation browser
suite, behavior-contract validation, deterministic tests affected by Host
markup, and the full Linux CI gate before integration.

## Acceptance Criteria

1. A User prompt is recognizable without reading its role label.
2. Assistant output is visibly subordinate but remains comfortable for long
   reading.
3. Long User prompts retain the current full-width reading area.
4. Role distinction survives dark, light, and forced-color themes through both
   structure and text.
5. Conversation navigation, focus, selection, refresh, and scroll behavior are
   unchanged.
