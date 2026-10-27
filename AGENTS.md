# AGENTS.md: Wink

Shared context for every coding agent on this repo. Codex reads this file; Claude Code reads it through `CLAUDE.md`. Edit this file, not a copy, so all agents stay in sync.

Wink is smart-glasses memory for Meta Ray-Ban glasses: "Hey Wink, save this" captures what the wearer sees (cropped to what they point at or frame with their hands), and "Hey Wink, what was that book?" answers in their ear. A Cloudflare Worker stores memories in R2 + Snowflake, reasons with open-weight models on DigitalOcean, and drives a big-screen TV dashboard. Built at the Hacktoberfest 2026 mini hackathon (Hacklahoma); **projects are due 9:00 PM on 2026-10-26**, so favor working, demoable code over polish.

- Product and scope: `PRD.md` (what to build, the cut list, the timeline, who owns what).
- **API contract: `docs/api.md`.** Both halves build against it. Never change it unilaterally (see "Coordination").
- Demo script: `demo/DEMO.md`.

## Team and ownership

| Person | Agent | Owns | Never edits without asking |
|---|---|---|---|
| **Arboy** | Claude Code | `ios/` (glasses, voice, gestures, iOS UI) | `backend/`, `snowflake/` |
| **Messi** | Codex | `backend/` (Worker + `public/tv/` dashboard), `snowflake/` | `ios/` |
| Both | — | `docs/api.md`, `PRD.md`, `AGENTS.md`, `README.md`, `demo/` | — |

If your task needs a change in the other person's folder, stop and write it down as a request in "Handoffs" below instead of editing their code.

**Accounts belong to Arboy.** Arboy holds the Cloudflare, DigitalOcean and Snowflake accounts and connects them: secrets, R2 bucket, Marketplace listing, PAT, deploys. Messi's side is **code only**: build and test against `MOCK=true`, never run `wrangler login`, `wrangler deploy`, `wrangler secret put` or `wrangler r2 bucket create`, and don't create cloud resources. When something needs an account, write the exact steps in "Handoffs" for Arboy.

## Repo layout

```
wink/
├── PRD.md, AGENTS.md, CLAUDE.md, README.md, LICENSE (MIT)
├── docs/api.md          # the contract
├── docs/coco/           # Snowflake CoCo screenshots for the judges
├── demo/DEMO.md         # 3-minute demo script + table staging
├── ios/                 # SwiftUI app (XcodeGen project.yml → Wink.xcodeproj, CocoaPods → Wink.xcworkspace)
├── backend/             # Cloudflare Worker `wink-api` (TypeScript), Durable Object LiveRoom, R2, TV page in public/tv/
└── snowflake/           # setup SQL, Overture exploration, the app's queries, CoCo checklist
```

## Stack and open models

- **Glasses:** Meta Wearables Device Access Toolkit (`facebook/meta-wearables-dat-ios`, SPM; `MWDATCore`, `MWDATCamera`). Camera stream ≤ 720p/30fps over Bluetooth. Mic and speakers go through normal Bluetooth audio (HFP). No access to "Hey Meta" and no drawing on the Display HUD.
- **On-device AI (iOS):** WhisperKit (`argmaxinc/argmax-oss-swift`, exact 1.1.1, Whisper `base.en`) for the "Hey Wink" wake word and commands; MediaPipe Hand Landmarker (CocoaPods `MediaPipeTasksVision`, model `hand_landmarker.task`) for gestures; AVSpeechSynthesizer for replies.
- **Backend:** Cloudflare Workers + Durable Objects (WebSocket Hibernation API) + R2 + static assets.
- **Inference:** DigitalOcean Gradient serverless inference (`https://inference.do-ai.run/v1`, OpenAI-compatible): `openai-gpt-oss-120b` for answers and speech, `VISION_MODEL` for images (check `/v1/models`). Fallback vision: Workers AI `@cf/meta/llama-3.2-11b-vision-instruct`.
- **Data:** Snowflake SQL API v2 with a programmatic access token. `WINK.APP.MEMORIES` holds memories with `VECTOR(FLOAT,1024)` from `SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', …)`, searched with `VECTOR_COSINE_SIMILARITY`. The free dataset is **Overture Maps Places** (CARTO listing on the Snowflake Marketplace), table configured by `OVERTURE_PLACES_TABLE`.

