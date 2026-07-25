# Sharingan Running Animation Design

Date: 2026-07-25

Status: Approved

## Context

Project Steward exposes `projectSteward.aiSessionRunningCardAnimation` to
choose the visual treatment applied to a workspace card while one or more AI
sessions are running. The current `halo` treatment leaves the project-kind icon
in place and rotates a glowing ring around its edge.

Add four new treatments that replace the complete project-kind icon surface
with an authentic character-specific Mangekyō Sharingan and rotate the complete
eye. The accepted variants are Itachi Uchiha, Obito Uchiha/Kakashi Hatake,
Sasuke Uchiha, and Shisui Uchiha. All existing treatments remain available.

The feature uses the existing running-card state and configuration flow. It
does not change how running sessions are detected or introduce new workspace,
session, provider, or bridge data.

## User-visible behavior

Add these independent values to
`projectSteward.aiSessionRunningCardAnimation`:

- `sharingan-itachi`
- `sharingan-obito-kakashi`
- `sharingan-sasuke`
- `sharingan-shisui`

Each setting description names the corresponding character. The user selects
one fixed variant in VS Code settings; the extension does not randomize or
cycle between variants.

When a workspace card already qualifies for its configured running treatment,
a Sharingan value:

1. covers the complete project-kind icon with the selected eye;
2. rotates the complete eye continuously at a linear 1.8 seconds per turn;
3. leaves the running card's existing border, badge, title, and interaction
   behavior unchanged; and
4. restores the ordinary project-kind icon as soon as the card is no longer
   running.

The effect follows the same scope as the current `halo` treatment. It applies
to the CURRENT WORKSPACE card when its hydrated local session view contains a
running execution, and to an OTHER WINDOWS navigation card when that card
already carries a non-zero aggregate running-session count. The new modes do
not add session identities, provider details, or any new cross-window data.

Multiple simultaneous running sessions do not change the rotation speed.
Hover treatment must not recolor or obscure the Sharingan. When
`prefers-reduced-motion: reduce` is active, the selected eye remains visible
but does not rotate.

## Assets and licensing

Bundle the following original SVG files under `media/sharingan/`:

| Bundled asset | Source |
| --- | --- |
| `mangekyou-sharingan-itachi.svg` | [Wikimedia Commons: Itachi](https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Itachi.svg) |
| `mangekyou-sharingan-obito-kakashi.svg` | [Wikimedia Commons: Obito/Kakashi](https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Kakashi.svg) |
| `mangekyou-sharingan-sasuke.svg` | [Wikimedia Commons: Sasuke](https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Sasuke.svg) |
| `mangekyou-sharingan-shisui.svg` | [Wikimedia Commons: Shisui](https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Shisui.svg) |

Use the original vector files without visual modification. Their Commons
descriptions identify Narutopedia as the source and ShounenSuki as the author.
The Itachi, Obito/Kakashi, and Sasuke files are offered under GFDL and
CC BY-SA 3.0/2.5/2.0/1.0; the Shisui file is offered under CC BY-SA 3.0.
Project Steward selects CC BY-SA 3.0 consistently for all four bundled files.

Add a packaged root-level `THIRD_PARTY_NOTICES.md` that attributes each file,
links its source page, identifies the bundled path, states that the file is
unmodified, and links the selected CC BY-SA 3.0 terms. Keep the
project's MIT license unchanged; the four third-party SVG files retain their
own licenses.

The VSIX must contain all four SVGs and the notice. No runtime network access
is allowed or needed.

## Rendering and style architecture

Extend the renderer's bounded running-animation allowlist with the four new
values. The setting continues to flow unchanged through full Webview render,
open-workspace incremental updates, and AI-session incremental updates.
Unknown values continue to normalize to `current`.

Do not inline third-party SVG markup into TypeScript. Keep the existing
workspace-card DOM contract:

- `session-running` indicates that the card is running;
- `data-session-fx` selects the configured treatment; and
- the existing `.project-kind-icon` retains its ordinary project-type SVG.

SCSS maps each Sharingan `data-session-fx` value to one local asset URL. A
pseudo-element positioned over `.project-kind-icon` covers the icon surface,
preserves the source SVG's circular aspect ratio, and owns the rotation
animation. The ordinary icon remains underneath rather than being removed or
hidden. This gives a safe visual fallback if an asset unexpectedly fails to
load.

Sharingan selectors neutralize the ordinary blue hover color/background
treatment only for the icon surface. They must not change the card's hover,
focus, click, badge, border, or expanded-session behavior. The common
`.project-session-fx` layer remains in the DOM for compatibility but is
visually inert for the four Sharingan modes.

SCSS remains the source of truth. Regenerate `media/styles.css` through the
existing Gulp task; do not edit generated CSS independently.

## Error and compatibility behavior

- Missing or invalid configuration still uses `current`.
- A stopped, starting, missing, or unhydrated local session does not activate
  the current card's running treatment.
- A navigation card with a zero or missing aggregate running count does not
  activate the treatment.
- A missing packaged SVG falls back visually to the ordinary project-kind icon
  because the original icon remains beneath the overlay.
- Reduced-motion mode disables only the rotation, not the static running state
  or selected eye.
- Existing `current`, `sweep`, `orbit`, `halo`, `ripple`, `breath`, and `none`
  values retain their current behavior.
- Existing saved settings require no migration.

## Verification

Behavior and artifact tests must prove:

1. the exact setting enum contains the seven existing values plus all four
   Sharingan values, with character-specific descriptions;
2. the renderer accepts each new value and still normalizes unknown values to
   `current`;
3. full render, open-workspace incremental render, and AI-session incremental
   render preserve each selected Sharingan value;
4. a running CURRENT WORKSPACE card and an already-running OTHER WINDOWS card
   receive the selected icon treatment;
5. stopped, starting, idle, and unhydrated cards do not display it;
6. each SCSS selector maps to the correct local SVG, uses the shared rotation
   keyframe, and protects the icon from ordinary hover recoloring;
7. reduced-motion CSS disables the Sharingan rotation while leaving the image
   visible;
8. generated CSS contains the four mappings and the keyframe;
9. the four SVG source files match the selected upstream originals and remain
   valid SVGs;
10. release packaging includes the four assets and
    `THIRD_PARTY_NOTICES.md`; and
11. all existing running-animation, workspace rendering, privacy, Webview,
    and release-packaging checks remain green.

## Non-goals

- Random selection or automatic cycling between Sharingan variants.
- Editing, recoloring, or inventing additional Sharingan artwork.
- Replacing icons outside an already-running workspace card.
- Changing running-session detection, bridge payloads, card layout, or session
  badges.
- Removing or renaming an existing animation value.
