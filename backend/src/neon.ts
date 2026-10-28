import { neon, NeonDbError } from '@neondatabase/serverless';
import { HttpError } from './http.ts';
import { embed, embedMany, embedModel } from './inference.ts';
import { parseSelection, validCoordinates } from './parse.ts';
import type { Env, Place, StoredMemory } from './types.ts';

// /v1/ask match rules, BGE-M3 cosine similarity measured on the real memories (2026-10-28, numbers in neon/README.md).
// Unrelated questions ("where did I park my car?") score 0.40–0.44 against everything alike, while a real match on a
// short question can score as low as 0.41, so the best match's lead over the runner-up decides the middle band.
/** A best match at or above this always counts. */
export const ASK_STRONG_SCORE = 0.5;
/** Nothing below this counts. */
export const ASK_MIN_SCORE = 0.35;
/** Between the two, the best match must lead the runner-up (or ASK_MIN_SCORE when it is alone) by this much. */
export const ASK_MIN_LEAD = 0.05;
/** Once the best match counts, also keep others this close to it. */
export const ASK_RELATIVE_GAP = 0.08;

export type Row = Record<string, string | null>;

/** Postgres answered with an error, so the statement rolled back and an INSERT could not have committed. */
export class StoreRejectedError extends HttpError {}

// Keep every value as Postgres text output so rows parse the same way whatever the column type.
const RAW_TEXT = { getTypeParser: () => (value: string) => value };

function connectionString(env: Env): string {
  const value = env.DATABASE_URL?.trim();
  let url: URL | null = null;
  try { url = value ? new URL(value) : null; } catch { /* reported below */ }
  if (!url) throw new HttpError(503, 'not_configured', 'The memory database is not configured (DATABASE_URL).');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) {
    throw new HttpError(503, 'not_configured', 'DATABASE_URL must be a postgresql:// connection string with credentials.');
  }
  return value!;
}

function failure(error: unknown, timedOut: boolean): never {
  if (timedOut) throw new HttpError(504, 'database_timeout', 'The memory database took too long.');
  const code = error instanceof NeonDbError ? error.code : undefined;
  const status = /HTTP status (\d{3})/.exec(error instanceof Error ? error.message : '')?.[1];
  // Postgres messages can quote SQL and memory contents. Log only diagnostic identifiers.
  console.error(`Neon query failed; code ${code?.slice(0, 5) ?? '-'}; HTTP ${status ?? '-'}`);
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    if (code.startsWith('28')) throw new StoreRejectedError(502, 'database_auth', 'The memory database rejected the credentials.');
    if (code === '53300' || code === '57P03') throw new StoreRejectedError(503, 'database_busy', 'The memory database is busy. Try again shortly.');
    throw new StoreRejectedError(502, 'database_error', 'The memory database query failed.');
  }
  if (status === '401' || status === '403') {
    throw new StoreRejectedError(502, 'database_auth', 'The memory database rejected the credentials.');
  }
  throw new HttpError(502, 'database_unavailable', 'The memory database is temporarily unavailable.');
}

