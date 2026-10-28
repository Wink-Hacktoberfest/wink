-- Wink memory store on Neon (Postgres + pgvector).
-- Run once in the Neon SQL Editor as the project owner, after creating the role wink_app (see README.md).
-- Safe to re-run.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memories (
  id            text PRIMARY KEY,
  created_at    timestamptz NOT NULL,
  kind          text NOT NULL DEFAULT 'explicit' CHECK (kind IN ('explicit', 'passive')),
  title         text NOT NULL,
  summary       text NOT NULL DEFAULT '',
  visible_text  text NOT NULL DEFAULT '',
  objects       jsonb NOT NULL DEFAULT '[]',
  note          text,
  image_key     text NOT NULL,                 -- R2 object key; images never live in Postgres
  selection     jsonb NOT NULL DEFAULT '{"mode": "full", "box": null}',
  lat           double precision,
  lng           double precision,
  place         jsonb,                         -- Overture business match, if any
  product_query text,                          -- what /v1/nearby searches for
  embedding     vector(1024),                  -- Workers AI @cf/baai/bge-m3; NULL until embedded
  embed_model   text                           -- model that produced embedding; search compares only matching rows
);

CREATE INDEX IF NOT EXISTS memories_created_at_idx ON memories (created_at DESC);
CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memories_unembedded_idx ON memories (created_at DESC) WHERE embedding IS NULL;

-- The Worker connects as wink_app, which can read and write rows but not change the schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO wink_app;
