-- Wink: the exact SQL the Worker runs (backend/src/snowflake.ts), with `?` placeholders.
-- Every binding is sent as TEXT through the SQL API v2. VECTORs can't be bound, so embeddings are
-- computed inline with Cortex; arrays/objects arrive as JSON strings and go through PARSE_JSON,
-- which is why the insert is INSERT ... SELECT rather than VALUES. '' means NULL (NULLIF).
-- Session context per request: database WINK, schema APP, warehouse WINK_WH.

-- Insert a memory (POST /v1/memories).
-- binds: id, createdAt ISO, kind, title, summary, visibleText, objects JSON, note|'' , imageKey,
--        selection JSON, lat|'', lng|'', place JSON|'', productQuery|'', embed model, embed text
INSERT INTO MEMORIES
  (id, created_at, kind, title, summary, visible_text, objects, note, image_key, selection, lat, lng, place, product_query, embedding)
SELECT ?, TO_TIMESTAMP_TZ(?), ?, ?, ?, ?, PARSE_JSON(?), NULLIF(?, ''), ?, PARSE_JSON(?),
  TRY_TO_DOUBLE(NULLIF(?, '')), TRY_TO_DOUBLE(NULLIF(?, '')), PARSE_JSON(NULLIF(?, '')), NULLIF(?, ''),
  SNOWFLAKE.CORTEX.EMBED_TEXT_1024(?, ?);

-- List newest first (GET /v1/memories). The limit is a validated integer interpolated by the Worker.
SELECT id,
  TO_VARCHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS created_at,
  kind, title, summary, visible_text, TO_JSON(objects) AS objects, note, image_key,
  TO_JSON(selection) AS selection, lat, lng, TO_JSON(place) AS place, product_query
FROM MEMORIES ORDER BY created_at DESC LIMIT 50;

-- One memory (POST /v1/nearby with memoryId). binds: id
SELECT id, title, objects, product_query FROM MEMORIES WHERE id = ?;

-- Vector search, top 3 (POST /v1/ask). binds: embed model, question
-- The Worker drops matches below 0.30 cosine, or more than 0.12 below the best match.
SELECT id,
  TO_VARCHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS created_at,
  kind, title, summary, visible_text, TO_JSON(objects) AS objects, note, image_key,
  TO_JSON(selection) AS selection, lat, lng, TO_JSON(place) AS place, product_query,
  VECTOR_COSINE_SIMILARITY(embedding, SNOWFLAKE.CORTEX.EMBED_TEXT_1024(?, ?)) AS score
FROM MEMORIES
WHERE embedding IS NOT NULL
ORDER BY score DESC
LIMIT 3;

-- Delete (DELETE /v1/memories/:id). binds: id (twice, two statements)
SELECT image_key FROM MEMORIES WHERE id = ?;
DELETE FROM MEMORIES WHERE id = ?;

-- Nearby places within 3 km (POST /v1/nearby). Table name comes from OVERTURE_PLACES_TABLE.
-- binds: lng, lat, lng, lat, radius meters, categories JSON array (e.g. '["book_store","used_bookstore"]'),
--        name regex (e.g. '.*(books|book).*'; REGEXP_LIKE matches the whole string)
SELECT ID AS id,
  NAMES:primary::STRING AS name,
  CATEGORIES:primary::STRING AS category,
  PHONES:list[0]:element::STRING AS phone,
  ADDRESSES:list[0]:element:freeform::STRING AS street,
  ADDRESSES:list[0]:element:locality::STRING AS locality,
  ADDRESSES:list[0]:element:region::STRING AS region,
  ST_Y(GEOMETRY) AS lat,
  ST_X(GEOMETRY) AS lng,
  ST_DISTANCE(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT)) AS meters
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT), ?::FLOAT)
  AND (ARRAY_CONTAINS(CATEGORIES:primary, PARSE_JSON(?)::ARRAY)
       OR REGEXP_LIKE(NAMES:primary::STRING, ?, 'i'))
ORDER BY meters
LIMIT 5;

-- Business match for a saved storefront (POST /v1/memories when the vision model reads a business name).
-- binds: lng, lat, name, lng, lat, radius meters (250), name
SELECT ID AS id,
  NAMES:primary::STRING AS name,
  CATEGORIES:primary::STRING AS category,
  PHONES:list[0]:element::STRING AS phone,
  ADDRESSES:list[0]:element:freeform::STRING AS street,
  ADDRESSES:list[0]:element:locality::STRING AS locality,
  ADDRESSES:list[0]:element:region::STRING AS region,
  ST_Y(GEOMETRY) AS lat,
  ST_X(GEOMETRY) AS lng,
  ST_DISTANCE(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT)) AS meters,
  JAROWINKLER_SIMILARITY(LOWER(NAMES:primary::STRING), LOWER(?)) AS similarity
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT), ?::FLOAT)
  AND JAROWINKLER_SIMILARITY(LOWER(NAMES:primary::STRING), LOWER(?)) >= 85
ORDER BY similarity DESC, meters
LIMIT 1;
