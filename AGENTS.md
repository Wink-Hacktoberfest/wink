# AGENTS.md: Wink

Shared context for every coding agent on this repo. Codex reads this file; Claude Code reads it through `CLAUDE.md`. Edit this file, not a copy, so all agents stay in sync.

Wink is smart-glasses memory for Meta Ray-Ban glasses: "Hey Wink, save this" captures what the wearer sees (cropped to what they point at or frame with their hands), and "Hey Wink, what was that book?" answers in their ear. A Cloudflare Worker stores memories in R2 + Neon Postgres, reasons with open-weight models on DigitalOcean, and drives a big-screen TV dashboard. Built at the Hacktoberfest 2026 mini hackathon (Hacklahoma); **projects are due 9:00 PM on 2026-10-26**, so favor working, demoable code over polish.

- Product and scope: `PRD.md` (what to build, the cut list, the timeline, who owns what).
- **API contract: `docs/api.md`.** Both halves build against it. Never change it unilaterally (see "Coordination").
- Demo script: `demo/DEMO.md`.

## Team and ownership

| Person | Agent | Owns | Never edits without asking |
|---|---|---|---|
| **Arboy** | Claude Code | `ios/` (glasses, voice, gestures, iOS UI) | `backend/`, `neon/`, `snowflake/` |
| **Messi** | Codex | `backend/` (Worker + `public/tv/` dashboard), `neon/`, `snowflake/` | `ios/` |
| Both | — | `docs/api.md`, `PRD.md`, `AGENTS.md`, `README.md`, `demo/` | — |

If your task needs a change in the other person's folder, stop and write it down as a request in "Handoffs" below instead of editing their code.

**Accounts belong to Arboy.** Arboy holds the Cloudflare and Snowflake accounts and connects them: secrets, R2 bucket, Marketplace listing, PAT, deploys. Messi's side is **code only**: build and test against `MOCK=true`, never run `wrangler login`, `wrangler deploy`, `wrangler secret put` or `wrangler r2 bucket create`, and don't create cloud resources. When something needs an account, write the exact steps in "Handoffs" for Arboy.

## Repo layout

```
wink/
├── PRD.md, AGENTS.md, CLAUDE.md, README.md, LICENSE (MIT)
├── docs/api.md          # the contract
├── docs/coco/           # Snowflake CoCo screenshots for the judges
├── demo/DEMO.md         # 3-minute demo script + table staging
├── ios/                 # SwiftUI app (XcodeGen project.yml → Wink.xcodeproj, CocoaPods → Wink.xcworkspace)
├── backend/             # Cloudflare Worker `wink-api` (TypeScript), Durable Object LiveRoom, R2, TV page in public/tv/
├── neon/                # memory store: Postgres + pgvector schema, setup runbook
└── snowflake/           # Overture Places setup + exploration, the nearby queries, CoCo checklist
```

## Stack and open models

