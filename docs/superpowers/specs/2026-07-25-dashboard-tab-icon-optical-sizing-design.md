# Dashboard Tab Icon Optical Sizing

## Goal

Keep the OPEN, PROJECTS, TODO, and AI tab icon containers fixed at 19 by 19
pixels while making the visible SVG artwork feel consistently sized. Narrow
sidebars must continue to hide labels without shrinking icons.

## Current Problem

The four SVG containers are equal, but their artwork bounds are not:

- OPEN: 19 by 19 pixels
- PROJECTS: 19 by 14.25 pixels
- TODO: about 13.46 by 11.48 pixels
- AI: about 12.67 by 12.67 pixels

This creates a left-to-right visual decrease even though the CSS boxes match.

## Design

Retain the existing SVG assets and 19-pixel icon containers. Apply a
tab-specific centered CSS scale to each SVG so the artwork areas converge on
an optical target near 16 by 16 pixels:

- OPEN: reduce the full-square artwork
- PROJECTS: retain its naturally wide folder silhouette
- TODO: enlarge the sparse checklist artwork
- AI: enlarge the inset terminal artwork

The scale belongs only to the Dashboard tab selectors. Shared icon uses
elsewhere remain unchanged. Transforms use the center as their origin and must
not change tab geometry, wrapping, labels, hit targets, or accessibility
labels.

## Verification

The existing Chromium Dashboard layout owner will measure the SVG view box,
artwork bounding box, and computed transform. It will require:

- every outer icon container to remain exactly 19 by 19 pixels;
- every effective artwork area to fall within a narrow optical-size range;
- labels to remain unchanged and hide only at the existing breakpoint;
- all four tabs to remain on one row at every covered sidebar width.

The browser test remains owned by `WEBVIEW-AI-PROMPT-INTERACTION-001` and runs
through `test:browser:run` in `test:ci:linux`.
