import { HttpError, isRecord, providerFetch } from './http.ts';
import type { Env, Location, Place, Selection, StoredMemory } from './types.ts';

/** Minimum cosine similarity for a memory to count as a match in /v1/ask (Arctic Embed L v2.0). */
export const ASK_MIN_SCORE = 0.3;
/** Also drop matches far below the best one. */
export const ASK_RELATIVE_GAP = 0.12;
export const NEARBY_RADIUS_METERS = 3000;
export const BUSINESS_MATCH_RADIUS_METERS = 250;

type Row = Record<string, string | null>;

function config(env: Env) {
  const accountUrl = env.SNOWFLAKE_ACCOUNT_URL?.trim().replace(/\/+$/, '');
  const pat = env.SNOWFLAKE_PAT?.trim();
  if (!accountUrl || !pat) {
    throw new HttpError(503, 'not_configured', 'Snowflake is not configured (SNOWFLAKE_ACCOUNT_URL, SNOWFLAKE_PAT).');
  }
  return { accountUrl, pat };
}

function headers(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'wink-api/0.1',
  };
}

function rowsFrom(body: Record<string, unknown>): Row[] {
  const meta = isRecord(body.resultSetMetaData) ? body.resultSetMetaData : {};
  const names = Array.isArray(meta.rowType)
    ? meta.rowType.map((c) => (isRecord(c) && typeof c.name === 'string' ? c.name.toLowerCase() : ''))
    : [];
  const data = Array.isArray(body.data) ? body.data : [];
  return data.map((raw) => {
    const row: Row = {};
    if (Array.isArray(raw)) names.forEach((name, i) => { row[name] = raw[i] == null ? null : String(raw[i]); });
    return row;
  });
}

/**
 * Runs one statement through the Snowflake SQL API v2 with positional `?` bindings (all TEXT).
 * Polls GET /api/v2/statements/{handle} when Snowflake answers 202.
 */
export async function sql(env: Env, statement: string, binds: string[] = [], timeoutSeconds = 30): Promise<Row[]> {
  const { accountUrl, pat } = config(env);
  const bindings: Record<string, { type: string; value: string }> = {};
  binds.forEach((value, i) => { bindings[String(i + 1)] = { type: 'TEXT', value }; });
  const body: Record<string, unknown> = {
    statement,
    timeout: timeoutSeconds,
    database: env.SNOWFLAKE_DATABASE?.trim() || 'WINK',
    schema: env.SNOWFLAKE_SCHEMA?.trim() || 'APP',
    warehouse: env.SNOWFLAKE_WAREHOUSE?.trim() || 'WINK_WH',
  };
  if (env.SNOWFLAKE_ROLE?.trim()) body.role = env.SNOWFLAKE_ROLE.trim();
  if (binds.length) body.bindings = bindings;

  const deadline = Date.now() + (timeoutSeconds + 5) * 1000;
  let response = await providerFetch(`${accountUrl}/api/v2/statements`, {
    method: 'POST', headers: headers(pat), body: JSON.stringify(body),
  }, (timeoutSeconds + 5) * 1000, 'Snowflake');

  while (true) {
    const payload: unknown = await response.json().catch(() => null);
    const result = isRecord(payload) ? payload : {};
    if (response.status === 200) return rowsFrom(result);
    if (response.status === 202 && typeof result.statementHandle === 'string') {
      if (Date.now() > deadline) throw new HttpError(504, 'snowflake_timeout', 'Snowflake took too long.');
      await new Promise((resolve) => setTimeout(resolve, 400));
      response = await providerFetch(`${accountUrl}/api/v2/statements/${encodeURIComponent(result.statementHandle)}`,
        { method: 'GET', headers: headers(pat) }, 15_000, 'Snowflake');
      continue;
    }
    console.error(`Snowflake ${response.status}: ${String(result.message ?? '').slice(0, 300)} (code ${String(result.code ?? '')})`);
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, 'snowflake_auth', 'Snowflake rejected the token (check the PAT and network policy).');
    }
    throw new HttpError(502, 'snowflake_error', 'The Snowflake query failed.');
  }
}

// ---------- MEMORIES ----------

