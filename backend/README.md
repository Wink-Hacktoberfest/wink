# Wink backend (`wink-api`)

Cloudflare Worker for Wink: stores memories (R2 images + Snowflake rows with Arctic Embed vectors), describes images with an open vision model, answers with `gpt-oss-120b` on DigitalOcean, finds nearby places in Overture Maps Places, and drives the TV dashboard over a Durable Object WebSocket room. The API contract is [`../docs/api.md`](../docs/api.md).

```
src/index.ts        router, bearer auth, CORS, JSON errors      src/live.ts       LiveRoom DO (WebSocket Hibernation) + MOCK store
src/routes/*.ts     memories, glance, ask, nearby, images/events src/inference.ts  DigitalOcean chat/vision, Workers AI fallback
src/snowflake.ts    SQL API v2 client + all queries              src/speech.ts     speech sanitizer (≤ 25 words, no markdown/emoji/URLs)
src/mock.ts         canned memories, places, placeholder art     src/prompts.ts    model prompts
public/tv/          the big-screen dashboard (/tv)
```

## Run locally

```bash
npm ci
npm run check                    # typecheck + tests
npm run dev -- --ip 0.0.0.0      # http://localhost:8787, phone on the same Wi-Fi: http://<mac-lan-ip>:8787
```
Find the Mac's LAN IP with `ipconfig getifaddr en0`. TV: open `http://localhost:8787/tv?token=<WINK_TOKEN>` (press `f` for fullscreen).

`MOCK=true` (the default) needs no keys: every route returns canned data, saved/deleted memories persist in the Durable Object, uploads go to the local R2 simulator, and all live events still reach the TV. With `WINK_TOKEN` unset in MOCK mode, auth is skipped. Wrangler warns that the `AI` binding is remote; MOCK mode never calls it.

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
Choose an open vision-capable model from the list (Llama 3.2 Vision / Llama 4 / Qwen-VL style ids) and set `VISION_MODEL` in `wrangler.jsonc`. Confirm `openai-gpt-oss-120b` is listed for `CHAT_MODEL`. While `VISION_MODEL` is empty (or `VISION_PROVIDER="workers-ai"`), vision uses Workers AI `@cf/meta/llama-3.2-11b-vision-instruct`; the Worker sends Meta's one-time `agree` prompt automatically.

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
4. `"MOCK": "false"` in `wrangler.jsonc` (or `MOCK=false` in `.dev.vars` to override locally), then restart `npm run dev` / redeploy.
5. Optional: `DEMO_LAT` / `DEMO_LNG` as the fallback location when the phone sends none.

`GET /v1/health` shows `mock` and the active models. Provider errors are logged with `console.error` (`npx wrangler tail` when deployed).

## Notes

- `/v1/live?token=…&role=tv|glasses`: glasses messages are relayed to TV sockets only; route events go to everyone. Send the text `ping` to get `pong` without waking the DO.
- Snowflake bindings are all `TEXT`; vectors are computed inline with `SNOWFLAKE.CORTEX.EMBED_TEXT_1024` (see `../snowflake/03_app_queries.sql`).
- `/v1/ask` drops matches below cosine 0.30 (tune `ASK_MIN_SCORE` in `src/snowflake.ts` after a few real memories).
- Debug the TV from the browser console: `wink.handle({ type: 'pointer', x: 0.5, y: 0.5, pinching: true })`.
