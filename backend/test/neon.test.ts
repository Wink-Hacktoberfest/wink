import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../src/http.ts';
import {
  backfillEmbeddings, deleteMemory, insertMemory, query, rowToMemory, searchMemories, StoreRejectedError,
} from '../src/neon.ts';
import type { Env, StoredMemory } from '../src/types.ts';

const DATABASE_URL = 'postgresql://wink_app:secret@ep-test-123.us-east-2.aws.neon.tech/wink?sslmode=require';
const vector = Array.from({ length: 1024 }, (_, i) => (i % 7) / 10);
const embedCalls: string[] = [];
const env = {
  DATABASE_URL,
  AI: { async run(model: string, inputs: { text: string[] }) { embedCalls.push(...inputs.text.map((text) => `${model}:${text}`)); return { data: inputs.text.map(() => vector), shape: [inputs.text.length, 1024] }; } },
} as unknown as Env;
const memory: StoredMemory = {
  id: 'memory-id', createdAt: '2026-10-26T19:12:03.000Z', kind: 'explicit', title: "Sam's book",
  summary: 'A book about space.', visibleText: 'COSMOS', objects: ['book'], note: null,
  imageKey: 'image-id.jpg', selection: { mode: 'full', box: null }, location: null, place: null,
};
const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;

/** Neon's SQL-over-HTTP reply: raw text values in array mode. */
function neonResult(rows: Array<Record<string, unknown>>, command = 'SELECT') {
  const names = Object.keys(rows[0] ?? {});
  return Response.json({
    command, rowCount: rows.length,
    fields: names.map((name) => ({ name, dataTypeID: 25 })),
    rows: rows.map((row) => names.map((name) => (row[name] == null ? null : String(row[name])))),
  });
}
type Sent = { url: string; init: RequestInit; body: { query: string; params: unknown[] } };
function capture(t: { mock: { method: Function } }, reply: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit) => {
    const call = { url: String(input), init, body: JSON.parse(String(init.body)) };
    sent.push(call);
    return reply(call);
  });
  return sent;
}

test('queries go to the Neon HTTP endpoint with bound params and come back as raw text', async (t) => {
  const sent = capture(t, () => neonResult([{ id: 'a', lat: 35.2, note: null }]));
  assert.deepEqual(await query(env, 'SELECT id, lat, note FROM memories WHERE id = $1', ['a']), [{ id: 'a', lat: '35.2', note: null }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'https://api.us-east-2.aws.neon.tech/sql');
  assert.ok(new Headers(sent[0]!.init.headers).get('Neon-Connection-String')?.startsWith(DATABASE_URL));
  assert.deepEqual(sent[0]!.body, { query: 'SELECT id, lat, note FROM memories WHERE id = $1', params: ['a'] });
  assert.equal(sent[0]!.init.redirect, 'manual');
});

test('jsonb, boolean, float and timestamptz columns stay Postgres text so rows parse one way', async (t) => {
  // Real type ids: jsonb 3802, bool 16, float8 701, timestamptz 1184. Default parsers would turn these into objects.
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    command: 'SELECT', rowCount: 1,
    fields: [['objects', 3802], ['selection', 3802], ['flag', 16], ['lat', 701], ['at', 1184]].map(([name, dataTypeID]) => ({ name, dataTypeID })),
    rows: [['["book", "pen"]', '{"box": null, "mode": "full"}', 't', '35.2', '2026-10-27 03:13:17+00']],
  }));
  assert.deepEqual(await query(env, 'SELECT 1'), [{
    objects: '["book", "pen"]', selection: '{"box": null, "mode": "full"}', flag: 't', lat: '35.2', at: '2026-10-27 03:13:17+00',
  }]);
});

