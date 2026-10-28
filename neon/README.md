# Wink on Neon

Neon (serverless Postgres + pgvector) holds Wink's memories: one row per saved moment, with a 1024-d vector for "what was that book?". Images stay in R2; the row only keeps the R2 key. Embeddings come from Workers AI (`@cf/baai/bge-m3`) inside the Worker, so Neon only stores and searches them.

Snowflake still serves Overture Maps Places for `/v1/nearby` and business matching, so `SNOWFLAKE_PAT` is still needed for those two until places move too.

| File | What it is |
|---|---|
| `schema.sql` | `vector` extension, `memories` table, indexes, grants for the `wink_app` role |
| `../backend/src/neon.ts` | Every query the Worker runs |
| `../backend/tools/copy-snowflake-memories.ts` | One-time copy of existing memories from Snowflake |

## Setup (account owner, about 15 minutes)

Never paste the connection string into chat, a commit or a screenshot. It contains the password.

1. **Create the project.** [console.neon.tech](https://console.neon.tech) → New project → name `wink`, the latest Postgres, a region near your users (AWS US East is closest to the Cloudflare edge for Oklahoma). The free plan is enough: 0.5 GB holds tens of thousands of memories.
2. **Create the app role.** Sidebar → Postgres database › Roles → create `wink_app`. Copy the password (shown once).
3. **Create the schema.** SQL Editor, database `neondb`, run [`schema.sql`](schema.sql) top to bottom. It is safe to re-run.
4. **Get the connection string.** Dashboard → Connect → role `wink_app`, database `neondb`. Copy the `postgresql://…` string.
5. **Give it to the Worker.**
   - Local: add `DATABASE_URL=postgresql://…` to `backend/.dev.vars` (git-ignored).
   - Deployed: `cd backend && npx wrangler secret put DATABASE_URL` and paste at the prompt. The currently deployed code ignores it, so this is safe before the deploy in step 7.
6. **Copy the existing memories** before the Snowflake PAT expires (see `../docs/runbooks/snowflake-pat-rotation.md`):
   ```bash
   cd backend
   SNOWFLAKE_ACCOUNT_URL=https://lfuzpkj-cj15352.snowflakecomputing.com npm run copy:snowflake -- --dry-run
   SNOWFLAKE_ACCOUNT_URL=https://lfuzpkj-cj15352.snowflakecomputing.com npm run copy:snowflake
   ```
   The script prints counts only and skips ids that are already in Neon, so it is safe to re-run. Copied rows have no vector yet (Snowflake's Arctic vectors don't match BGE-M3); the Worker embeds up to 20 of them in the background on each `GET /v1/memories`.
7. **Check locally, then deploy.**
   ```bash
   npm run dev:real            # uses Workers AI + Neon + Snowflake places with your .dev.vars
   curl -s localhost:8787/v1/memories -H "Authorization: Bearer $WINK_TOKEN" | head -c 300
   npm run deploy
   ```
   Then in the app: save something, ask about it, ask about an older (copied) memory, delete the new one. `GET /v1/health` should report `"embed": "@cf/baai/bge-m3"`.

## Rollback

`npx wrangler rollback` returns the Worker to the Snowflake version. Snowflake's `MEMORIES` table is untouched by the copy, but anything saved after the switch exists only in Neon.

## Notes

- **Cold starts.** The free plan suspends the database after 5 idle minutes. The first query after that takes about half a second longer.
- **Failures.** A save whose embedding call fails is still stored, without a vector, and is backfilled later. A Postgres error means nothing was written, so the Worker deletes the uploaded image. A timeout or dropped connection may follow a committed insert, so the image is kept.
- **Changing the embedding model.** Set `EMBED_MODEL` to another 1024-dimension Workers AI model. Each row records the model that embedded it; search only compares rows from the current model, and the backfill re-embeds the rest.
- **Tuning.** `/v1/ask` drops matches below cosine 0.40, or more than 0.08 below the best match (`ASK_MIN_SCORE`, `ASK_RELATIVE_GAP` in `backend/src/neon.ts`). Those came from a small test set; tune them on real memories.
- **Looking at the data.** Any Postgres client works with the owner role's connection string, e.g. `SELECT id, created_at, title, embed_model FROM memories ORDER BY created_at DESC LIMIT 20;`.
