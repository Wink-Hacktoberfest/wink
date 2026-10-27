-- Wink: one-time Snowflake setup. Run as ACCOUNTADMIN (or a role that can create these objects).
-- Creates the warehouse, database, schema, MEMORIES table, and a service user + role for the Worker.

USE ROLE ACCOUNTADMIN;

-- 1. Compute: tiny and quick to sleep.
CREATE WAREHOUSE IF NOT EXISTS WINK_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

-- 2. Storage.
CREATE DATABASE IF NOT EXISTS WINK;
CREATE SCHEMA IF NOT EXISTS WINK.APP;
USE SCHEMA WINK.APP;

-- 3. Memories. One row per "Hey Wink, save this".
--    embedding = SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', title + summary + visible text + objects + note)
CREATE TABLE IF NOT EXISTS MEMORIES (
  id            STRING        NOT NULL PRIMARY KEY,  -- uuid from the Worker
  created_at    TIMESTAMP_TZ  NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  kind          STRING        NOT NULL DEFAULT 'explicit',  -- 'explicit' | 'passive'
  title         STRING,
  summary       STRING,
  visible_text  STRING,         -- OCR from the vision model
  objects       VARIANT,        -- JSON array of strings
  note          STRING,         -- what the wearer said after "save this"
  image_key     STRING,         -- R2 object key in the wink-images bucket
  selection     VARIANT,        -- {"mode": "point", "box": {"x":..,"y":..,"w":..,"h":..}}
  lat           FLOAT,
  lng           FLOAT,
  place         VARIANT,        -- matched Overture place (Place JSON) or NULL
  product_query STRING,         -- vision model's shopping phrase, used by /v1/nearby
  embedding     VECTOR(FLOAT, 1024)
);

-- Sanity check that Cortex embeddings work in this region/account (should return 1024).
SELECT VECTOR_L2_DISTANCE(
  SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', 'hello'),
  SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', 'hello')) AS should_be_zero;
-- If Cortex isn't available in your region: ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';

-- 4. A role + service user for the Worker.
CREATE ROLE IF NOT EXISTS WINK_APP;
GRANT USAGE ON WAREHOUSE WINK_WH TO ROLE WINK_APP;
GRANT USAGE ON DATABASE WINK TO ROLE WINK_APP;
GRANT USAGE ON SCHEMA WINK.APP TO ROLE WINK_APP;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE WINK.APP.MEMORIES TO ROLE WINK_APP;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE WINK_APP;
-- Overture Places (after you "Get" the CARTO listing; the database name is whatever you chose, default below):
GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES TO ROLE WINK_APP;

CREATE USER IF NOT EXISTS WINK_SVC
  TYPE = SERVICE
  DEFAULT_ROLE = WINK_APP
  DEFAULT_WAREHOUSE = WINK_WH
  DEFAULT_NAMESPACE = WINK.APP
  COMMENT = 'Wink Cloudflare Worker (SQL API v2 with a programmatic access token)';
GRANT ROLE WINK_APP TO USER WINK_SVC;

-- 5. Programmatic access token (PAT) for the Worker.
--    PATs require the user to be subject to a network policy (unless an authentication policy relaxes it).
--    Cloudflare Worker egress IPs vary, so for the hackathon allow all IPv4 on this service user only.
--    (Tighten or drop this after the demo.)
CREATE NETWORK RULE IF NOT EXISTS WINK.APP.WINK_ALLOW_ALL
  MODE = INGRESS TYPE = IPV4 VALUE_LIST = ('0.0.0.0/0');
CREATE NETWORK POLICY IF NOT EXISTS WINK_HACKATHON_POLICY
  ALLOWED_NETWORK_RULE_LIST = ('WINK.APP.WINK_ALLOW_ALL')
  COMMENT = 'Hackathon only: Cloudflare egress IPs are not fixed';
ALTER USER WINK_SVC SET NETWORK_POLICY = WINK_HACKATHON_POLICY;

-- Alternative to the network policy: an authentication policy that does not require one for PATs.
-- CREATE AUTHENTICATION POLICY WINK.APP.WINK_PAT_POLICY
--   PAT_POLICY = (NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED);
-- ALTER USER WINK_SVC SET AUTHENTICATION POLICY WINK.APP.WINK_PAT_POLICY;

-- Create the token. The secret is shown ONCE in the result: copy it into backend/.dev.vars as SNOWFLAKE_PAT
-- and `npx wrangler secret put SNOWFLAKE_PAT`. Never commit it.
ALTER USER WINK_SVC ADD PROGRAMMATIC ACCESS TOKEN WINK_WORKER
  ROLE_RESTRICTION = 'WINK_APP'
  DAYS_TO_EXPIRY = 7
  COMMENT = 'Wink Worker';

-- Your SNOWFLAKE_ACCOUNT_URL is https://<orgname>-<account_name>.snowflakecomputing.com
SELECT CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME() AS account_identifier;
