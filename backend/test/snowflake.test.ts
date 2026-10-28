import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../src/http.ts';
import { nearbyPlaces, placesTable, sql, SnowflakeRejectedError } from '../src/snowflake.ts';
import type { Env } from '../src/types.ts';

const env = { SNOWFLAKE_ACCOUNT_URL: 'https://test-account.snowflakecomputing.com', SNOWFLAKE_PAT: 'test-pat' } as Env;
function result(names: string[], data: Array<Array<string | number | null>>, extra: Record<string, unknown> = {}) {
  return { resultSetMetaData: { rowType: names.map((name) => ({ name })), numRows: data.length }, data, ...extra };
}
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
