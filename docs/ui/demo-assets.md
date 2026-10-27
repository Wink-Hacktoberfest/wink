# Demo memory photographs

These four synthetic photographs were generated with Codex's built-in image generation tool for the Wink UI demo on 2026-10-26. They are illustrative MOCK content, not actual user captures, product endorsements, or photographs of real events. No external stock image was downloaded. The book cover is an AI-generated interpretation, not an official publisher asset.

The generated PNGs were visually inspected for subject, readable labels, and natural photographic materials, then encoded as 1200 × 900 WebP with cwebp quality 85. Final assets live in `backend/public/tv/demo/`. Original tool outputs remain in Codex's generated-images directory outside the repository.

| Asset | MOCK image key | Subject |
| --- | --- | --- |
| `wine.webp` | `sample-wine` | 2019 Mendoza Malbec at a restaurant table |
| `book.webp` | `sample-book` | Project Hail Mary by Andy Weir at a cafe |
| `keys.webp` | `sample-keys` | House keys on a stone kitchen counter |
| `coffee.webp` | `sample-coffee` | Ethiopia Yirgacheffe whole beans on a shelf |

Only in `MOCK=true`, the four existing `/v1/images/sample-*` endpoints serve their matching bundled photograph through the asset binding. Existing seeded Durable Object data needs no reset. Sample image URLs include `?v=photo-1` to invalidate the previously cached SVG artwork; uploaded-image URLs remain unchanged. No redirects, authentication headers, or query parameters are forwarded to the asset request. Missing asset bindings or unavailable images retain the prior SVG fallback. Real-mode serving and uploaded-image behavior remain unchanged.

Validation: full backend typecheck and 74 tests pass, including exact-path allowlisting, credentials isolation, real-mode behavior, and unavailable-asset fallback. The four generated originals were visually inspected before WebP encoding.

## Generation prompts

### wine

Use case: photorealistic-natural. Asset type: a saved wearable-camera memory photograph for a smart glasses app. A single dark glass bottle of 2019 Mendoza Malbec standing on a warm pale wood restaurant table. Cream paper wine label with readable text "MENDOZA", "MALBEC", "2019". Natural slightly downward first-person camera angle, bottle fully visible near center, softly blurred restaurant background, neutral soft daylight with warm wood tones, realistic glass reflections and tactile paper, subtle photographic grain. Landscape 4:3 composition. No interface, graphic overlay, watermark, illustration or 3D render.

### book

Use case: photorealistic-natural. Asset type: saved wearable-camera memory photograph for a smart glasses app. A paperback copy of Project Hail Mary by Andy Weir lying at a slight diagonal on a light pale oak cafe table. Cover text clearly reads "PROJECT HAIL MARY" and "ANDY WEIR"; tasteful recognizable space-themed book cover with an astronaut. Natural first-person slightly downward camera angle, entire book visible near center with a little surrounding table, softly blurred cafe background. Soft neutral window light, realistic printed paper, gently worn corners, natural shadows, subtle photographic grain. Landscape 4:3 composition. No interface, graphic overlay, watermark, illustration of the scene, or 3D render.

### keys

Use case: photorealistic-natural. Asset type: saved wearable-camera memory photograph for a smart glasses app. A small set of ordinary metal house keys on a round keyring resting on a pale limestone kitchen counter, with a fruit bowl softly out of focus behind them. Slightly downward first-person camera perspective, keys large and clearly visible in the foreground near center, enough surrounding counter to feel like a candid memory. Soft neutral window daylight, authentic metal scratches and reflections, subtle stone texture, naturally shallow depth of field. Landscape 4:3 composition. No interface, text, graphic overlay, watermark, illustration, or 3D render.

### coffee

Use case: photorealistic-natural. Asset type: saved wearable-camera memory photograph for a smart glasses app. One natural kraft paper bag of Ethiopia Yirgacheffe coffee beans on a light wood coffee shop shelf. A tasteful simple cream label with readable text "ETHIOPIA", "YIRGACHEFFE", "WHOLE BEAN". Front three-quarter first-person view, entire bag visible near center, neighboring shelf softly blurred. Neutral soft daylight, tactile creased kraft paper and realistic matte label, subtle photographic grain. Landscape 4:3 composition. No interface, graphic overlay, watermark, illustration, or 3D render.