const MEMORY_COLUMNS = `id,
  TO_VARCHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS created_at,
  kind, title, summary, visible_text, TO_JSON(objects) AS objects, note, image_key,
  TO_JSON(selection) AS selection, lat, lng, TO_JSON(place) AS place, product_query`;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export function rowToMemory(row: Row): StoredMemory {
  const lat = row.lat == null ? NaN : Number(row.lat);
  const lng = row.lng == null ? NaN : Number(row.lng);
  const objects = parseJson<unknown>(row.objects, []);
  const selection = parseJson<Selection | null>(row.selection, null);
  return {
    id: row.id ?? '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    kind: row.kind === 'passive' ? 'passive' : 'explicit',
    title: row.title ?? '',
    summary: row.summary ?? '',
    visibleText: row.visible_text ?? '',
    objects: Array.isArray(objects) ? objects.map(String) : [],
    note: row.note || null,
    imageKey: row.image_key ?? '',
    selection: selection && typeof selection === 'object' && 'mode' in selection ? selection : { mode: 'full', box: null },
    location: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
    place: parseJson<Place | null>(row.place, null),
    productQuery: row.product_query || null,
  };
}

function embedModel(env: Env): string {
  return env.EMBED_MODEL?.trim() || 'snowflake-arctic-embed-l-v2.0';
}

export function embeddingText(m: Pick<StoredMemory, 'title' | 'summary' | 'visibleText' | 'objects' | 'note'>): string {
  return [m.title, m.summary, m.visibleText, m.objects.join(', '), m.note ?? ''].filter(Boolean).join('. ').slice(0, 4000);
}

export const INSERT_MEMORY_SQL = `INSERT INTO MEMORIES
  (id, created_at, kind, title, summary, visible_text, objects, note, image_key, selection, lat, lng, place, product_query, embedding)
SELECT ?, TO_TIMESTAMP_TZ(?), ?, ?, ?, ?, PARSE_JSON(?), NULLIF(?, ''), ?, PARSE_JSON(?),
  TRY_TO_DOUBLE(NULLIF(?, '')), TRY_TO_DOUBLE(NULLIF(?, '')), PARSE_JSON(NULLIF(?, '')), NULLIF(?, ''),
  SNOWFLAKE.CORTEX.EMBED_TEXT_1024(?, ?)`;

export async function insertMemory(env: Env, m: StoredMemory): Promise<void> {
  await sql(env, INSERT_MEMORY_SQL, [
    m.id, m.createdAt, m.kind, m.title, m.summary, m.visibleText, JSON.stringify(m.objects), m.note ?? '',
    m.imageKey, JSON.stringify(m.selection), m.location ? String(m.location.lat) : '',
    m.location ? String(m.location.lng) : '', m.place ? JSON.stringify(m.place) : '', m.productQuery ?? '',
    embedModel(env), embeddingText(m),
  ]);
}

export async function listMemories(env: Env, limit: number): Promise<StoredMemory[]> {
  const n = Math.min(200, Math.max(1, Math.floor(limit) || 50));
  const rows = await sql(env, `SELECT ${MEMORY_COLUMNS} FROM MEMORIES ORDER BY created_at DESC LIMIT ${n}`);
  return rows.map(rowToMemory);
}

export async function getMemory(env: Env, id: string): Promise<StoredMemory | null> {
  const rows = await sql(env, `SELECT ${MEMORY_COLUMNS} FROM MEMORIES WHERE id = ?`, [id]);
  return rows[0] ? rowToMemory(rows[0]) : null;
}

export async function deleteMemory(env: Env, id: string): Promise<string | null> {
  const rows = await sql(env, 'SELECT image_key FROM MEMORIES WHERE id = ?', [id]);
  await sql(env, 'DELETE FROM MEMORIES WHERE id = ?', [id]);
  return rows[0]?.image_key ?? null;
}

export const SEARCH_MEMORIES_SQL = `SELECT ${MEMORY_COLUMNS},
  VECTOR_COSINE_SIMILARITY(embedding, SNOWFLAKE.CORTEX.EMBED_TEXT_1024(?, ?)) AS score
FROM MEMORIES
WHERE embedding IS NOT NULL
ORDER BY score DESC
LIMIT 3`;

