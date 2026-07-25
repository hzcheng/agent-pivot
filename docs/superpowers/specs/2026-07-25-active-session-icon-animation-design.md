# Active Session Icon Animation Design

**Date:** 2026-07-25

## Goal

Let users choose a running animation for the icon at the start of each Active
Session row independently from the workspace-card running animation.

Add the machine-scoped setting:

```text
projectSteward.aiSessionRunningIconAnimation
```

Its default is `current`, and its exact choices are:

```text
current
halo
sharingan-itachi
sharingan-obito-kakashi
sharingan-sasuke
sharingan-shisui
sharingan-madara
sharingan-madara-eternal
none
```

The existing `projectSteward.aiSessionRunningCardAnimation` setting and all of
its behavior remain independent and unchanged.

## Geometry and scope

The current session icon surface is a 26px rounded square, reduced to 21px in a
narrow sidebar. Change only icons inside `.active-ai-session-row` to a circle
with `border-radius: 50%`. Apply the circular shape in every Active Session
execution state so the icon does not jump between a square and a circle when
its state changes.

History/SESSIONS rows retain their existing rounded-square icon. Icon width,
height, terminal SVG size, grid geometry, actions, and responsive dimensions
remain unchanged.

Only a row whose `data-execution-state` is `running` receives a normalized
`data-session-icon-fx` value and an animation. `starting` and `stopped` rows
retain the circular terminal icon without an animation. A defensive unknown
state does the same; `Focus` remains an action label rather than an
execution-state value.

## Rendering and configuration flow

Use a bounded allowlist for the new setting. Unknown values normalize to
`current`.

Read the setting during full webview rendering and through the existing
AI-session Dashboard controller. Pass it through the Active Session content
rendering functions and emit it as `data-session-icon-fx` on running Active
Session rows only.

Add the new setting key to the existing configuration-change refresh boundary
so changing it refreshes the Dashboard. The incremental AI-session message
continues to carry rendered HTML; no new workspace, attention, session, bridge,
or cross-window protocol field is introduced.

## Visual modes

### `current`

Preserve the existing 2.6-second linear blue conic border animation and terminal
SVG. Adapt only its geometry from a rounded square to the Active Session
circle.

### `halo`

Keep the terminal SVG visible. Render a distinct brighter rotating halo around
the circular icon edge. The halo must remain inside the icon's layout footprint
and must not change row height, hit targets, or neighboring text.

### Sharingan modes

Reuse the six already bundled local SVG assets:

| Mode | Asset |
| --- | --- |
| `sharingan-itachi` | `media/sharingan/mangekyou-sharingan-itachi.svg` |
| `sharingan-obito-kakashi` | `media/sharingan/mangekyou-sharingan-obito-kakashi.svg` |
| `sharingan-sasuke` | `media/sharingan/mangekyou-sharingan-sasuke.svg` |
| `sharingan-shisui` | `media/sharingan/mangekyou-sharingan-shisui.svg` |
| `sharingan-madara` | `media/sharingan/mangekyou-sharingan-madara.svg` |
| `sharingan-madara-eternal` | `media/sharingan/mangekyou-sharingan-madara-eternal.svg` |

A pseudo-element covers the complete circular icon surface and rotates at
`1.8s linear infinite`. The original terminal SVG remains underneath as the
asset-load fallback. Hover must not recolor or obscure the Sharingan.

The assets, attribution, byte hashes, and VSIX packaging contract already
exist; this feature adds no new asset or runtime network request.

### `none`

Show the ordinary circular terminal icon with no running animation layer.
Textual execution status remains the state indicator.

## Accessibility and compatibility

Under `prefers-reduced-motion: reduce`, the selected eye or static halo remains
visible while its rotation stops. `current` likewise becomes a static border.

The existing textual `Running` status remains available, so color or artwork is
never the only execution-state signal. Forced-colors mode retains a
system-visible icon border and interaction focus styles.

All mode overlays are inert (`pointer-events: none`) and cannot change session
activation, focus, terminal actions, batch selection, attention indicators, or
keyboard behavior.

## Error behavior

- Unknown configuration values fall back to `current`.
- Missing Sharingan assets reveal the unchanged terminal SVG underneath.
- Non-running rows ignore the configured effect.
- History rows do not acquire the circular Active Session geometry or the new
  effect attribute.

## Verification

Add focused automated coverage for:

- the exact setting enum, descriptions, default, and machine scope;
- unknown-value normalization;
- full webview rendering and AI-session incremental refresh propagation;
- `data-session-icon-fx` appearing only on running Active Session rows;
- circular Active Session geometry at 26px and responsive 21px sizes;
- unchanged rounded-square History/SESSIONS geometry;
- `current`, `halo`, six Sharingan mappings, and `none`;
- the 2.6-second current animation and 1.8-second Sharingan rotation;
- terminal SVG fallback, hover behavior, reduced motion, and forced colors;
- SCSS-to-generated-CSS parity; and
- complete Linux CI and release packaging.

## Out of scope

- Mirroring card-only `sweep`, `orbit`, `ripple`, or `breath` effects.
- Synchronizing the icon setting with the workspace-card setting.
- Changing provider colors or replacing the terminal icon outside a running
  effect.
- Changing Active Session row layout, actions, state semantics, or protocols.
- Adding or editing Sharingan artwork.
