import { HttpError, isRecord, providerFetch } from './http.ts';
import { parseSelection } from './parse.ts';
import type { Env, Location, Place, StoredMemory } from './types.ts';

/** Minimum cosine similarity for a memory to count as a match in /v1/ask (Arctic Embed L v2.0). */
export const ASK_MIN_SCORE = 0.3;
/** Also drop matches far below the best one. */
export const ASK_RELATIVE_GAP = 0.12;
export const NEARBY_RADIUS_METERS = 3000;
export const BUSINESS_MATCH_RADIUS_METERS = 250;

type Row = Record<string, string | null>;

/** Initial submission was explicitly rejected, so an INSERT could not have committed. */
export class SnowflakeRejectedError extends HttpError {}

function config(env: Env) {
  const accountUrl = env.SNOWFLAKE_ACCOUNT_URL?.trim().replace(/\/+$/, '');
  const pat = env.SNOWFLAKE_PAT?.trim();
  if (!accountUrl || !pat) {
    throw new HttpError(503, 'not_configured', 'Snowflake is not configured (SNOWFLAKE_ACCOUNT_URL, SNOWFLAKE_PAT).');
  }
  let url: URL;
  try { url = new URL(accountUrl); } catch {
    throw new HttpError(503, 'not_configured', 'SNOWFLAKE_ACCOUNT_URL must be an HTTPS account origin.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new HttpError(503, 'not_configured', 'SNOWFLAKE_ACCOUNT_URL must be an HTTPS account origin.');
  }
  return { accountUrl: url.origin, pat };
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

function invalidResult(): never {
  throw new HttpError(502, 'snowflake_response', 'Snowflake returned an invalid result.');
}

function columnNames(body: Record<string, unknown>): string[] {
  const meta = body.resultSetMetaData;
  if (!isRecord(meta) || !Array.isArray(meta.rowType)) return invalidResult();
  return meta.rowType.map((column) => {
    if (!isRecord(column) || typeof column.name !== 'string' || !column.name) return invalidResult();
    return column.name.toLowerCase();
  });
}

function rowsFrom(body: Record<string, unknown>, names: string[]): Row[] {
  if (!Array.isArray(body.data)) return invalidResult();
  return body.data.map((raw) => {
    if (!Array.isArray(raw) || raw.length !== names.length) return invalidResult();
    const row: Row = {};
    names.forEach((name, i) => {
      const value: unknown = raw[i];
      if (value != null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return invalidResult();
      }
      row[name] = value == null ? null : String(value);
    });
    return row;
  });
}

function queryError(status: number, result: Record<string, unknown>, initialSubmission = false): never {
  const Failure = initialSubmission && [401, 403, 422, 429].includes(status) ? SnowflakeRejectedError : HttpError;
  // Provider messages can contain SQL and memory contents. Log only diagnostic identifiers.
  console.error(`Snowflake HTTP ${status}; code ${String(result.code ?? '').slice(0, 30)}`);
  if (status === 401 || status === 403) {
    throw new Failure(502, 'snowflake_auth', 'Snowflake rejected the token (check the PAT and network policy).');
  }
  if (status === 408 || status === 504) {
    throw new HttpError(504, 'snowflake_timeout', 'Snowflake took too long.');
  }
  if (status === 429) throw new Failure(503, 'snowflake_busy', 'Snowflake is busy. Try again shortly.');
  if (status >= 500) throw new HttpError(502, 'snowflake_unavailable', 'Snowflake is temporarily unavailable.');
  throw new Failure(502, 'snowflake_error', 'The Snowflake query failed.');
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
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new HttpError(504, 'snowflake_timeout', 'Snowflake took too long.');
    return ms;
  };
  const pause = async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, remaining())));
    remaining();
  };
  const get = (path: string) => providerFetch(`${accountUrl}${path}`,
    { method: 'GET', headers: headers(pat) }, remaining(), 'Snowflake');

  // Never blindly retry POST: a lost response may still have committed an INSERT.
  let response = await providerFetch(`${accountUrl}/api/v2/statements`, {
    method: 'POST', headers: headers(pat), body: JSON.stringify(body),
  }, remaining(), 'Snowflake');
  let handle: string | undefined;
  let polling = false;
  let transientRetries = 0;
  let pollDelay = 250;
  let result: Record<string, unknown>;
  while (true) {
    const payload: unknown = await response.json().catch(() => null);
    result = isRecord(payload) ? payload : {};
    if (typeof result.statementHandle === 'string' && result.statementHandle) handle = result.statementHandle;
    if (response.status === 200) break;
    if (response.status === 202 && handle) {
      await pause(pollDelay);
      pollDelay = Math.min(pollDelay * 2, 1500);
      polling = true;
    } else if (polling && handle && [429, 502, 503].includes(response.status) && transientRetries < 3) {
      transientRetries += 1;
      await pause(250 * 2 ** transientRetries);
    } else {
      if (response.status === 202) return invalidResult();
      queryError(response.status, result, !polling);
    }
    // Build the path ourselves; never forward a PAT to a provider-supplied URL.
    response = await get(`/api/v2/statements/${encodeURIComponent(handle!)}`);
  }
  const names = columnNames(result);
  const rows = rowsFrom(result, names);
  const meta = result.resultSetMetaData as Record<string, unknown>;
  const partitions = Array.isArray(meta.partitionInfo) ? meta.partitionInfo : [];
  if (partitions.length > 1 && !handle) return invalidResult();
  for (let partition = 1; partition < partitions.length; partition += 1) {
    const path = `/api/v2/statements/${encodeURIComponent(handle!)}?partition=${partition}`;
    let partitionResult: Record<string, unknown>;
    for (let attempt = 0; ; attempt += 1) {
      const next = await get(path);
      const payload: unknown = await next.json().catch(() => null);
      partitionResult = isRecord(payload) ? payload : {};
      if (next.status === 200) break;
      if ([202, 429, 502, 503].includes(next.status) && attempt < 3) {
        await pause(250 * 2 ** attempt);
        continue;
      }
      queryError(next.status, partitionResult);
    }
    // Later partitions may omit metadata: retain the first partition's columns.
    rows.push(...rowsFrom(partitionResult, names));
  }
  if (typeof meta.numRows === 'number' && rows.length !== meta.numRows) return invalidResult();
  return rows;
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
  const selection = parseSelection(parseJson<unknown>(row.selection, null));
  const timestamp = row.created_at ? new Date(row.created_at) : null;
  if (!timestamp || !Number.isFinite(timestamp.getTime())) return invalidResult();
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

