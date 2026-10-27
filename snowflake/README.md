# Wink on Snowflake

**Verification status:** local transport and SQL-generation tests pass; no live Snowflake account was accessed. Overture schema, Cortex availability, PAT permissions, real timings and CoCo screenshots still require Arboy’s account session. Screenshots must come from the actual session; none are generated or claimed here.

Snowflake holds Wink's memories (with Arctic Embed vectors for "what was that book?") and answers "where can I get this nearby?" from the free **Overture Maps Places** dataset by CARTO.

| File | What it is |
|---|---|
| `01_setup.sql` | Warehouse `WINK_WH`, database `WINK`, schema `APP`, table `MEMORIES`, role `WINK_APP`, service user `WINK_SVC`, network policy, PAT |
| `02_overture_explore.sql` | Exploratory queries on the Overture Places share, to run and refine with CoCo |
| `03_app_queries.sql` | The SQL the Worker runs (`backend/src/snowflake.ts`), with `?` placeholders |
| `04_verify.sql` | Read-only service-role checks after setup and an app save |

## Account handoff to Arboy

These are instructions for the account owner. Messi’s implementation uses local MOCK mode and mocked provider transports; it does not provision, authenticate to, or deploy account resources.

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
5. **Verify the Overture column shapes** with `02_overture_explore.sql` + CoCo. The Worker uses `DESCRIBE TABLE` to select `TAXONOMY:primary` (current releases) or `CATEGORIES:primary` (legacy releases), caches the result for five minutes, and accepts both Parquet-wrapped and native-array phones/addresses. The exploration SQL shows `TAXONOMY`; substitute `CATEGORIES` if the describe output shows the old release. `GEOMETRY` must be Snowflake **GEOGRAPHY** so the radius and distance are meters. Inspect `SYSTEM$TYPEOF(GEOMETRY)` before using nearby. If the listing uses GEOMETRY/WKB/WKT, create a normalized view with a GEOGRAPHY column named `GEOMETRY` and point `OVERTURE_PLACES_TABLE` to the view. For GEOMETRY input, confirm SRID 4326 before `TO_GEOGRAPHY`. Grant the service role access to the view. For any other shape changes, update `03_app_queries.sql` **and** `placeColumns` / `nearbySql` in `backend/src/snowflake.ts`.
6. **Run `04_verify.sql` as `WINK_APP`**, not only as ACCOUNTADMIN: a successful admin query does not prove the Worker can use Cortex or read the share. In the app, save a book, ask about it, query nearby, and delete it. Confirm the saved row is immediately searchable, distances are plausible, and deletion removes the row and image. Record the request/status plus query ID and elapsed time; omit keys and personal memory content from screenshots.
7. Set `MOCK` to `"false"` in `backend/wrangler.jsonc` once DigitalOcean and Snowflake both work.

## CoCo checklist (screenshots for the judges → `docs/coco/`)

The "Best Open-Source AI with Snowflake" track wants to see **how CoCo helped**. Open CoCo (Cortex Code) in Snowsight with the Overture share selected and capture each of these. Name files `docs/coco/01-schema.png`, `02-categories.png`, and so on.

1. **Explore the schema.** Ask: *"Explain the columns of OVERTURE_MAPS__PLACES.CARTO.PLACE. How are names, categories, phones and addresses nested? Show me 5 sample rows with those fields flattened."* Screenshot the explanation and the flattened result.
2. **Category vocabulary.** Ask: *"What are the most common primary categories? Which category ids should I use for book stores, wine shops, coffee shops and shoe stores?"* Screenshot it; update the category rules in `backend/src/routes/nearby.ts` and the prompt in `backend/src/prompts.ts` if CoCo finds better ids.
3. **Write the nearby query.** Ask: *"Write a query that returns the 5 closest book stores within 3 km of lat 35.2059, lng -97.4457 with name, category, phone, address and distance in meters. Make it fast on an XSMALL warehouse."* Screenshot the query, the result, and the query profile/timing. Paste any improvement (e.g. a bbox prefilter) into `03_app_queries.sql` and `backend/src/snowflake.ts`.
4. **Design the memory table + vector search.** Ask: *"Design a table for smart-glasses memories (title, summary, OCR text, objects, note, image key, location) with a 1024-dim vector from snowflake-arctic-embed-l-v2.0, and a query that finds the 3 most similar memories to a question with VECTOR_COSINE_SIMILARITY."* Screenshot it next to `01_setup.sql`.
5. **Business matching.** Ask: *"Given a storefront name read from a photo and a lat/lng, find the matching Overture place within 250 m using fuzzy name matching."* Screenshot it.
6. **Show it live.** After a demo run, ask CoCo: *"Summarize what's in WINK.APP.MEMORIES and which memories are most similar to 'that wine Sam liked'."* Screenshot it.

Say out loud in the demo: dataset **Overture Maps Places by CARTO**, embeddings **Arctic Embed (open)**, and show these screenshots.

## Provider behavior covered locally

`backend/test/snowflake.test.ts` checks SQL bindings (including quotes, nullable fields and JSON), 202 status polling, rate-limited GET recovery, all result partitions, invalid/truncated results, error classification, vector relevance filtering, identifier validation, release-specific taxonomy discovery, geography validation and place conversion. Only an explicit rejection of the initial POST allows R2 upload cleanup; polling errors after 202 leave the image intact. POST writes are never replayed automatically: after a timeout or transport loss the insert may already have committed. Check the memory id in Snowflake before retrying a timed-out save. Provider response messages are not copied into logs because they may contain SQL or memory content.

The SQL API retrieves later partitions with the original column metadata and applies one total deadline. The service role must still pass the actual account checks above. The initial cosine threshold (0.30, within 0.12 of the best score) needs calibration on the staged demo memories; local tests prove filtering behavior only.

## Evidence to return to Messi

- [ ] Account setup and `04_verify.sql` completed as `WINK_APP`; no token in the response or screenshot.
- [ ] Exact Overture table/view, geometry type, taxonomy/category column, sample flattened fields and verified category ids.
- [ ] Save → immediate ask → nearby → delete smoke test results, plus failed-token error behavior.
- [ ] Actual CoCo screenshots `01-schema.png` through `06-live-memories.png` in `docs/coco/`.
- [ ] Query timings and any schema/query fixes from CoCo. Until these exist, M6 live verification and M8 remain pending.

## References used for implementation

- [Snowflake SQL API response handling](https://docs.snowflake.com/en/developer-guide/sql-api/handling-responses): partitions and result metadata.
- [Snowflake SQL API reference](https://docs.snowflake.com/en/developer-guide/sql-api/reference): statement polling, binding types and error statuses.
- [Snowflake programmatic access tokens](https://docs.snowflake.com/en/user-guide/programmatic-access-tokens): PAT authentication and network policies.
- [Overture’s Snowflake guide](https://docs.overturemaps.org/getting-data/data-mirrors/snowflake/): CARTO dataset and nested-field examples.
- [Snowflake TO_GEOGRAPHY](https://docs.snowflake.com/en/sql-reference/functions/to_geography): conversion of SRID 4326 geometry and supported encodings.
