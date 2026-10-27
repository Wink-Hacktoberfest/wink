# Wink: PRD

> **"Hey Wink, save this."** Smart-glasses memory you control with your voice and your hands.

Hacktoberfest 2026 mini hackathon (Hacklahoma, Oct 26). Hacking 5:30 PM → **projects due 9:00 PM** → demos 9:15 PM.
Team: **Arboy** (Claude Code, owns the glasses/iOS side) and **Messi** (Codex, owns the backend, TV and Snowflake side).

---

## 1. Problem
We see hundreds of things a day that we mean to remember: a wine a friend liked, the book on someone's desk, the Wi-Fi password on a sign, where we put our keys. Phones make you stop, unlock, open the camera, and then you never find the photo again. Smart glasses already see what you see, but today's assistants forget everything, live on someone else's model, and can't tell which thing you mean.

## 2. Product
Wink is an iOS app paired with Meta Ray-Ban glasses:

- **Save on purpose:** "Hey Wink, save this," optionally with a note ("…it's the wine Sam liked"). Wink works out what you're looking at and confirms in your ear.
- **Ask later:** "Hey Wink, what was that book?" / "Where did I put my keys?" You get a spoken answer plus the exact moment, on your phone and the TV.
- **Glance:** "Hey Wink, what's this?" explains what you're looking at without saving it.
- **Find it nearby:** "Hey Wink, where can I get this nearby?" Matches the item to real places from **Overture Maps Places in Snowflake**.
- **Your hands are the cursor** (the glasses camera sees your hands):
  - ☝️ **Point** at one object, then say "save this": saves only that object.
  - 🖐🖐 **Two-hand frame**: instantly saves what's inside the frame.
  - ✋ **Palm**: pause or resume Wink (privacy).
  - 👍 **Thumbs up**: confirm. ✌️ **1–3 fingers**: pick an option.
  - 🫰 **Pinch and move**: drive a cursor on the TV memory wall, Vision Pro style. Pinch opens a memory, a flick deletes it.

**Pitch:** *Everyday:* "Your glasses remember so you don't have to." *Tech:* "Voice and gesture interaction running on open models end to end. Your fingers are the cursor and the world is the interface."

## 3. Prize targets and how we satisfy each

| Prize | Requirement | How Wink meets it |
|---|---|---|
| Best Open-Source AI (main) | Open-source/open-weight AI is central; public GitHub repo with an OSS license | gpt-oss-120b (reasoning), open vision model, Whisper via WhisperKit (wake word + speech), MediaPipe Hands (gestures), Arctic Embed (memory vectors). MIT license. |
| Best Open-Source AI with Snowflake | CoCo + a free Snowflake dataset + open AI | Free dataset: **Overture Maps Places** (CARTO, Snowflake Marketplace). CoCo explores its nested schema, writes the nearby query, and designs the memory table and vector search. Screenshots go in `docs/coco/`. |
| Best Open-Source AI (sponsored by DigitalOcean) | Open-weight AI is important to how it works | gpt-oss-120b (answers) and Mistral Small 3.1 (vision) on Cloudflare Workers AI, plus Whisper and MediaPipe on device. DigitalOcean inference needs a card on file, so `CHAT_PROVIDER`/`VISION_PROVIDER` can switch back to DigitalOcean with one setting if a key becomes available. |
| Best Use of Snowflake | AI features in a data application | A RAG memory assistant: memories stored as `VECTOR(FLOAT,1024)` with Cortex `EMBED_TEXT_1024`, searched with `VECTOR_COSINE_SIMILARITY`, and grounded in Overture Places. |

**Demo must say out loud:** the dataset name (Overture Maps Places by CARTO), how CoCo helped (show the screenshots), and which models are open (gpt-oss, Whisper, MediaPipe, Arctic Embed).

## 4. Architecture