/** AI_EMBED needs the model as a string literal (bindings are rejected), so only plain model ids are allowed. */
function embedModel(env: Env): string {
  const model = env.EMBED_MODEL?.trim() || 'snowflake-arctic-embed-l-v2.0';
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(model)) throw new HttpError(503, 'not_configured', 'EMBED_MODEL is not a valid model id.');
  return model;
}

export function embeddingText(m: Pick<StoredMemory, 'title' | 'summary' | 'visibleText' | 'objects' | 'note'>): string {
  return [m.title, m.summary, m.visibleText, m.objects.join(', '), m.note ?? ''].filter(Boolean).join('. ').slice(0, 4000);
}

export const insertMemorySql = (model: string) => `INSERT INTO MEMORIES
  (id, created_at, kind, title, summary, visible_text, objects, note, image_key, selection, lat, lng, place, product_query, embedding)
SELECT ?, TO_TIMESTAMP_TZ(?), ?, ?, ?, ?, PARSE_JSON(?), NULLIF(?, ''), ?, PARSE_JSON(?),
  TRY_TO_DOUBLE(NULLIF(?, '')), TRY_TO_DOUBLE(NULLIF(?, '')), PARSE_JSON(NULLIF(?, '')), NULLIF(?, ''),
  AI_EMBED('${model}', ?)`;

