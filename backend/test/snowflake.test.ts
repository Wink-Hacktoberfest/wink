import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../src/http.ts';
import { insertMemory, nearbyPlaces, placesTable, rowToMemory, searchMemories, sql, SnowflakeRejectedError } from '../src/snowflake.ts';
import type { Env, StoredMemory } from '../src/types.ts';

const env = { SNOWFLAKE_ACCOUNT_URL: 'https://test-account.snowflakecomputing.com', SNOWFLAKE_PAT: 'test-pat' } as Env;
const memory: StoredMemory = {
  id: 'memory-id', createdAt: '2026-10-26T19:12:03.000Z', kind: 'explicit', title: "Sam's book",
  summary: 'A book about space.', visibleText: 'COSMOS', objects: ['book'], note: null,
  imageKey: 'image-id.jpg', selection: { mode: 'full', box: null }, location: null, place: null,
};
function result(names: string[], data: Array<Array<string | number | null>>, extra: Record<string, unknown> = {}) {
  return { resultSetMetaData: { rowType: names.map((name) => ({ name })), numRows: data.length }, data, ...extra };
}
function memoryRow(score: string) { return [memory.id, memory.createdAt, memory.title, '["book"]', score]; }
const memoryNames = ['ID', 'CREATED_AT', 'TITLE', 'OBJECTS', 'SCORE'];
const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;

test('SQL API binds values, keeps PAT on its configured origin, and polls without repeating POST', async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return Response.json({ statementHandle: 'handle/1', statementStatusUrl: 'https://elsewhere.invalid/steal' }, { status: 202 });
    return Response.json(result(['TITLE'], [["Sam's book"]]));
  });
  assert.deepEqual(await sql(env, 'SELECT ? AS title', ["Sam's book"]), [{ title: "Sam's book" }]);
  assert.equal(calls.length, 2);
  const request = JSON.parse(String(calls[0]!.init!.body));
  assert.deepEqual(request.bindings, { '1': { type: 'TEXT', value: "Sam's book" } });
  assert.equal(request.statement, 'SELECT ? AS title');
  assert.equal(calls[1]!.url, `${env.SNOWFLAKE_ACCOUNT_URL}/api/v2/statements/handle%2F1`);
  assert.equal(calls[1]!.init!.method, 'GET');
  assert.equal(new Headers(calls[0]!.init!.headers).get('X-Snowflake-Authorization-Token-Type'), 'PROGRAMMATIC_ACCESS_TOKEN');
  assert.equal(calls[0]!.init!.redirect, 'manual');
});

test('SQL API reads all partitions using the original column metadata', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    urls.push(String(input));
    if (urls.length === 1) return Response.json({ statementHandle: 'partitioned', resultSetMetaData: {
      rowType: [{ name: 'ID' }, { name: 'NOTE' }], numRows: 3,
      partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }],
    }, data: [['a', null]] });
    return Response.json({ data: [[urls.length === 2 ? 'b' : 'c', 'note']] });
  });
  assert.deepEqual(await sql(env, 'SELECT id, note FROM MEMORIES'), [
    { id: 'a', note: null }, { id: 'b', note: 'note' }, { id: 'c', note: 'note' },
  ]);
  assert.match(urls[1]!, /partition=1$/);
  assert.match(urls[2]!, /partition=2$/);
});

test('SQL API never treats malformed or truncated results as success', async (t) => {
  for (const payload of [{}, result(['ID'], [{} as never]), result(['ID'], [['a']], {
    resultSetMetaData: { rowType: [{ name: 'ID' }], numRows: 2 },
  }), { statementHandle: 'h', data: [] }]) {
    const stub = t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    await assert.rejects(sql(env, 'SELECT id FROM MEMORIES'), hasCode('snowflake_response'));
    stub.mock.restore();
  }
});

test('SQL API classifies auth, timeouts and rate limits without replaying writes', async (t) => {
  for (const [status, code] of [[401, 'snowflake_auth'], [403, 'snowflake_auth'], [408, 'snowflake_timeout'], [429, 'snowflake_busy'], [422, 'snowflake_error']] as const) {
    const stub = t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'test' }, { status }));
    await assert.rejects(sql(env, 'INSERT INTO MEMORIES SELECT ?', ['private note']), (error: unknown) => {
      assert.equal(error instanceof SnowflakeRejectedError, status !== 408);
      return hasCode(code)(error);
    });
    assert.equal(stub.mock.callCount(), 1);
    stub.mock.restore();
  }
});

test('SQL API recovers rate-limited polls by retrying GET only', async (t) => {
  let count = 0;
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    count += 1;
    if (count === 1) return Response.json({ statementHandle: 'h' }, { status: 202 });
    if (count === 2) return Response.json({}, { status: 429 });
    return Response.json(result(['STATUS'], [['saved']]));
  });
  assert.deepEqual(await sql(env, 'INSERT INTO MEMORIES SELECT ?', ['private note']), [{ status: 'saved' }]);
  assert.deepEqual(methods, ['POST', 'GET', 'GET']);
});

