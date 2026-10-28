// One-time copy of memories from Snowflake (WINK.APP.MEMORIES) into Neon. Safe to re-run: existing ids are skipped.
// Vectors are not copied (Arctic Embed and BGE-M3 vectors are not comparable). The Worker embeds copied rows
// in the background on later GET /v1/memories calls, 20 at a time.
//
//   SNOWFLAKE_ACCOUNT_URL=https://<account>.snowflakecomputing.com npm run copy:snowflake [-- --dry-run]
//
// Reads SNOWFLAKE_PAT and DATABASE_URL from backend/.dev.vars (or the environment). Prints counts only.
import { insertMemory, rowToMemory } from '../src/neon.ts';
import { sql } from '../src/snowflake.ts';
import type { Env } from '../src/types.ts';

const env = process.env as unknown as Env;
const rows = await sql(env, `SELECT id,
  TO_VARCHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS created_at,
  kind, title, summary, visible_text, TO_JSON(objects) AS objects, note, image_key,
  TO_JSON(selection) AS selection, lat, lng, TO_JSON(place) AS place, product_query
FROM MEMORIES
ORDER BY created_at`, [], 60);
const memories = rows.map(rowToMemory);
if (process.argv.includes('--dry-run')) {
  console.log(`Dry run: ${memories.length} memories in Snowflake would be copied. Nothing was written.`);
  process.exit(0);
}
for (const memory of memories) await insertMemory(env, memory, { embed: false });
console.log(`Copied ${memories.length} memories from Snowflake to Neon (ids already in Neon were left unchanged).`);