```
Meta Ray-Ban glasses
  │  camera (720p/30fps, Bluetooth via Meta Wearables Device Access Toolkit)
  │  mic + speakers (Bluetooth HFP)
  ▼
iOS app (ios/, Arboy)
  ├─ WhisperKit (on-device): "Hey Wink" wake word + command transcription → IntentParser
  ├─ MediaPipe Hand Landmarker (on-device): point / frame / palm / thumbs / pinch / flick
  ├─ crops the frame to the selected region, AVSpeechSynthesizer replies into the glasses
  └─ HTTPS + WebSocket ───────────────────────────────┐
                                                      ▼
Cloudflare Worker `wink-api` (backend/, Messi)  ── docs/api.md is the contract
  ├─ R2 `wink-images`: saved JPEGs
  ├─ Durable Object `LiveRoom`: WebSocket hub, relays glasses → TV, pushes results
  ├─ /tv: static big-screen dashboard (backend/public/tv)
  ├─► Workers AI: Mistral Small 3.1 (what is it, visible text) + gpt-oss-120b (answers, speech)
  └─► Snowflake SQL API (PAT auth)
        ├─ WINK.APP.MEMORIES: memories + Arctic Embed vectors, cosine search
        └─ Overture Maps Places (CARTO listing): nearby places, business matching
```

Key decisions:
- **The contract is `docs/api.md`.** Both sides build against it. The backend's `MOCK=true` mode lets iOS integrate before keys exist.
- **The phone crops, the backend never re-crops.** Gesture selection boxes are applied on-device.
- **No Cortex Search for live memory:** its refresh lag would hide a memory saved 30 seconds ago. We query the `VECTOR` column directly, so new rows are searchable immediately.
- **Speech replies are short** (≤ 25 words) because they're spoken in the ear.
- **Fallbacks:** phone camera instead of the glasses camera (same pipeline); push-to-talk instead of the wake word; DigitalOcean Gradient as an alternative provider (`CHAT_PROVIDER=digitalocean`); Apple Vision hand pose if MediaPipe or CocoaPods blocks the build.

## 5. Scope

### Must ship (M1–M2), the demo depends on these
1. "Hey Wink, save this" → saved memory with spoken confirmation (glasses camera, or phone camera as fallback).
2. "Hey Wink, what was …?" → spoken answer + matching image.
3. Point-to-select and two-hand frame gestures; palm to pause.
4. TV dashboard: live status/transcript, memory wall animating in, answer panel.
5. Real backend: Workers AI vision + gpt-oss, Snowflake storage + vector search.

### Should ship (M3)
6. "Where can I get this nearby?" via Overture Places.
7. Pinch-driven TV cursor: pinch to open, flick to delete.
8. "Hey Wink, what's this?" glance.

### Cut unless everything else is done
- Passive capture mode (continuous ~1 fps memory).
- Calling a store from the nearby results (Twilio).
- Lasso gesture. Face blurring (state it as the privacy roadmap in the pitch).

### Non-goals
Accounts and multi-user support, App Store distribution (the Meta toolkit is in developer preview), drawing on the Ray-Ban Display HUD.

## 6. Timeline (now → 9:00 PM)

| Time | Arboy (glasses / iOS) | Messi (backend / TV / Snowflake) | Done when |
|---|---|---|---|
| 6:55–7:10 | Run Meta's sample app on the glasses (camera + mic at the same time); open the Wink workspace, sign, run on the iPhone; connect accounts (DO key, Snowflake + Overture listing + PAT, Cloudflare R2) | `npm run dev` in MOCK; start CoCo exploration on Arboy's Snowflake account (screenshots); code only, no cloud resources | Both can run their half |
| 7:10–7:45 | **M1:** wake word + save + ask against the MOCK backend; speech in the glasses | **M1:** real `/memories` + `/ask` (R2, vision, Snowflake insert + vector search) | "Save this" → "what was that?" works on the mock |
| 7:45–8:15 | **M2:** point / frame / palm gestures, selection crop, live socket events | **M2:** TV dashboard live (status, memory wall, answer panel); deploy the Worker | End-to-end on real models, TV updating |
| 8:15–8:35 | **M3:** pinch pointer mode, nearby intent | **M3:** `/nearby` on Overture, pointer/flick on the TV | Stretch features working |
| 8:35–8:50 | **Freeze.** Rehearse the demo, record the backup video | **Freeze.** README, Devpost text, CoCo screenshots | Nothing new after 8:35 |
| 8:50–9:00 | Submit: public GitHub repo, MIT license, Devpost | | Submitted |