## Running things

### Backend (`backend/`)
```bash
cd backend && npm ci && npm run check && npm run build
npm run dev -- --ip 0.0.0.0     # phone on the same Wi-Fi uses http://<mac-lan-ip>:8787
```
- `MOCK=true` (default in `wrangler.jsonc`) returns canned data for every route, so iOS and the TV work with no keys.
- Secrets live only in ignored `.dev.vars` locally or `wrangler secret put` when deployed: `WINK_TOKEN`, `DO_MODEL_ACCESS_KEY`, `SNOWFLAKE_PAT`. Never commit keys.
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
| A1 glasses camera stream | Arboy | 🟡 | code written, untested on glasses (`TODO(glasses)`), check frame orientation |
| A2 wake word + push-to-talk | Arboy | 🟡 | code written; Whisper base.en loads; voice loop untested on device |
| A3 intents → API | Arboy | ✅ | every route verified against MOCK |
| A4 speech into glasses | Arboy | 🟡 | HFP routing untested on device |
| A5 gestures + selection crop | Arboy | 🟡 | thresholds tuned on synthetic hands only; tune on real footage |
| A6 live socket events / pointer | Arboy | ✅ | socket connects; flick only sends the event, TV decides what to delete |
| M1 keys (DO, Snowflake PAT, R2, token) | Arboy | ⬜ | accounts are Arboy's |
| M2 `/memories` real | Messi | ⬜ | |
| M3 `/ask` real | Messi | ⬜ | |
| M4 LiveRoom relay | Messi | ⬜ | |
| M5 TV dashboard | Messi | ⬜ | |
| M6 `/nearby` on Overture | Messi | ⬜ | |
| M7 deploy + MOCK off | Arboy | ⬜ | after M1 |
| M8 CoCo screenshots | Messi | ⬜ | |
| Demo video + Devpost | Both | ⬜ | |

## Handoffs

Newest first. Format: `HH:MM from → to: message`.

- 19:20 Arboy → Messi: iOS app is in (PR from `arboy/ios-scaffold`). It sends `flick` gesture events only; the TV must pick the highlighted memory and call `DELETE`. "Forget that" is confirmed with a thumbs up before the app calls `DELETE`.
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
1. DigitalOcean: create a model access key; `curl https://inference.do-ai.run/v1/models -H "Authorization: Bearer $KEY"`; pick `VISION_MODEL`, confirm `openai-gpt-oss-120b`.
2. Snowflake: get "Overture Maps - Places" (CARTO) from the Marketplace, **then** run `snowflake/01_setup.sql` as ACCOUNTADMIN; copy the PAT (shown once); note the account URL.
3. Cloudflare: `npx wrangler login`, `npx wrangler r2 bucket create wink-images`.
4. Secrets: `WINK_TOKEN` (any long random string), `DO_MODEL_ACCESS_KEY`, `SNOWFLAKE_PAT` into `backend/.dev.vars` and `wrangler secret put`; set `SNOWFLAKE_ACCOUNT_URL` + `VISION_MODEL` in `wrangler.jsonc`.
5. `npm run deploy`, set `"MOCK": "false"`, deploy again, check `/v1/health`.

## Decisions log

- Memory search queries the `VECTOR` column directly, not Cortex Search, because Cortex Search's refresh lag would hide just-saved memories.
- The demo build captures only on request (voice or gesture). Passive capture is on the cut list.
- The iOS project is generated by XcodeGen; both `project.yml` and the generated project are committed so it opens without XcodeGen.