/** Top-3 vector search, weak matches dropped. Best match first. */
export async function searchMemories(env: Env, question: string): Promise<Array<StoredMemory & { score: number }>> {
  const rows = await sql(env, SEARCH_MEMORIES_SQL, [embedModel(env), question.slice(0, 2000)]);
  const scored = rows.map((row) => ({ ...rowToMemory(row), score: Number(row.score ?? 0) }));
  const best = scored[0]?.score ?? 0;
  return scored.filter((m) => m.score >= ASK_MIN_SCORE && m.score >= best - ASK_RELATIVE_GAP);
}

// ---------- OVERTURE PLACES ----------

/** OVERTURE_PLACES_TABLE is interpolated into SQL, so only allow identifier characters. */
export function placesTable(env: Env): string {
  const table = env.OVERTURE_PLACES_TABLE?.trim() || 'OVERTURE_MAPS__PLACES.CARTO.PLACE';
  if (!/^[A-Za-z0-9_$."]+$/.test(table)) {
    throw new HttpError(503, 'not_configured', 'OVERTURE_PLACES_TABLE is not a valid table name.');
  }
  return table;
}

// Column shapes follow the CARTO Overture listing (VARIANT columns with Parquet-style list wrappers).
// Verify with CoCo: see snowflake/02_overture_explore.sql.
const PLACE_COLUMNS = `ID AS id,
  NAMES:primary::STRING AS name,
  CATEGORIES:primary::STRING AS category,
  PHONES:list[0]:element::STRING AS phone,
  ADDRESSES:list[0]:element:freeform::STRING AS street,
  ADDRESSES:list[0]:element:locality::STRING AS locality,
  ADDRESSES:list[0]:element:region::STRING AS region,
  ST_Y(GEOMETRY) AS lat,
  ST_X(GEOMETRY) AS lng`;

export function nearbySql(table: string): string {
  return `SELECT ${PLACE_COLUMNS},
  ST_DISTANCE(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT)) AS meters
FROM ${table}
WHERE ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT), ?::FLOAT)
  AND (ARRAY_CONTAINS(CATEGORIES:primary, PARSE_JSON(?)::ARRAY)
       OR REGEXP_LIKE(NAMES:primary::STRING, ?, 'i'))
ORDER BY meters
LIMIT 5`;
}

export function businessMatchSql(table: string): string {
  return `SELECT ${PLACE_COLUMNS},
  ST_DISTANCE(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT)) AS meters,
  JAROWINKLER_SIMILARITY(LOWER(NAMES:primary::STRING), LOWER(?)) AS similarity
FROM ${table}
WHERE ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT), ?::FLOAT)
  AND JAROWINKLER_SIMILARITY(LOWER(NAMES:primary::STRING), LOWER(?)) >= 85
ORDER BY similarity DESC, meters
LIMIT 1`;
}

function rowToPlace(row: Row): Place {
  const address = [row.street, row.locality, row.region].filter(Boolean).join(', ');
  const meters = row.meters == null ? NaN : Number(row.meters);
  return {
    id: row.id ?? '',
    name: row.name ?? 'Unnamed place',
    category: row.category ?? 'place',
    address: address || null,
    phone: row.phone || null,
    lat: Number(row.lat ?? 0),
    lng: Number(row.lng ?? 0),
    distanceMeters: Number.isFinite(meters) ? Math.round(meters) : null,
  };
}

function escapeRegex(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function nearbyPlaces(env: Env, location: Location, categories: string[], keywords: string[],
  radiusMeters = NEARBY_RADIUS_METERS): Promise<Place[]> {
  const words = keywords.map((k) => k.trim()).filter((k) => k.length >= 3).slice(0, 5);
  // An impossible pattern when there are no keywords, so only categories match.
  const pattern = words.length ? `.*(${words.map(escapeRegex).join('|')}).*` : '^\\b$';
  const lng = String(location.lng), lat = String(location.lat);
  const rows = await sql(env, nearbySql(placesTable(env)),
    [lng, lat, lng, lat, String(radiusMeters), JSON.stringify(categories.slice(0, 6)), pattern], 45);
  return rows.map(rowToPlace);
}

export async function matchBusiness(env: Env, location: Location, name: string): Promise<Place | null> {
  const lng = String(location.lng), lat = String(location.lat);
  const rows = await sql(env, businessMatchSql(placesTable(env)),
    [lng, lat, name, lng, lat, String(BUSINESS_MATCH_RADIUS_METERS), name], 20);
  return rows[0] ? rowToPlace(rows[0]) : null;
}
