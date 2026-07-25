# Madara Sharingan Variants Design

**Date:** 2026-07-25

## Goal

Extend the existing AI-session running-card Sharingan animation with both
authentic Madara Uchiha variants:

- `sharingan-madara` for Madara's original Mangekyō Sharingan; and
- `sharingan-madara-eternal` for Madara's Eternal Mangekyō Sharingan.

They are independent choices in
`projectSteward.aiSessionRunningCardAnimation`. Existing animation modes and
their behavior remain unchanged.

## Assets and licensing

Bundle the original SVG files under `media/sharingan/`:

| Mode | Bundled asset | Source |
| --- | --- | --- |
| `sharingan-madara` | `mangekyou-sharingan-madara.svg` | [Wikimedia Commons: Madara](https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Madara.svg) |
| `sharingan-madara-eternal` | `mangekyou-sharingan-madara-eternal.svg` | [Wikimedia Commons: Madara (Eternal)](https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Madara_(Eternal).svg) |

Use the source vectors without visual modification. Their Commons pages
identify Narutopedia as the source and ShounenSuki as the author. Select
CC BY-SA 3.0 consistently with the four existing Sharingan assets, add both
files to `THIRD_PARTY_NOTICES.md`, and retain the repository's MIT license for
the extension code.

Both SVGs and the updated notice must ship inside the VSIX. The feature must
not require runtime network access.

## Configuration and rendering

Add both mode strings to the bounded configuration enum and the renderer
allowlist. They follow the existing configuration flow through full webview
rendering, open-workspace updates, and AI-session updates. Unknown values
continue to normalize to `current`.

The renderer continues to emit `data-session-fx` only for a workspace card
with a running AI session. No new session state, protocol field, or DOM
element is introduced.

## Visual behavior

Map each new `data-session-fx` value to its local SVG using the existing
`.project-kind-icon::after` Sharingan overlay.

Both variants inherit the established Sharingan behavior:

- the complete eye covers the project-kind icon surface;
- it rotates continuously at `1.8s linear infinite`;
- the ordinary project icon remains underneath as an asset-load fallback;
- hover restores the normal icon foreground and keeps the overlay surface
  background and border transparent;
- `prefers-reduced-motion: reduce` leaves the eye visible but stops rotation;
  and
- the ordinary icon returns as soon as the card is no longer running.

No existing Sharingan mode, halo mode, card interaction, badge, border, or
expanded-session behavior changes.

## Verification

Extend the existing tests rather than creating a parallel animation system:

- configuration and renderer propagation tests cover both exact mode strings;
- asset-integrity tests pin the reviewed SVG bytes and verify attribution;
- style tests verify both local asset mappings while reusing the shared
  rotation, hover, fallback, and reduced-motion contracts;
- dashboard and AI-session safety checks recognize both modes;
- release-packaging checks require both SVGs in the exact VSIX allowlist and
  compare their packaged bytes with repository sources; and
- behavior-capability audit metadata assigns every implementation commit.

Run the focused tests during development, then the complete Linux CI gate and
real release-packaging check before installation.

## Out of scope

- Automatically alternating between the two Madara variants.
- Adding a secondary Madara-specific setting.
- Editing, recoloring, or synthesizing either source SVG.
- Changing the animation speed or behavior of existing modes.