- **Glasses:** Meta Wearables Device Access Toolkit (`facebook/meta-wearables-dat-ios`, SPM; `MWDATCore`, `MWDATCamera`). Camera stream ≤ 720p/30fps over Bluetooth. Mic and speakers go through normal Bluetooth audio (HFP). No access to "Hey Meta" and no drawing on the Display HUD.
- **On-device AI (iOS):** WhisperKit (`argmaxinc/argmax-oss-swift`, exact 1.1.1, Whisper `base.en`) for the "Hey Wink" wake word and commands; MediaPipe Hand Landmarker (CocoaPods `MediaPipeTasksVision`, model `hand_landmarker.task`) for gestures; AVSpeechSynthesizer for replies.
- **Backend:** Cloudflare Workers + Durable Objects (WebSocket Hibernation API) + R2 + static assets.
- **Inference:** Cloudflare Workers AI through the `AI` binding (no key needed): `@cf/openai/gpt-oss-120b` for answers and speech (`CHAT_PROVIDER=workers-ai`), `@cf/mistralai/mistral-small-3.1-24b-instruct` for images (`VISION_PROVIDER=workers-ai`), `@cf/deepgram/aura-2-en` for the spoken reply (`POST /v1/speak`; ElevenLabs instead when `ELEVENLABS_API_KEY` is set). Both are verified live on Arboy's account and return OpenAI `chat.completion` objects; gpt-oss keeps its reasoning in a separate field. DigitalOcean Gradient (`https://inference.do-ai.run/v1`) remains supported by setting both providers to `digitalocean` + `DO_MODEL_ACCESS_KEY`, but DigitalOcean requires a card on file, so it is off. Fallback vision: Workers AI `@cf/meta/llama-3.2-11b-vision-instruct`.
- **Memories:** Neon Postgres over HTTP (`@neondatabase/serverless`, secret `DATABASE_URL`). Table `memories` with `vector(1024)` from Workers AI `@cf/baai/bge-m3`, searched with pgvector cosine distance (`<=>`). Schema and setup in `neon/`.
- **Places:** Snowflake SQL API v2 with a programmatic access token, only for **Overture Maps Places** (CARTO listing on the Snowflake Marketplace), table configured by `OVERTURE_PLACES_TABLE`. The old `WINK.APP.MEMORIES` table is read once by `npm run copy:snowflake`.

## Running things

### Backend (`backend/`)
```bash
cd backend && npm ci && npm run check && npm run build
npm run dev -- --ip 0.0.0.0     # phone on the same Wi-Fi uses http://<mac-lan-ip>:8787
```
- `npm run dev` uses `wrangler.mock.jsonc` with `MOCK=true` and no remote AI binding, so iOS and the TV work with no keys or cloud account. `npm run dev:real` uses `wrangler.jsonc` for Arboy’s provider verification. `npm run smoke` checks a running MOCK server through HTTP + real WebSockets.
- Secrets live only in ignored `.dev.vars` locally or `wrangler secret put` when deployed: `WINK_TOKEN`, `DATABASE_URL`, `SNOWFLAKE_PAT` (and `DO_MODEL_ACCESS_KEY` only if switching back to DigitalOcean). Never commit keys.
- Workers' `fetch` rejects `redirect: 'error'`; use `redirect: 'manual'` for provider calls.
- TV: open `/tv?token=<WINK_TOKEN>` on the projector laptop.
- Backend-only changes don't need an iOS build.

### iOS (`ios/`)
```bash
cd ios && xcodegen generate && LANG=en_US.UTF-8 pod install
xcodebuild -workspace Wink.xcworkspace -scheme Wink -destination 'generic/platform=iOS Simulator' build
```
- `pod install` crashes under Ruby 4 without `LANG=en_US.UTF-8`.
- Packages: WhisperKit 1.1.1 (`argmax-oss-swift`), Meta DAT 1.0.1 (`MWDATCore`, `MWDATCamera`, `MWDATMockDevice`), CocoaPods `MediaPipeTasksVision` 1.0.0. A `post_integrate` hook in the Podfile keeps MediaPipe out of `WinkTests` (otherwise the test host crashes).
- Gestures use MediaPipe; Apple Vision hand pose (`VisionHandTracker`) takes over automatically only if the MediaPipe model fails to load.
- Glasses code paths are marked `// TODO(glasses):` and are untested until run with real glasses. Settings has a Debug-only "Enable mock glasses" (MWDATMockDevice) and a typed-command box for testing without speaking.
- Always open **`Wink.xcworkspace`**, not the `.xcodeproj` (CocoaPods).
- Files are listed in `ios/project.yml`. After adding or removing files, re-run `xcodegen generate` then `pod install`. Don't hand-edit `project.pbxproj`.
- Secrets: copy `ios/Config/Secrets.example.xcconfig` → `ios/Config/Secrets.xcconfig` (ignored). The base URL and token can also be changed in the in-app settings sheet.
- The glasses, camera and Bluetooth audio need a **physical iPhone** with the Meta AI app (developer mode on) and the glasses paired. The simulator only proves it compiles.
- Swift 5 mode with `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`: keep Whisper, MediaPipe and image work off the main actor. Use `@Observable`, not `ObservableObject`.
- Signing: team `BW3XQ8353L`, bundle id `com.arboymagomba.Wink`. Don't commit changes to `DEVELOPMENT_TEAM` or `PRODUCT_BUNDLE_IDENTIFIER`.

