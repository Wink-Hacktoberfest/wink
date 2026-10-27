-- Arboy: run after 01_setup.sql and share setup, using a role authorized to assume WINK_APP.
-- These checks are read-only; run the app to create/delete the staged memory.
USE ROLE WINK_APP;
USE WAREHOUSE WINK_WH;
USE DATABASE WINK;
USE SCHEMA APP;

SELECT CURRENT_ROLE(), CURRENT_WAREHOUSE(), CURRENT_DATABASE(), CURRENT_SCHEMA();

-- Cortex permission + model availability under the same role the Worker uses.
-- Expect approximately 1.0 for identical vectors.
SELECT VECTOR_COSINE_SIMILARITY(
  AI_EMBED('snowflake-arctic-embed-l-v2.0', 'a book about space'),
  AI_EMBED('snowflake-arctic-embed-l-v2.0', 'a book about space')) AS self_similarity;

-- Replace this identifier if the Marketplace share has a different database/table name.
-- Substitute CATEGORIES for TAXONOMY if DESCRIBE shows an older release.
-- Confirm GEOGRAPHY before running meter-based distances in 02_overture_explore.sql.
SELECT ID, SYSTEM$TYPEOF(GEOMETRY) AS geometry_type,
  NAMES:primary::STRING AS name, TAXONOMY:primary::STRING AS category,
  COALESCE(PHONES:list[0]:element::STRING, PHONES[0]::STRING) AS phone
FROM OVERTURE_MAPS_PLACES.CARTO.PLACE LIMIT 5;

-- After saving the staged book in the app, it should appear immediately with an embedding.
SELECT id, created_at, title, embedding IS NOT NULL AS has_embedding
FROM MEMORIES ORDER BY created_at DESC LIMIT 5;

-- Substitute the staged object's question; inspect scores before tuning the cutoff.
SELECT id, title,
  VECTOR_COSINE_SIMILARITY(embedding,
    AI_EMBED('snowflake-arctic-embed-l-v2.0', 'what was that book?')) AS score
FROM MEMORIES WHERE embedding IS NOT NULL
ORDER BY score DESC LIMIT 3;

-- Confirm the requested id is absent after DELETE /v1/memories/:id.
-- SELECT COUNT(*) AS should_be_zero FROM MEMORIES WHERE id = '<deleted memory id>';