If behind at 8:00: drop M3 entirely and polish M1–M2.

## 7. Task split

### Arboy (Claude Code): `ios/`
- [ ] A1 Glasses connection: DAT registration, camera stream into `GlassesFrameSource`; phone-camera fallback toggle.
- [ ] A2 Audio: session routed to the glasses (HFP), WhisperKit model preload, VAD + wake phrase, push-to-talk.
- [ ] A3 IntentParser + WinkController routing to `/memories`, `/ask`, `/glance`, `/nearby`, `DELETE`.
- [ ] A4 Speech out + earcons in the glasses.
- [ ] A5 MediaPipe hands → GestureClassifier (point, frame, palm, thumbsUp, fingers, pinch, flick) → selection crop.
- [ ] A6 LiveSocket: status/transcript/gesture events; pointer events in TV mode; optional POV `frame` previews.
- [ ] A7 Demo screen polish + settings (base URL/token).

- [ ] A8 Accounts (Arboy owns them): DO model access key (`/v1/models` → pick `VISION_MODEL`), Snowflake Overture listing + `01_setup.sql` + PAT, R2 bucket, `WINK_TOKEN`, deploy, MOCK off. Checklist in `AGENTS.md` → Handoffs.

### Messi (Codex): `backend/`, `backend/public/tv/`, `snowflake/`, code only
Messi's work is code only; Arboy connects the accounts and deploys.
- [ ] M1 Make the real paths robust against `MOCK=false` (error handling, timeouts, fallbacks) so the first real run works.
- [ ] M2 `/v1/memories`: R2 → vision JSON → Snowflake insert with embedding → broadcast.
- [ ] M3 `/v1/ask`: vector search → gpt-oss answer → broadcast.
- [ ] M4 LiveRoom Durable Object + `/v1/events` relay.
- [ ] M5 TV dashboard: status, transcript, memory wall, answer panel, nearby panel, gesture toasts, pointer cursor.
- [ ] M6 `/v1/nearby` on Overture Places (CoCo-assisted query).
- [ ] M7 Write any deploy steps Arboy needs into `AGENTS.md` → Handoffs (Arboy deploys).
- [ ] M8 CoCo screenshots into `docs/coco/` + the Snowflake section of the README.

### Shared
- [ ] S1 Stage the demo table (book, wine bottle or snack, sticky note with a fake Wi-Fi password, keys, mug).
- [ ] S2 README, LICENSE, Devpost write-up (dataset, CoCo usage, open models).
- [ ] S3 Backup demo video by 8:45.

## 8. Demo script (≈3 minutes): see `demo/DEMO.md`

## 9. Risks

| Risk | Mitigation |
|---|---|
| Glasses camera and Bluetooth mic don't run together, or the stream drops | Check with Meta's sample app first; phone-camera toggle uses the same pipeline |
| "Wink" misheard by Whisper | Fuzzy wake variants; push-to-talk button |
| Venue Wi-Fi | Deployed Worker over a phone hotspot; backup video |
| DigitalOcean requires a card | Workers AI runs the same open models (switched 19:55) |
| Snowflake PAT blocked by network policy | Hackathon network policy allowing all IPs on the Wink service user |
| Gesture false positives | Hold timers + cooldowns + earcon feedback; palm pause |
| Judge wears prescription glasses | A teammate wears Wink and the judge directs what to look at and gestures in view |

## 10. Privacy stance (say it in the demo)
Wink only captures when you ask (voice or gesture); there is no passive recording in the demo build. The camera LED is visible. Memories live in your own Snowflake account and R2 bucket, and "Hey Wink, forget that" deletes one. All AI is open-weight, so it can be self-hosted end to end. Roadmap: on-device face blurring before upload.
