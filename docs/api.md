# Wink API contract (v1)

The single contract between the iOS/glasses app (`ios/`, Arboy) and the backend (`backend/`, Messi).
**Change this file only when both of you agree**, and note the change in the changelog at the bottom.

- Base URL: `https://wink-api.<subdomain>.workers.dev` when deployed; `http://<mac-lan-ip>:8787` from `wrangler dev --ip 0.0.0.0`.
- Auth: every `/v1/*` request sends `Authorization: Bearer <WINK_TOKEN>`. WebSockets and `<img>` tags can't set headers, so `/v1/live` takes `?token=` and `/v1/images/*` is unauthenticated (keys are random UUIDs).
- JSON bodies are `application/json`; uploads are `multipart/form-data`.
- Errors: any non-2xx returns `{ "error": { "code": "string", "message": "string" } }`.
- **`speech` is spoken into the wearer's ear**: one or two sentences, at most ~25 words, no markdown, no emoji, no URLs.
- **Mock mode**: with `MOCK=true` the backend returns canned responses for every route without calling Workers AI, DigitalOcean, Neon or Snowflake, so iOS can integrate from minute one.

## Shared types

```ts
type Location = { lat: number; lng: number };

// Normalized to the image: 0..1, origin top-left.
type Box = { x: number; y: number; w: number; h: number };

type Selection = {
  mode: "full" | "point" | "frame" | "lasso";
  box: Box | null;          // null when mode is "full"
};

type Place = {
  id: string;               // Overture place id
  name: string;
  category: string;         // Overture primary category, e.g. "book_store"
  address: string | null;
  phone: string | null;
  lat: number;
  lng: number;
  distanceMeters: number | null;
};

type Memory = {
  id: string;               // uuid
  createdAt: string;        // ISO 8601
  kind: "explicit" | "passive";
  title: string;            // short, e.g. "2019 Malbec, Mendoza"
  summary: string;          // one sentence
  visibleText: string;      // text read from the image (OCR by the vision model)
  objects: string[];        // e.g. ["wine bottle", "label"]
  note: string | null;      // what the wearer said after "save this"
  imageUrl: string;         // absolute URL to /v1/images/<key>
  selection: Selection;
  location: Location | null;
  place: Place | null;      // set when the memory matched a real business in Overture
};
```

## Routes

### `GET /v1/health`
→ `200 { "ok": true, "mock": boolean, "models": { "chat": string, "vision": string, "embed": string } }`

### `POST /v1/memories`: "Hey Wink, save this" or a frame gesture
`multipart/form-data`:
- `image`: JPEG, longest side ≤ 1280 px. **The iOS app crops to the selection before upload**; the backend never re-crops.
- `meta`: JSON string:
  ```json
  {
    "utterance": "hey wink save this it's the wine sam liked",
    "note": "the wine sam liked",
    "selection": { "mode": "point", "box": { "x": 0.31, "y": 0.18, "w": 0.35, "h": 0.40 } },
    "kind": "explicit",
    "source": "glasses",
    "capturedAt": "2026-10-26T19:12:03Z",
    "location": { "lat": 0, "lng": 0 }
  }
  ```
  `note`, `location` may be `null`. `source` is `"glasses"` or `"phone"`. `kind` defaults to `"explicit"`.

→ `201 { "memory": Memory, "speech": "Saved. 2019 Malbec from Mendoza." }`
Side effect: broadcasts `memory.saved` on `/v1/live`.

### `POST /v1/glance`: "Hey Wink, what's this?" (nothing is saved)
`multipart/form-data`: `image` (JPEG) + `meta` `{ "utterance": string, "location": Location | null }`
→ `200 { "speech": string, "title": string, "objects": string[] }`
Side effect: broadcasts `glance`.

### `POST /v1/ask`: "Hey Wink, what was that book?" / "where did I put my keys?"
`{ "question": string, "location": Location | null }`
→ `200 { "speech": string, "memories": Memory[] }`, best match first, at most 3, may be empty. `speech` must say so honestly when nothing matches.
Side effect: broadcasts `answer`.

### `POST /v1/nearby`: "Hey Wink, where can I get this nearby?"
`{ "memoryId": string | null, "query": string | null, "location": Location }`. Send `memoryId` (usually the last saved or last answered memory) or `query`, or both.
→ `200 { "speech": string, "places": Place[] }`, nearest first, at most 5. Data comes from Overture Maps Places in Snowflake.
Side effect: broadcasts `nearby`.

### `POST /v1/speak`: the reply in a natural voice
`{ "text": string }` → `200 audio/mpeg` (MP3). ElevenLabs when `ELEVENLABS_API_KEY` is set, otherwise Deepgram Aura-2 on Workers AI. Any error (including MOCK mode) means the phone uses its built-in voice.

### `GET /v1/memories?limit=50`
→ `200 { "memories": Memory[] }`, newest first.

### `DELETE /v1/memories/:id`: "Hey Wink, forget that" or a flick on the TV
→ `204`. Side effect: broadcasts `memory.deleted`.

### `GET /v1/images/:key`
→ the JPEG from R2. No auth.

### `POST /v1/events`: discrete UI events from the phone, relayed to the TV
Body is one `LiveEvent` (below) of type `status`, `transcript` or `gesture`. → `202`.

### `GET /v1/live?token=<WINK_TOKEN>&role=tv|glasses`: WebSocket
One shared room (a single Durable Object). Every message is one JSON `LiveEvent`.
- Messages a `glasses` client sends are relayed to all `tv` clients. Use this for high-rate `pointer` events instead of HTTP.
- The server also pushes the `memory.*`, `glance`, `answer` and `nearby` events caused by the routes above.

```ts
type LiveEvent =
  | { type: "status"; state: "idle" | "listening" | "thinking" | "speaking" | "paused"; text?: string }
  | { type: "transcript"; text: string }                       // what the wearer just said
  | { type: "gesture"; gesture: "point" | "frame" | "lasso" | "palm" | "thumbsUp" | "fingers" | "pinch" | "flick"; value?: number; box?: Box }
  | { type: "pointer"; x: number; y: number; pinching: boolean } // 0..1 in the glasses frame; ≤ 20 per second
  | { type: "frame"; jpegBase64: string }                        // optional POV preview, ≤ 2 per second, ≤ 480 px
  | { type: "memory.saved"; memory: Memory }
  | { type: "memory.deleted"; id: string }
  | { type: "glance"; speech: string; title: string; objects: string[] }
  | { type: "answer"; question: string; speech: string; memories: Memory[] }
  | { type: "nearby"; speech: string; places: Place[] };
```

### `GET /tv`
The big-screen dashboard (static page served by the Worker). Open `/tv?token=<WINK_TOKEN>` on the projector laptop.

## Changelog
- v1 (2026-10-26 18:50): initial contract.
- v1.1 (2026-10-26 20:30): `POST /v1/speak` (Arboy, additive).
