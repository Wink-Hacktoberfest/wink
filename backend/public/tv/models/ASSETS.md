# Wink glasses model

`wink-glasses.glb`, `wink-glasses.dae`, and `wink-glasses.svg` are original parametric assets created for Wink, licensed under the repository MIT license. The silhouette is inspired by the user's reference image of black Wayfarer-style smart glasses. These are illustrative product studies, not official Ray-Ban or Meta assets or dimensionally accurate hardware models. No manufacturer logos or downloaded third-party geometry are included.

Regenerate the model and bundled viewer with `cd backend && npm ci && npm run build:glasses`. Source: `tools/build-glasses.mjs` and `ui/glasses.js`. The local viewer contains Three.js, distributed under MIT; its license is included alongside the bundle.

Coordinate system: Y up, front faces +Z; width approximately 5.7, height 1.7, depth 4.95. Use a perspective camera at `(0, 2.1, 6.6)` looking at `(0, -0.35, -1.3)`, FOV 29 degrees; initial Y rotation -0.62 radians. The DAE contains identical baked geometry for SceneKit. After regeneration, copy `backend/public/tv/models/wink-glasses.dae` to `ios/Wink/Resources/wink-glasses.dae` to keep both platforms in sync. Adjust camera distance for portrait containers. Lenses are intentionally very lightly tinted and transparent.

Viewer integration: give `#glasses-stage` an explicit height, include `<script type="module" src="/tv/glasses.js"></script>`, and optionally include a button with ID `rotateGlasses` and a nested `[data-rotation-label]` span. Rotation respects reduced motion, pauses offscreen and in background tabs, and supports mouse dragging. A local SVG remains visible if WebGL or model loading fails. Do not place the canvas above interactive page content.

The revised model uses continuous rounded cross-sections and vertex normals for the acetate fronts and tapered temples, a flatter brow, integrated saddle, proportional dark camera inserts, and subtly curved clear lenses. Web rendering uses physical clearcoat materials, a studio environment, and a feathered local contact-shadow texture. Gentle motion is limited to ±0.12 radians around the starting view; drag still allows full inspection.