export async function insertMemory(env: Env, m: StoredMemory): Promise<void> {
  await sql(env, insertMemorySql(embedModel(env)), [
    m.id, m.createdAt, m.kind, m.title, m.summary, m.visibleText, JSON.stringify(m.objects), m.note ?? '',
    m.imageKey, JSON.stringify(m.selection), m.location ? String(m.location.lat) : '',
    m.location ? String(m.location.lng) : '', m.place ? JSON.stringify(m.place) : '', m.productQuery ?? '',
    embeddingText(m),
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

export const searchMemoriesSql = (model: string) => `SELECT ${MEMORY_COLUMNS},
  VECTOR_COSINE_SIMILARITY(embedding, AI_EMBED('${model}', ?)) AS score
FROM MEMORIES
WHERE embedding IS NOT NULL
ORDER BY score DESC
LIMIT 3`;

/** Top-3 vector search, weak matches dropped. Best match first. */
export async function searchMemories(env: Env, question: string): Promise<Array<StoredMemory & { score: number }>> {
  const rows = await sql(env, searchMemoriesSql(embedModel(env)), [question.slice(0, 2000)]);
  const scored = rows.map((row) => ({ ...rowToMemory(row), score: Number(row.score ?? 0) }));
  const best = scored[0]?.score ?? 0;
  return scored.filter((m) => m.score >= ASK_MIN_SCORE && m.score >= best - ASK_RELATIVE_GAP);
}

// ---------- OVERTURE PLACES ----------

/** Validate each component because OVERTURE_PLACES_TABLE is interpolated into SQL. */
export function placesTable(env: Env): string {
  const table = env.OVERTURE_PLACES_TABLE?.trim() || 'OVERTURE_MAPS_PLACES.CARTO.PLACE';
  // One to three unquoted or properly quoted identifiers; dots inside quotes are legal.
  const identifier = '(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:[^"\\x00-\\x1f]|"")+")';
  if (!new RegExp(`^${identifier}(?:\\.${identifier}){0,2}$`).test(table)) {
    throw new HttpError(503, 'not_configured', 'OVERTURE_PLACES_TABLE is not a valid table name.');
  }
  return table;
}

type CategoryColumn = 'TAXONOMY' | 'CATEGORIES';
const placeSchemaCache = new Map<string, { expires: number; column: CategoryColumn }>();

/** Overture moved categories to taxonomy; discover the installed release instead of guessing. */
async function categoryColumn(env: Env, table: string): Promise<CategoryColumn> {
  const key = JSON.stringify([env.SNOWFLAKE_ACCOUNT_URL, env.SNOWFLAKE_DATABASE, env.SNOWFLAKE_SCHEMA, env.SNOWFLAKE_ROLE, table]);
  const cached = placeSchemaCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.column;
  const rows = await sql(env, `DESCRIBE TABLE ${table}`);
  const columns = new Map(rows.map((row) => [(row.name ?? '').toUpperCase(), (row.type ?? '').toUpperCase()]));
  const column = columns.has('TAXONOMY') ? 'TAXONOMY' : columns.has('CATEGORIES') ? 'CATEGORIES' : null;
  if (!column || !['ID', 'NAMES', 'PHONES', 'ADDRESSES', 'GEOMETRY'].every((name) => columns.has(name))) {
    throw new HttpError(503, 'overture_schema', 'The Overture table schema needs verification. See snowflake/02_overture_explore.sql.');
  }
  // Planar GEOMETRY distances are degrees, not meters; require an explicitly normalized view.
  if (columns.get('GEOMETRY') !== 'GEOGRAPHY') {
    throw new HttpError(503, 'overture_schema', 'Overture GEOMETRY must be GEOGRAPHY. Configure a normalized view for meter distances.');
  }
  if (placeSchemaCache.size >= 32) placeSchemaCache.clear();
  placeSchemaCache.set(key, { column, expires: Date.now() + 5 * 60_000 });
  return column;
}

// Legacy Parquet list wrappers and newer native arrays both appear in Overture releases.
function placeColumns(category: CategoryColumn): string {
  return `ID AS id,
  NAMES:primary::STRING AS name,
  ${category}:primary::STRING AS category,
  COALESCE(PHONES:list[0]:element::STRING, PHONES[0]::STRING) AS phone,
  COALESCE(ADDRESSES:list[0]:element:freeform::STRING, ADDRESSES[0]:freeform::STRING) AS street,
  COALESCE(ADDRESSES:list[0]:element:locality::STRING, ADDRESSES[0]:locality::STRING) AS locality,
  COALESCE(ADDRESSES:list[0]:element:region::STRING, ADDRESSES[0]:region::STRING) AS region,
  ST_Y(GEOMETRY) AS lat,
  ST_X(GEOMETRY) AS lng`;
}

export function nearbySql(table: string, category: CategoryColumn = 'TAXONOMY'): string {
  return `SELECT ${placeColumns(category)},
  ST_DISTANCE(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT)) AS meters
FROM ${table}
WHERE ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT), ?::FLOAT)
  AND (ARRAY_CONTAINS(${category}:primary, PARSE_JSON(?)::ARRAY)
       OR REGEXP_LIKE(NAMES:primary::STRING, ?, 'i'))
ORDER BY meters, id
LIMIT 5`;
}

export function businessMatchSql(table: string, category: CategoryColumn = 'TAXONOMY'): string {
  return `SELECT ${placeColumns(category)},
  ST_DISTANCE(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT)) AS meters,
  JAROWINKLER_SIMILARITY(LOWER(NAMES:primary::STRING), LOWER(?)) AS similarity
FROM ${table}
WHERE ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT), ?::FLOAT)
  AND JAROWINKLER_SIMILARITY(LOWER(NAMES:primary::STRING), LOWER(?)) >= 85
ORDER BY similarity DESC, meters
LIMIT 1`;
}

function validCoordinates(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function rowToPlace(row: Row): Place | null {
  const lat = row.lat == null || row.lat.trim() === '' ? NaN : Number(row.lat);
  const lng = row.lng == null || row.lng.trim() === '' ? NaN : Number(row.lng);
  if (!validCoordinates(lat, lng) || !row.id) return null;
  const address = [row.street, row.locality, row.region].filter(Boolean).join(', ');
  const meters = row.meters == null ? NaN : Number(row.meters);
  return {
    id: row.id ?? '',
    name: row.name ?? 'Unnamed place',
    category: row.category ?? 'place',
    address: address || null,
    phone: row.phone || null,
    lat,
    lng,
    distanceMeters: Number.isFinite(meters) && meters >= 0 ? Math.round(meters) : null,
  };
}

function escapeRegex(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function nearbyPlaces(env: Env, location: Location, categories: string[], keywords: string[],
  radiusMeters = NEARBY_RADIUS_METERS): Promise<Place[]> {
  const words = keywords.map((k) => k.trim()).filter((k) => k.length >= 3).slice(0, 5);
  // An impossible pattern when there are no keywords, so only categories match.
  const pattern = words.length ? `.*(${words.map(escapeRegex).join('|')}).*` : 'a^';
  const lng = String(location.lng), lat = String(location.lat);
  const table = placesTable(env);
  const category = await categoryColumn(env, table);
  const rows = await sql(env, nearbySql(table, category),
    [lng, lat, lng, lat, String(radiusMeters), JSON.stringify(categories.slice(0, 6)), pattern], 45);
  return rows.map(rowToPlace).filter((place): place is Place => place !== null);
}

export async function matchBusiness(env: Env, location: Location, name: string): Promise<Place | null> {
  const lng = String(location.lng), lat = String(location.lat);
  const table = placesTable(env);
  const category = await categoryColumn(env, table);
  const rows = await sql(env, businessMatchSql(table, category),
    [lng, lat, name, lng, lat, String(BUSINESS_MATCH_RADIUS_METERS), name], 20);
  return rows[0] ? rowToPlace(rows[0]) : null;
}
