-- Wink: exploring "Overture Maps - Places" (CARTO, Snowflake Marketplace, free).
--
-- These are the queries to run and refine with Snowflake CoCo (Cortex Code in Snowsight).
-- Ask CoCo to explain each result and fix anything that errors; the column shapes below follow
-- Overture's Snowflake docs sample and MUST be verified against the real table.
-- Save CoCo screenshots to docs/coco/ (see snowflake/README.md "CoCo checklist").
--
-- Default database name from the listing: OVERTURE_MAPS__PLACES, schema CARTO, table PLACE.
-- If you renamed it when you clicked "Get", change it here and in backend OVERTURE_PLACES_TABLE.

USE WAREHOUSE WINK_WH;

-- 1. What's in the share?
SHOW SCHEMAS IN DATABASE OVERTURE_MAPS__PLACES;
SHOW TABLES IN SCHEMA OVERTURE_MAPS__PLACES.CARTO;
DESCRIBE TABLE OVERTURE_MAPS__PLACES.CARTO.PLACE;

-- 2. Size.
SELECT COUNT(*) AS places FROM OVERTURE_MAPS__PLACES.CARTO.PLACE;

-- 3. Sample rows: look at the nested VARIANT columns.
SELECT * FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 10;

-- 4. The Overture docs sample (phones/names use Parquet-style list wrappers).
SELECT id, phones['list'][0]['element'] AS phone, names['primary'] AS name
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE categories['primary'] = 'restaurant'
LIMIT 10;

-- 5. Nested shapes Wink depends on (NAMES, CATEGORIES, PHONES, ADDRESSES, GEOMETRY).
SELECT
  ID,
  NAMES:primary::STRING                       AS name,
  CATEGORIES:primary::STRING                  AS category,
  CATEGORIES:alternate                        AS alternate_categories,
  PHONES:list[0]:element::STRING              AS phone,
  ADDRESSES                                   AS raw_addresses,
  ADDRESSES:list[0]:element:freeform::STRING  AS street,
  ADDRESSES:list[0]:element:locality::STRING  AS city,
  ADDRESSES:list[0]:element:region::STRING    AS region,
  TYPEOF(GEOMETRY)                            AS geometry_type,   -- expect GEOGRAPHY
  ST_Y(GEOMETRY) AS lat, ST_X(GEOMETRY) AS lng
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ADDRESSES IS NOT NULL
LIMIT 20;

-- 6. Category distribution (which ids to map "books", "wine", "coffee" to).
SELECT CATEGORIES:primary::STRING AS category, COUNT(*) AS n
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
GROUP BY 1
ORDER BY n DESC
LIMIT 100;

-- 7. Categories that look like shops Wink cares about.
SELECT CATEGORIES:primary::STRING AS category, COUNT(*) AS n
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE CATEGORIES:primary::STRING ILIKE ANY ('%book%', '%wine%', '%liquor%', '%coffee%', '%shoe%', '%florist%', '%hardware%', '%pharmacy%')
GROUP BY 1
ORDER BY n DESC;

-- 8. Places near the demo table (Norman, OK; replace with your lat/lng). ST_MAKEPOINT takes (lng, lat).
SELECT
  NAMES:primary::STRING      AS name,
  CATEGORIES:primary::STRING AS category,
  ROUND(ST_DISTANCE(GEOMETRY, ST_MAKEPOINT(-97.4457, 35.2059))) AS meters
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(-97.4457, 35.2059), 3000)
ORDER BY meters
LIMIT 25;

-- 9. Book stores within 3 km (the shape of the app's nearby query).
SELECT
  NAMES:primary::STRING      AS name,
  CATEGORIES:primary::STRING AS category,
  PHONES:list[0]:element::STRING AS phone,
  ROUND(ST_DISTANCE(GEOMETRY, ST_MAKEPOINT(-97.4457, 35.2059))) AS meters
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(-97.4457, 35.2059), 3000)
  AND (CATEGORIES:primary::STRING IN ('book_store', 'used_bookstore')
       OR REGEXP_LIKE(NAMES:primary::STRING, '.*(books).*', 'i'))
ORDER BY meters
LIMIT 5;

-- 10. Speed check: is there a bbox column we can prefilter on? (Overture has bbox xmin/xmax/ymin/ymax.)
--     If the nearby query is slow on XSMALL, ask CoCo to add a bbox prefilter like:
--     AND BBOX:xmin::FLOAT BETWEEN lng - 0.04 AND lng + 0.04 AND BBOX:ymin::FLOAT BETWEEN lat - 0.03 AND lat + 0.03
SELECT BBOX FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 5;
