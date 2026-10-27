# Wink on Snowflake

Snowflake holds Wink's memories (with Arctic Embed vectors for "what was that book?") and answers "where can I get this nearby?" from the free **Overture Maps Places** dataset by CARTO.

| File | What it is |
|---|---|
| `01_setup.sql` | Warehouse `WINK_WH`, database `WINK`, schema `APP`, table `MEMORIES`, role `WINK_APP`, service user `WINK_SVC`, network policy, PAT |
| `02_overture_explore.sql` | Exploratory queries on the Overture Places share, to run and refine with CoCo |
| `03_app_queries.sql` | The exact SQL the Worker runs (`backend/src/snowflake.ts`), with `?` placeholders |

## Step by step

1. **Get the dataset.** Snowsight → Data Products → Marketplace → search **"Overture Maps - Places"** (provider CARTO, free) → **Get**. Keep the default database name `OVERTURE_MAPS__PLACES` (if you change it, update `OVERTURE_PLACES_TABLE` in `backend/wrangler.jsonc`). The table is `OVERTURE_MAPS__PLACES.CARTO.PLACE`.
2. **Run `01_setup.sql`** in a Snowsight worksheet as `ACCOUNTADMIN`, top to bottom.
   - The `should_be_zero` check proves Cortex embeddings work. If it errors with a region message, run `ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';`.
   - The `ADD PROGRAMMATIC ACCESS TOKEN` result shows the token **once**. Copy it immediately.
   - PATs only work for users under a network policy (or an authentication policy that relaxes that). Cloudflare's egress IPs aren't fixed, so the script attaches a hackathon policy allowing `0.0.0.0/0` to `WINK_SVC` only. Remove it after the demo.
3. **Fill the backend config.**
   - `backend/.dev.vars` (local) and `npx wrangler secret put SNOWFLAKE_PAT` (deployed): the token.
   - `backend/wrangler.jsonc` vars: `SNOWFLAKE_ACCOUNT_URL` = `https://<org>-<account>.snowflakecomputing.com` (the last query in `01_setup.sql` prints `<org>-<account>`). Optionally `SNOWFLAKE_ROLE` = `WINK_APP` (the user's default role is already `WINK_APP`).
4. **Smoke test the token** from your laptop:
   ```bash
   curl -s "$SNOWFLAKE_ACCOUNT_URL/api/v2/statements" \
     -H "Authorization: Bearer $SNOWFLAKE_PAT" \
     -H "X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN" \
     -H "Content-Type: application/json" -H "Accept: application/json" \
     -d '{"statement":"SELECT COUNT(*) FROM MEMORIES","database":"WINK","schema":"APP","warehouse":"WINK_WH","timeout":30}'
   ```
5. **Verify the Overture column shapes** with `02_overture_explore.sql` + CoCo. The Worker assumes `NAMES:primary`, `CATEGORIES:primary`, `PHONES:list[0]:element`, `ADDRESSES:list[0]:element:{freeform,locality,region}` and a `GEOMETRY` column of type GEOGRAPHY. If any differ, fix the nearby query in `03_app_queries.sql` **and** `PLACE_COLUMNS` / `nearbySql` in `backend/src/snowflake.ts`.
6. Set `MOCK` to `"false"` in `backend/wrangler.jsonc` once DigitalOcean and Snowflake both work.

## CoCo checklist (screenshots for the judges → `docs/coco/`)

The "Best Open-Source AI with Snowflake" track wants to see **how CoCo helped**. Open CoCo (Cortex Code) in Snowsight with the Overture share selected and capture each of these. Name files `docs/coco/01-schema.png`, `02-categories.png`, and so on.

1. **Explore the schema.** Ask: *"Explain the columns of OVERTURE_MAPS__PLACES.CARTO.PLACE. How are names, categories, phones and addresses nested? Show me 5 sample rows with those fields flattened."* Screenshot the explanation and the flattened result.
2. **Category vocabulary.** Ask: *"What are the most common primary categories? Which category ids should I use for book stores, wine shops, coffee shops and shoe stores?"* Screenshot it; update the category rules in `backend/src/routes/nearby.ts` and the prompt in `backend/src/prompts.ts` if CoCo finds better ids.
3. **Write the nearby query.** Ask: *"Write a query that returns the 5 closest book stores within 3 km of lat 35.2059, lng -97.4457 with name, category, phone, address and distance in meters. Make it fast on an XSMALL warehouse."* Screenshot the query, the result, and the query profile/timing. Paste any improvement (e.g. a bbox prefilter) into `03_app_queries.sql` and `backend/src/snowflake.ts`.
4. **Design the memory table + vector search.** Ask: *"Design a table for smart-glasses memories (title, summary, OCR text, objects, note, image key, location) with a 1024-dim vector from snowflake-arctic-embed-l-v2.0, and a query that finds the 3 most similar memories to a question with VECTOR_COSINE_SIMILARITY."* Screenshot it next to `01_setup.sql`.
5. **Business matching.** Ask: *"Given a storefront name read from a photo and a lat/lng, find the matching Overture place within 250 m using fuzzy name matching."* Screenshot it.
6. **Show it live.** After a demo run, ask CoCo: *"Summarize what's in WINK.APP.MEMORIES and which memories are most similar to 'that wine Sam liked'."* Screenshot it.

Say out loud in the demo: dataset **Overture Maps Places by CARTO**, embeddings **Arctic Embed (open)**, and show these screenshots.
