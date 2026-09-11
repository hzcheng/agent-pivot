# Local file links in AI Conversation

- Markdown in the conversation's worktree continues to use the comment-enabled document reader.
- Other trusted workspace files open with VS Code's registered editor, including image previews rather than a forced text editor.
- Absolute paths outside trusted workspace roots require confirmation showing the exact canonical filename. Cancellation does not open or read the file contents. Each external opening asks again; no directory permission or permanent grant is stored.
- Confirmed external Markdown opens in an isolated read-only rendered panel, not an AI conversation or comment store. It supports Markdown and up to 20 Mermaid diagrams. Unsupported execution/copy/sort controls are absent. External resources are blocked by CSP; linked files require their own confirmation.
- Relative paths cannot escape their authoritative workspace. Missing, inaccessible, non-regular, changed or oversized files produce a visible warning and a diagnostic entry.
- Line and column references are retained by an explicit editable-source button in external Markdown previews; opening the source requires confirmation again.

## Boundaries

External Markdown is limited to 2 MiB and 8 MiB of rendered HTML. Reads use a bounded buffer and check the opened file's identity and metadata before displaying its contents. Closing a read-only preview cancels pending linked-file displays from it.

Native VS Code editors take a canonical pathname, not an already-open file descriptor. Consent authorizes that pathname; another process replacing the file after validation and before VS Code resolves it cannot be prevented by this extension. This feature does not claim immutable object identity for native editors. It does not execute linked programs or send external content to AI.