## Rules every agent follows

1. **Contract first.** iOS and backend talk only through the routes and types in `docs/api.md`. Mirror its types exactly (`ios/Wink/Services/API/WinkModels.swift`, the backend's TS types).
2. **`speech` is spoken in the ear:** ≤ 25 words, no markdown, emoji or URLs. The backend sanitizes it; iOS speaks it as-is.
3. **The phone crops, the backend never re-crops.** Selection boxes are normalized 0..1, origin top-left.
4. **Keep the demo path green.** Never leave `main` unable to build or run in MOCK mode. If a feature isn't ready, put it behind a flag rather than breaking the flow.
5. **Fallbacks stay working:** phone camera instead of glasses, push-to-talk instead of the wake word, `MOCK=true` instead of real models.
6. **Don't add scope.** Check `PRD.md` §5 before building anything; cut-list items wait until M1–M2 are done.
7. No secrets in code, plists, `wrangler.jsonc` vars, or commits.

## Coordination

- **Changing the contract:** propose it in "Handoffs", get the other person's OK, then update `docs/api.md` (and its changelog), the TS types, and `WinkModels.swift` in the same push.
- **Handing off work:** when you finish something the other side depends on (a deployed URL, a new field, a token), add a line to "Handoffs".
- **After each milestone**, update "Status" below (one line per item). This file is how both agents know where the project stands, so keep it current.

## Git

- Branch per task: `arboy/<topic>` or `messi/<topic>`. Merge to `main` quickly; folders don't overlap, so conflicts should be rare. Pull before starting and before merging.
- Shared files (`AGENTS.md`, `docs/api.md`, `PRD.md`, `README.md`): small commits, pull right before editing.
- Conventional Commits, lowercase, scoped by area: `feat(ios): add wake word listener`, `fix(backend): parse vision json defensively`, `feat(tv): animate saved memories`, `docs(api): add frame live event`. Scopes: `ios`, `gestures`, `voice`, `glasses`, `backend`, `tv`, `snowflake`, `api`, `docs`, `demo`, `project`.
- Never force-push `main`.
- Commits and PRs use only your own Git identity: no AI attribution lines or `Co-Authored-By` trailers.

## Status

Update one line per item: `✅ done` / `🟡 in progress` / `⬜ not started` / `❌ cut`.

| Item | Owner | Status | Notes |
|---|---|---|---|
| Repo, PRD, contract, agent docs | Arboy | ✅ | 2026-10-26 18:55 |
| Backend scaffold (routes, MOCK, LiveRoom, TV, Snowflake SQL) | Messi | ✅ | MOCK end to end; real DO/Snowflake calls untested |
| iOS scaffold (XcodeGen, WhisperKit, DAT, MediaPipe) | Arboy | ✅ | builds; 9 unit tests pass; ran in simulator against MOCK |
| A1 glasses camera stream | Arboy | ✅ | streams on Arboy's iPhone 15 Pro Max at `.low`/24 fps; session errors surfaced, stale sessions torn down, pixel-buffer frames converted. Frame orientation still untuned on real footage |
| A2 wake word + push-to-talk | Arboy | ✅ | works on device. Mic restarts on route changes on a fresh `AVAudioEngine`; uses the iPhone mic while the glasses camera streams (camera and HFP share one Bluetooth Classic link). "can you save this" phrasings count as saves |
| A3 intents → API | Arboy | ✅ | every route verified against MOCK |
| A4 speech into glasses | Arboy | ✅ | replies use the Aura-2 voice from `POST /v1/speak` (ElevenLabs if `ELEVENLABS_API_KEY` is set), built-in voice as fallback |
| A5 gestures + selection crop | Arboy | 🟡 | thresholds tuned on synthetic hands only; tune on real glasses footage |
| A6 live socket events / pointer | Arboy | ✅ | socket connects; flick only sends the event, TV decides what to delete |
| A8 keys (Snowflake PAT, R2, token) | Arboy | ✅ | R2, WINK_TOKEN, Snowflake setup + PAT (WINK_SVC, 7-day) done |
| A9 device signing + app logo | Arboy | ✅ | Hotspot/Wi-Fi entitlements dropped so a personal team signs; winking-glasses logo is the app icon, in-app header, and TV header + favicon |
| M1 provider reliability | Messi | ✅ | bounded calls, final-only chat, Workers AI fallback; tested with stubbed providers |
| M2 `/memories` real | Messi | ✅ | code + real-route transport tests; R2 cleanup and retryable deletion; live account check pending |
| M3 `/ask` real | Messi | ✅ | vector retrieval + grounded chat/fallback; live provider check pending |
| M4 LiveRoom relay | Messi | ✅ | validated events, rate caps, concurrent MOCK storage; local real-WebSocket smoke passes |
| M5 TV dashboard | Messi | ✅ | Chrome verified; privacy pause, reconnect/resync, pointer, accessible memory details |
| PR4 TV + mobile UI redesign | Messi | ✅ | User authorized iOS UI changes; responsive light theme, functional navigation/search/ask, original rotating glasses model; see `docs/ui/README.md` |
| M6 `/nearby` on Overture | Messi | ✅ | code detects taxonomy/categories and validates geography; actual share/category check pending |
| M7 deploy + MOCK off | Arboy | ✅ | https://wink-api.arboydev.workers.dev, real save/ask/nearby/delete verified |
| M9 memories on Neon | Arboy | 🟡 | Neon project `wink` (Ohio) live, 7 memories copied + embedded, save/ask/delete verified locally with `dev:real`; deploy pending |
| M8 CoCo screenshots | Messi | ⬜ | checklist and 04_verify.sql ready; actual Arboy account session/evidence required |
| Demo video + Devpost | Both | 🟡 | 30-second video in `demo/video/` (commit `68ebef2`) is on `arboy/ios-ui-polish`, not on `main` |

## Handoffs

Newest first. Format: `HH:MM from → to: message`.

- 2026-10-27 Arboy → Messi: memories moved from Snowflake to **Neon Postgres + pgvector** (branch `arboy/neon-memories`; Arboy asked for it, so I edited `backend/`). `src/neon.ts` owns every memory query; `src/snowflake.ts` keeps only Overture places. Embeddings are Workers AI `@cf/baai/bge-m3` (1024-d), computed in the Worker; a save whose embedding fails is still stored and `GET /v1/memories` backfills it. `ASK_MIN_SCORE` is now 0.40 with a 0.08 relative gap (from a small BGE-M3 test). API contract unchanged; MOCK unchanged. New secret `DATABASE_URL`; schema and runbook in `neon/`.

- 23:50 Arboy → Messi: glasses work from tonight is on `main` (PRs #5–#8), running on Arboy's iPhone 15 Pro Max with the glasses streaming:
  - **Signing:** Hotspot Configuration and Access Wi-Fi Information entitlements are gone; only the keychain group remains, so a personal team can sign.
  - **Voice:** "can you save this" and similar phrasings count as saves. Replies are spoken with Aura-2 from `POST /v1/speak` (contract v1.1). The mic restarts on route changes on a fresh `AVAudioEngine`.
  - **Bluetooth:** the glasses camera and the glasses' HFP mic share one Bluetooth Classic link, so Wink listens on the iPhone mic while the glasses camera streams.
  - **Glasses camera:** session errors are surfaced, stale sessions torn down, pixel-buffer frames converted; streams at `.low`/24 fps. Frame orientation and gesture thresholds are still untuned on real footage.
  - **Logo:** the winking-glasses logo is the app icon, the in-app header, and the TV header and favicon (`backend/public/tv/logo.png`).
  - The 30-second demo video (`68ebef2`, `demo/video/`) is on `arboy/ios-ui-polish` and not merged to `main`.

- 20:28 Messi → Arboy: PR4 visual refinement rebuilds glasses with smooth thin acetate geometry/PBR lighting, bundles OFL Manrope on web/iOS, tightens reference-inspired layouts and adds reduced-motion-aware transitions. Four generated MOCK-only photographs replace sample SVGs (uploaded images unchanged); versioned sample URLs retire cached artwork. Native build + 9 tests, backend typecheck + 74 tests and local smoke pass. Screenshots and asset prompts updated under `docs/ui/`.

- 20:22 Messi → Arboy: PR4 redesign updates TV + native iOS at the user’s explicit request. API contract, services, signing and bundle identifiers are unchanged. TV has responsive memory search/Today filters, typed Ask, companion tabs, gesture selection and privacy behavior; iOS adds Home/Capture/Ask navigation around the existing controller. Original local glasses GLB + matching SceneKit DAE rotate with pause/reduced-motion controls; provenance/regeneration instructions are in `backend/public/tv/models/ASSETS.md`. Full native simulator build + 9 iOS tests, backend typecheck + 74 tests, dry-run build and local HTTP/WebSocket smoke passed; see `docs/ui/README.md` for final validation. No cloud deployment was performed. Arboy can deploy after review.

- 20:10 Arboy → Messi: **deployed and live** at `https://wink-api.arboydev.workers.dev` with `MOCK=false` (TV at `/tv?token=…`). Snowflake fixes you should know about:
  - The listing database is `OVERTURE_MAPS_PLACES` (one underscore); table `OVERTURE_MAPS_PLACES.CARTO.PLACE`, 81M rows.
  - New accounts can't call `SNOWFLAKE.CORTEX.EMBED_TEXT_1024`; everything now uses `AI_EMBED` (same Arctic Embed model, `VECTOR(FLOAT,1024)`).
  - `AI_EMBED` rejects a bound model argument, so `insertMemorySql(model)` / `searchMemoriesSql(model)` inline a regex-validated model id; only the text is bound.
  - Verified for real: save (~8 s), ask (~4 s), nearby (5 real coffee shops, closest 255 m), delete.

- 19:55 Arboy → Messi: DigitalOcean won't issue an inference key without a credit card, so the backend now defaults to Workers AI for both chat and vision (PR `arboy/workers-ai-models`). `CHAT_PROVIDER=workers-ai` runs `@cf/openai/gpt-oss-120b`; `VISION_PROVIDER=workers-ai` runs `@cf/mistralai/mistral-small-3.1-24b-instruct` (Apache-2.0, no license gate) with an `image_url` message. Llama 3.2 Vision still uses its prompt+image schema if selected. 64 tests pass; real `/v1/glance` verified end to end on Arboy's account (~8 s). The DigitalOcean path is untouched and returns with `CHAT_PROVIDER`/`VISION_PROVIDER=digitalocean`.

- 19:20 Arboy → Messi: iOS app is in (PR from `arboy/ios-scaffold`). It sends `flick` gesture events only; the TV must pick the highlighted memory and call `DELETE`. "Forget that" is confirmed with a thumbs up before the app calls `DELETE`.
- 19:13 Messi → Arboy: backend implementation is ready on `messi/backend-complete` locally. Typecheck + 61 tests + dry-run build pass; HTTP/WebSocket smoke confirms save → ask → nearby → delete and TV broadcasts. API contract unchanged; no iOS files edited. `npm run dev` now uses a local-only MOCK config (no Cloudflare account); `npm run smoke` tests the running server (`WINK_BASE_URL` overrides port). Use `npm run dev:real` for accounts configured in `wrangler.jsonc`.
  - Finish the account checklist below, accept the Workers AI vision model license once in your account if using fallback, then run the real save/glance/ask/nearby/delete checks. The Worker no longer accepts license terms automatically.
  - Run `snowflake/04_verify.sql` as `WINK_APP`; confirm the actual Overture table has GEOGRAPHY and current TAXONOMY or legacy CATEGORIES. Runtime detects that column and handles native/wrapped arrays; CoCo must confirm real category ids and distances. See `snowflake/README.md` for exact screenshot prompts. M8 is pending actual evidence, not completed by local tests.
  - Timeouts can follow a committed INSERT; preserve and reconcile that memory/image before retrying. Explicit initial SQL rejections clean up the uploaded image; deletion failures leave the row retryable. Saved images are not browser-cached.
  - Deploy and turn MOCK off only after provider checks. No deployment, secrets, or cloud resources were changed by Messi.

- 19:05 Arboy → Messi: backend scaffold is on `main` and passes `npm run check` (18 tests) + `npm run build`. MOCK mode works end to end, including `/tv`. Your next steps are code only: harden the real paths in `src/inference.ts`, `src/snowflake.ts` and `routes/`, then polish the TV (M5). Arboy connects the accounts and deploys. Scaffold choices to know about:
  - With `MOCK=true` and no `WINK_TOKEN`, auth is skipped. With `MOCK=false` and no token, authenticated routes return 503.
  - `GET /v1/health` is public.
  - Mock memories persist in the Durable Object.
  - `MEMORIES` has an extra `product_query` column that `/v1/nearby` uses.
  - Vision falls back to Workers AI Llama 3.2 when `VISION_MODEL` is empty.
  - The `/v1/ask` cosine cutoff is 0.30, a guess to tune once real memories exist.
  - Untested: DO's `reasoning_effort` support, the Overture column shapes (`NAMES:primary`, `PHONES:list[0]:element`, `ADDRESSES:list[0]:element:freeform`, `GEOMETRY` type). Verify those with CoCo.
- 18:55 Arboy → Messi: contract v1 is in `docs/api.md`.

### Account setup checklist (Arboy)
1. ~~DigitalOcean key~~: replaced by Workers AI (DigitalOcean needs a card). ✅ Cloudflare login + `wink-images` bucket done.
2. Snowflake: get "Overture Maps - Places" (CARTO) from the Marketplace, **then** run `snowflake/01_setup.sql` as ACCOUNTADMIN; copy the PAT (shown once); note the account URL.
3. Cloudflare: `npx wrangler login`, `npx wrangler r2 bucket create wink-images`.
4. Secrets: `WINK_TOKEN` (any long random string), `DO_MODEL_ACCESS_KEY`, `SNOWFLAKE_PAT` into `backend/.dev.vars` and `wrangler secret put`; set `SNOWFLAKE_ACCOUNT_URL` + `VISION_MODEL` in `wrangler.jsonc`.
5. `npm run deploy`, set `"MOCK": "false"`, deploy again, check `/v1/health`.

## Decisions log

- 19:55: inference moved to Cloudflare Workers AI (same gpt-oss-120b, Mistral Small 3.1 for vision) because DigitalOcean requires a card on file. The Best Open-Source AI prize only requires open-weight AI.

- 2026-10-27: memories moved to Neon (Postgres + pgvector) after the hackathon. One ordinary database is easier to inspect, export and run per-user queries on than Snowflake (warehouse cold starts, expiring PATs, credit cost) or per-user Durable Objects. Snowflake stays for Overture places until nearby has a replacement.
- Memory search queries the vector column directly (now pgvector; before that, not Cortex Search, whose refresh lag would hide just-saved memories).
- The demo build captures only on request (voice or gesture). Passive capture is on the cut list.
- The iOS project is generated by XcodeGen; both `project.yml` and the generated project are committed so it opens without XcodeGen.
