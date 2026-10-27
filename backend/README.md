# Wink backend (`wink-api`)

Cloudflare Worker for Wink: stores memories (R2 images + Snowflake rows with Arctic Embed vectors), describes images with an open vision model, answers with `gpt-oss-120b` on Cloudflare Workers AI (DigitalOcean Gradient optional), finds nearby places in Overture Maps Places, and drives the TV dashboard over a Durable Object WebSocket room. The API contract is [`../docs/api.md`](../docs/api.md).

```
src/index.ts        router, bearer auth, CORS, JSON errors      src/live.ts       LiveRoom DO (WebSocket Hibernation) + MOCK store
src/events.ts       validates phone events and normalized coordinates
src/routes/*.ts     memories, glance, ask, nearby, images/events src/inference.ts  Workers AI or DigitalOcean chat/vision
src/snowflake.ts    SQL API v2 client + all queries              src/speech.ts     speech sanitizer (≤ 25 words, no markdown/emoji/URLs)
src/mock.ts         canned memories, places, placeholder art     src/prompts.ts    model prompts
public/tv/          the big-screen dashboard (/tv)
```

## Run locally

```bash
npm ci
npm run check                    # typecheck + tests
npm run dev -- --ip 0.0.0.0      # local-only MOCK server; no account or keys needed
# In another terminal, with the server running:
npm run smoke                   # HTTP + real WebSocket flow; creates/deletes its own test memory
```
Find the Mac's LAN IP with `ipconfig getifaddr en0`. TV: open `http://localhost:8787/tv?token=<WINK_TOKEN>` (press `f` for fullscreen).

`npm run dev` uses `wrangler.mock.jsonc`, which omits the remote AI binding so Wrangler does not require a Cloudflare account. Every route uses canned data; saved/deleted memories persist in the local Durable Object, uploads go to the R2 simulator, and all live events reach the TV. With `WINK_TOKEN` unset, auth is skipped. Do not override `MOCK=false` in this configuration. Use `npm run dev:real` with account configuration for real provider checks.

The smoke test refuses to mutate a server unless `/v1/health` reports `mock: true`. Set `WINK_BASE_URL` if Wrangler uses another port, and `WINK_TOKEN` if authentication is enabled. Example: `WINK_BASE_URL=http://127.0.0.1:8788 npm run smoke`.

## Secrets

Copy `.dev.vars.example` to `.dev.vars` (git-ignored) and fill:

| Name | What |
|---|---|
| `WINK_TOKEN` | Shared bearer token for iOS and the TV (`openssl rand -hex 24`). Required when `MOCK=false`. |
| `DO_MODEL_ACCESS_KEY` | DigitalOcean → Agent Platform / Gradient → Serverless inference → Model access keys |
| `SNOWFLAKE_PAT` | Programmatic access token for `WINK_SVC` (see `../snowflake/README.md`) |

Deployed: `npx wrangler secret put WINK_TOKEN` (and the other two).

## Pick the DigitalOcean vision model

```bash
curl -s https://inference.do-ai.run/v1/models -H "Authorization: Bearer $DO_MODEL_ACCESS_KEY" | jq -r '.data[].id'
```
Choose an open vision-capable model from the list (Llama 3.2 Vision / Llama 4 / Qwen-VL style ids) and set `VISION_MODEL` in `wrangler.jsonc`. Confirm `openai-gpt-oss-120b` is listed for `CHAT_MODEL`. While `VISION_MODEL` is empty (or `VISION_PROVIDER="workers-ai"`), vision uses Workers AI `@cf/meta/llama-3.2-11b-vision-instruct`; the account owner must accept Meta's model license before the first request. Inference never accepts account terms automatically. The Worker also falls back to Workers AI if the configured DigitalOcean vision call fails.

Quick vision check once `MOCK=false`:
```bash
curl -s http://localhost:8787/v1/glance -H "Authorization: Bearer $WINK_TOKEN" \
  -F image=@photo.jpg -F 'meta={"utterance":"what is this","location":null}'
```

## Cloudflare resources

```bash
npx wrangler login
npx wrangler r2 bucket create wink-images
npm run deploy            # creates the LiveRoom Durable Object via the v1 migration
```
The deploy prints `https://wink-api.<subdomain>.workers.dev`; share it in AGENTS.md "Handoffs". The TV is at `/tv?token=…`.

## Switching MOCK off

1. Snowflake set up per `../snowflake/README.md`; `SNOWFLAKE_ACCOUNT_URL` set in `wrangler.jsonc`.
2. `VISION_MODEL` chosen (or leave empty for Workers AI).
3. Secrets set (`.dev.vars` locally, `wrangler secret put` deployed).
4. `"MOCK": "false"` in `wrangler.jsonc`, then use `npm run dev:real` locally / redeploy. This is Arboy’s account setup step; the default `npm run dev` stays a local MOCK workflow.
5. Optional: `DEMO_LAT` / `DEMO_LNG` as the fallback location when the phone sends none.

`GET /v1/health` shows `mock` and the active models. Provider errors are logged with `console.error` (`npx wrangler tail` when deployed).

## Notes

- `/v1/live?token=…&role=tv|glasses`: glasses messages are relayed to TV sockets only; route events go to everyone. Send the text `ping` to get `pong` without waking the DO.
- Saved image responses use `Cache-Control: no-store`, so a successful forget cannot leave an immutable browser-cached image. R2 deletion must succeed before the row is removed; retrying a failed deletion is safe.
- Images are cleaned up after a definite rejected INSERT. A transport or polling failure may follow a committed INSERT, so its image is retained for reconciliation rather than breaking a saved memory. No SQL writes are automatically retried.
- Client WebSocket events are validated; forged `memory.*`/answer events are discarded. Pointer/frame traffic is capped at 20/2 messages per second per socket, including hibernation.
- Snowflake bindings are all `TEXT`; vectors are computed inline with `AI_EMBED` (see `../snowflake/03_app_queries.sql`).
- `/v1/ask` drops matches below cosine 0.30 (tune `ASK_MIN_SCORE` in `src/snowflake.ts` after a few real memories).
- Debug the TV from the browser console: `wink.handle({ type: 'pointer', x: 0.5, y: 0.5, pinching: true })`.

## Verification status

Typecheck, all 61 tests, production dry-run bundling, and the HTTP/WebSocket smoke test pass locally. Tests cover provider transports, real-route orchestration with stubbed providers, cleanup after partial failures, concurrent mock saves, speech limits, event validation, and TV privacy/reconnect behavior. The TV was also checked in Chrome with live MOCK answers and nearby results.

Real DigitalOcean/Snowflake calls, the service role's Overture schema and category vocabulary, deployment, and actual CoCo screenshots still require Arboy's accounts. Follow `../snowflake/README.md` and `../snowflake/04_verify.sql`; local success does not certify those account integrations.