/** One parameterized statement over Neon's HTTP endpoint. Never retried: a lost reply may follow a commit. */
export async function query(env: Env, text: string, params: unknown[] = [], timeoutMs = 10_000): Promise<Row[]> {
  const sql = neon(connectionString(env), { disableWarningInBrowsers: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `types` must be per query: the driver ignores the neon() option for single queries.
    const rows: unknown = await sql.query(text, params, {
      types: RAW_TEXT, fetchOptions: { signal: controller.signal, redirect: 'manual' },
    });
    if (!Array.isArray(rows)) throw new HttpError(502, 'database_response', 'The memory database returned an invalid result.');
    return rows as Row[];
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return failure(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

const MEMORY_COLUMNS = `id,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  kind, title, summary, visible_text, objects, note, image_key, selection, lat, lng, place, product_query`;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

/** Shared by Neon rows and the Snowflake copy script: both read every column as text. */
export function rowToMemory(row: Row): StoredMemory {
  const lat = row.lat == null ? NaN : Number(row.lat);
  const lng = row.lng == null ? NaN : Number(row.lng);
  const objects = parseJson<unknown>(row.objects, []);
  const selection = parseSelection(parseJson<unknown>(row.selection, null));
  const timestamp = row.created_at ? new Date(row.created_at) : null;
  if (!timestamp || !Number.isFinite(timestamp.getTime())) {
    throw new HttpError(502, 'database_response', 'The memory database returned an invalid result.');
  }
  return {
    id: row.id ?? '',
    createdAt: timestamp.toISOString(),
    kind: row.kind === 'passive' ? 'passive' : 'explicit',
    title: row.title ?? '',
    summary: row.summary ?? '',
    visibleText: row.visible_text ?? '',
    objects: Array.isArray(objects) ? objects.filter((value): value is string => typeof value === 'string') : [],
    note: row.note || null,
    imageKey: row.image_key ?? '',
    selection,
    location: validCoordinates(lat, lng) ? { lat, lng } : null,
    place: parseJson<Place | null>(row.place, null),
    productQuery: row.product_query || null,
  };
}

export function embeddingText(m: Pick<StoredMemory, 'title' | 'summary' | 'visibleText' | 'objects' | 'note'>): string {
  return [m.title, m.summary, m.visibleText, m.objects.join(', '), m.note ?? ''].filter(Boolean).join('. ').slice(0, 4000);
}

/** pgvector's text input format. */
const vectorLiteral = (vector: number[]) => `[${vector.join(',')}]`;

export const INSERT_MEMORY_SQL = `INSERT INTO memories
  (id, created_at, kind, title, summary, visible_text, objects, note, image_key, selection, lat, lng, place, product_query,
   embedding, embed_model)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11::float8, $12::float8, $13::jsonb, $14,
  $15::vector, $16)
ON CONFLICT (id) DO NOTHING`;

/**
 * Saves with its embedding when the model answers; otherwise saves without one so the capture is never lost,
 * and backfillEmbeddings fills it in later. Returns whether the row has an embedding.
 */
export async function insertMemory(env: Env, m: StoredMemory, options: { embed?: boolean } = {}): Promise<boolean> {
  const model = embedModel(env);
  const vector = options.embed === false ? null : await embed(env, embeddingText(m)).catch((error) => {
    console.error(`embedding skipped, will backfill: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  await query(env, INSERT_MEMORY_SQL, [
    m.id, m.createdAt, m.kind, m.title, m.summary, m.visibleText, JSON.stringify(m.objects), m.note,
    m.imageKey, JSON.stringify(m.selection), m.location?.lat ?? null, m.location?.lng ?? null,
    m.place ? JSON.stringify(m.place) : null, m.productQuery ?? null,
    vector ? vectorLiteral(vector) : null, vector ? model : null,
  ]);
  return vector !== null;
}

export async function listMemories(env: Env, limit: number): Promise<StoredMemory[]> {
  const n = Math.min(200, Math.max(1, Math.floor(limit) || 50));
  const rows = await query(env, `SELECT ${MEMORY_COLUMNS} FROM memories ORDER BY created_at DESC LIMIT $1::int`, [n]);
  return rows.map(rowToMemory);
}

export async function getMemory(env: Env, id: string): Promise<StoredMemory | null> {
  const rows = await query(env, `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = $1`, [id]);
  return rows[0] ? rowToMemory(rows[0]) : null;
}

export async function deleteMemory(env: Env, id: string): Promise<string | null> {
  const rows = await query(env, 'DELETE FROM memories WHERE id = $1 RETURNING image_key', [id]);
  return rows[0]?.image_key ?? null;
}

// Only vectors from the current model are comparable with the question's vector.
export const SEARCH_MEMORIES_SQL = `SELECT ${MEMORY_COLUMNS}, 1 - (embedding <=> $1::vector) AS score
FROM memories
WHERE embedding IS NOT NULL AND embed_model = $2
ORDER BY embedding <=> $1::vector
LIMIT 3`;

/** Top-3 vector search, weak matches dropped. Best match first. */
export async function searchMemories(env: Env, question: string): Promise<Array<StoredMemory & { score: number }>> {
  const vector = await embed(env, question.slice(0, 2000));
  const rows = await query(env, SEARCH_MEMORIES_SQL, [vectorLiteral(vector), embedModel(env)]);
  return pickMatches(rows.map((row) => ({ ...rowToMemory(row), score: Number(row.score ?? 0) })));
}

/** Applies the ASK_* rules to search results sorted best first. */
export function pickMatches<T extends { score: number }>(scored: T[]): T[] {
  const best = scored[0]?.score ?? 0;
  const lead = best - Math.max(scored[1]?.score ?? 0, ASK_MIN_SCORE);
  if (best < ASK_MIN_SCORE || (best < ASK_STRONG_SCORE && lead < ASK_MIN_LEAD)) return [];
  return scored.filter((m) => m.score >= ASK_MIN_SCORE && m.score >= best - ASK_RELATIVE_GAP);
}

/** Embeds rows saved while the model was down, copied from Snowflake, or embedded with an older model. */
export async function backfillEmbeddings(env: Env, limit = 20): Promise<number> {
  const model = embedModel(env);
  const rows = await query(env, `SELECT id, title, summary, visible_text, objects, note FROM memories
WHERE embedding IS NULL OR embed_model IS DISTINCT FROM $1
ORDER BY created_at DESC
LIMIT $2::int`, [model, limit]);
  if (!rows.length) return 0;
  const vectors = await embedMany(env, rows.map((row) => {
    const objects = parseJson<unknown>(row.objects, []);
    return embeddingText({
      title: row.title ?? '', summary: row.summary ?? '', visibleText: row.visible_text ?? '', note: row.note ?? null,
      objects: Array.isArray(objects) ? objects.filter((value): value is string => typeof value === 'string') : [],
    });
  }));
  for (const [i, row] of rows.entries()) {
    await query(env, 'UPDATE memories SET embedding = $1::vector, embed_model = $2 WHERE id = $3',
      [vectorLiteral(vectors[i]!), model, row.id]);
  }
  return rows.length;
}