test('a missing or malformed DATABASE_URL is reported before any request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  for (const url of [undefined, '', 'not a url', 'https://ep-test.neon.tech/wink', 'postgresql://ep-test.neon.tech/wink']) {
    await assert.rejects(query({ ...env, DATABASE_URL: url }, 'SELECT 1'), hasCode('not_configured'));
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('Postgres errors are definite rejections; transport failures stay ambiguous', async (t) => {
  const cases: Array<[() => Response | never, string, boolean]> = [
    [() => Response.json({ message: 'duplicate key (secret)', code: '23505' }, { status: 400 }), 'database_error', true],
    [() => Response.json({ message: 'password authentication failed', code: '28P01' }, { status: 400 }), 'database_auth', true],
    [() => Response.json({ message: 'too many connections', code: '53300' }, { status: 400 }), 'database_busy', true],
    [() => new Response('upstream', { status: 503 }), 'database_unavailable', false],
    [() => { throw new TypeError('network down'); }, 'database_unavailable', false],
  ];
  for (const [reply, code, rejected] of cases) {
    const stub = t.mock.method(globalThis, 'fetch', async () => reply());
    await assert.rejects(query(env, 'INSERT INTO memories VALUES ($1)', ['private note']), (error: unknown) => {
      assert.equal(error instanceof StoreRejectedError, rejected, code);
      return hasCode(code)(error);
    });
    assert.equal(stub.mock.callCount(), 1);
    stub.mock.restore();
  }
});

test('slow queries time out as ambiguous failures', async (t) => {
  t.mock.method(globalThis, 'fetch', (_input: RequestInfo | URL, init: RequestInit) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  await assert.rejects(query(env, 'SELECT pg_sleep(60)', [], 20), (error: unknown) => {
    assert.equal(error instanceof StoreRejectedError, false);
    return hasCode('database_timeout')(error);
  });
});

test('insert binds JSON, nullable fields and the pgvector literal with its model', async (t) => {
  const sent = capture(t, () => neonResult([], 'INSERT'));
  embedCalls.length = 0;
  assert.equal(await insertMemory(env, memory), true);
  const { query: text, params } = sent[0]!.body;
  assert.doesNotMatch(text, /Sam's/);
  assert.match(text, /ON CONFLICT \(id\) DO NOTHING/);
  assert.equal(params[1], memory.createdAt);
  assert.equal(params[6], '["book"]');
  for (const i of [7, 10, 11, 12, 13]) assert.equal(params[i], null);
  assert.match(String(params[14]), /^\[0,0\.1,0\.2,/);
  assert.equal(params[15], '@cf/baai/bge-m3');
  assert.match(embedCalls[0]!, /^@cf\/baai\/bge-m3:Sam's book\. A book about space\.+ COSMOS\. book$/);
});

test('a save still lands when the embedding model is down, without a vector', async (t) => {
  const sent = capture(t, () => neonResult([], 'INSERT'));
  const down = { ...env, AI: { async run() { throw new Error('model down'); } } } as unknown as Env;
  assert.equal(await insertMemory(down, memory), false);
  assert.equal(sent[0]!.body.params[14], null);
  assert.equal(sent[0]!.body.params[15], null);
});

test('search compares only same-model vectors and drops weak or distant matches', async (t) => {
  const row = (score: string) => ({ id: memory.id, created_at: memory.createdAt, title: memory.title, objects: '["book"]', score });
  const sent = capture(t, () => neonResult([row('0.81'), row('0.76'), row('0.50')]));
  const matches = await searchMemories(env, 'What was that book?');
  assert.deepEqual(matches.map((match) => match.score), [0.81, 0.76]);
  assert.equal(sent[0]!.body.params[1], '@cf/baai/bge-m3');
  assert.match(sent[0]!.body.query, /embed_model = \$2/);
});

test('delete returns the image key so the route can clean R2', async (t) => {
  const sent = capture(t, () => neonResult([{ image_key: 'image-id.jpg' }], 'DELETE'));
  assert.equal(await deleteMemory(env, memory.id), 'image-id.jpg');
  assert.match(sent[0]!.body.query, /RETURNING image_key/);
});

test('backfill embeds rows that are missing a vector', async (t) => {
  const sent = capture(t, ({ body }) => body.query.startsWith('SELECT')
    ? neonResult([{ id: 'old', title: 'Malbec', summary: 'Wine bottle', visible_text: '', objects: '["bottle"]', note: 'for Dad' }])
    : neonResult([], 'UPDATE'));
  assert.equal(await backfillEmbeddings(env), 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.body.params.slice(1), ['@cf/baai/bge-m3', 'old']);
});

test('memory conversion validates dates, coordinates, selection and nullable JSON', () => {
  const parsed = rowToMemory({ id: 'm', created_at: memory.createdAt, objects: '["book",null,42]',
    selection: '{"mode":"bogus"}', lat: '999', lng: '3', place: null, note: null });
  assert.deepEqual(parsed.objects, ['book']);
  assert.deepEqual(parsed.selection, { mode: 'full', box: null });
  assert.equal(parsed.location, null);
  assert.equal(parsed.place, null);
  assert.throws(() => rowToMemory({ created_at: 'broken date' }), hasCode('database_response'));
});

test('wrong-size or non-numeric embeddings never reach SQL', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not query'); });
  for (const data of [[[0.1, 0.2]], [Array.from({ length: 1024 }, () => Number.NaN)], []]) {
    const bad = { ...env, AI: { async run() { return { data }; } } } as unknown as Env;
    await assert.rejects(searchMemories(bad, 'what was that book?'), hasCode('provider_error'));
  }
  assert.equal(fetch.mock.callCount(), 0);
});