test('SQL API rejects unsafe account configuration before sending the PAT', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  for (const url of ['http://account.snowflakecomputing.com', 'https://user:pass@account.snowflakecomputing.com', 'https://account.snowflakecomputing.com/path']) {
    await assert.rejects(sql({ ...env, SNOWFLAKE_ACCOUNT_URL: url }, 'SELECT 1'), hasCode('not_configured'));
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('insert binds nullable JSON, timestamp and embedding input', async (t) => {
  let body: { statement: string; bindings: Record<string, { value: string }> } | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json(result(['number of rows inserted'], [['1']]));
  });
  await insertMemory(env, memory);
  assert.ok(body);
  assert.doesNotMatch(body.statement, /Sam's/);
  assert.equal(body.bindings['2']!.value, memory.createdAt);
  assert.equal(body.bindings['7']!.value, '["book"]');
  for (const key of ['8', '11', '13']) assert.equal(body.bindings[key]!.value, '');
  assert.equal(body.bindings['15']!.value, 'snowflake-arctic-embed-l-v2.0');
  assert.match(body.bindings['16']!.value, /COSMOS/);
});

test('search drops weak and relatively distant matches while preserving order', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(result(memoryNames, [memoryRow('0.81'), memoryRow('0.70'), memoryRow('0.50')])));
  const matches = await searchMemories(env, 'What was that book?');
  assert.deepEqual(matches.map((match) => match.score), [0.81, 0.70]);
});

test('memory conversion validates dates, coordinates, selection and nullable JSON', () => {
  const parsed = rowToMemory({ id: 'm', created_at: memory.createdAt, objects: '["book",null,42]',
    selection: '{"mode":"bogus"}', lat: '999', lng: '3', place: null, note: null });
  assert.deepEqual(parsed.objects, ['book']);
  assert.deepEqual(parsed.selection, { mode: 'full', box: null });
  assert.equal(parsed.location, null);
  assert.equal(parsed.place, null);
  assert.throws(() => rowToMemory({ created_at: 'broken date' }), hasCode('snowflake_response'));
});

test('nearby binds longitude first, escapes keywords and discards invalid coordinates', async (t) => {
  let body: { statement: string; bindings: Record<string, { value: string }> } | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    if (body!.statement.startsWith('DESCRIBE TABLE')) return Response.json(schemaResult('TAXONOMY'));
    return Response.json(result(['ID', 'NAME', 'CATEGORY', 'STREET', 'LOCALITY', 'REGION', 'LAT', 'LNG', 'METERS'], [
      ['1', 'Books+', 'book_store', '1 Main', 'Norman', 'OK', '35.2', '-97.4', '225.7'],
      ['2', 'Missing location', 'book_store', null, null, null, null, null, null],
    ]));
  });
  const places = await nearbyPlaces(env, { lat: 35.2, lng: -97.4 }, ['book_store'], ['books+']);
  assert.deepEqual(body!.bindings['1'], { type: 'TEXT', value: '-97.4' });
  assert.equal(body!.bindings['7']!.value, '.*(books\\+).*');
  assert.equal(places.length, 1);
  assert.equal(places[0]!.distanceMeters, 226);
  assert.equal(places[0]!.address, '1 Main, Norman, OK');
});

test('place table accepts quoted identifiers but rejects malformed names and SQL', () => {
  assert.equal(placesTable({ ...env, OVERTURE_PLACES_TABLE: '"My Database".CARTO.PLACE' }), '"My Database".CARTO.PLACE');
  for (const name of ['DB..PLACE', '1DB.CARTO.PLACE', 'DB.CARTO.PLACE;DELETE FROM MEMORIES', '"DB.CARTO.PLACE', 'A.B.C.D']) {
    assert.throws(() => placesTable({ ...env, OVERTURE_PLACES_TABLE: name }), hasCode('not_configured'));
  }
});


function schemaResult(category: string, geometry = 'GEOGRAPHY') {
  return result(['name', 'type'], [
    ['ID', 'VARCHAR'], ['NAMES', 'VARIANT'], ['PHONES', 'VARIANT'], ['ADDRESSES', 'VARIANT'],
    [category, 'VARIANT'], ['GEOMETRY', geometry],
  ]);
}

test('rejected status poll after accepted INSERT is never a definite write rejection', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return calls === 1 ? Response.json({ statementHandle: 'h' }, { status: 202 }) : Response.json({}, { status: 403 });
  });
  await assert.rejects(sql(env, 'INSERT INTO MEMORIES SELECT ?', ['private note']), (error: unknown) => {
    assert.equal(error instanceof SnowflakeRejectedError, false);
    return hasCode('snowflake_auth')(error);
  });
});

test('nearby discovers legacy categories and caches the schema', async (t) => {
  let descriptions = 0;
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    if (request.statement.startsWith('DESCRIBE TABLE')) {
      descriptions += 1;
      return Response.json(schemaResult('CATEGORIES'));
    }
    assert.match(request.statement, /CATEGORIES:primary/);
    assert.doesNotMatch(request.statement, /TAXONOMY:primary/);
    return Response.json(result(['ID'], []));
  });
  const legacyEnv = { ...env, OVERTURE_PLACES_TABLE: 'LEGACY.CARTO.PLACE' };
  for (let i = 0; i < 2; i += 1) await nearbyPlaces(legacyEnv, { lat: 35.2, lng: -97.4 }, ['book_store'], []);
  assert.equal(descriptions, 1);
});

test('nearby rejects planar geometry before issuing a query with meter distances', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(schemaResult('TAXONOMY', 'GEOMETRY')));
  await assert.rejects(nearbyPlaces({ ...env, OVERTURE_PLACES_TABLE: 'PLANAR.CARTO.PLACE' },
    { lat: 35.2, lng: -97.4 }, ['book_store'], []), hasCode('overture_schema'));
  assert.equal(fetch.mock.callCount(), 1);
});
