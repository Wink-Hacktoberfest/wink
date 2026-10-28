import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import worker, { LiveRoom } from '../src/index.ts';
import { RECENT_QUESTION } from '../src/routes/ask.ts';
import type { Env, LiveEvent } from '../src/types.ts';

const ORIGIN = 'https://wink-api.example';
const TOKEN = 'test-wink-token';

function environment(overrides: Partial<Env> = {}) {
  const sent: LiveEvent[] = [];
  const store = new Map<string, unknown>();
  const images = new Map<string, Uint8Array>();
  const ctx = {
    storage: {
      async get(key: string) { return structuredClone(store.get(key)); },
      async put(key: string, value: unknown) { store.set(key, structuredClone(value)); },
    },
    acceptWebSocket() {},
    getWebSockets: () => [{ send: (m: string) => sent.push(JSON.parse(m)) }],
    getTags: () => ['tv'],
    setWebSocketAutoResponse() {},
  };
  const room = new LiveRoom(ctx as never, {} as Env);
  const env = {
    MOCK: 'true',
    WINK_TOKEN: TOKEN,
    IMAGES: {
      async get(key: string) {
        const bytes = images.get(key);
        return bytes ? { body: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(), httpEtag: '"e"', httpMetadata: { contentType: 'image/jpeg' } } : null;
      },
      async put(key: string, value: Uint8Array) { images.set(key, value); },
      async delete(key: string) { images.delete(key); },
    },
    LIVE: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: (input: Request | string, init?: RequestInit) => room.fetch(new Request(input, init)) }),
    },
    ...overrides,
  } as unknown as Env;
  return { env, sent, images };
}

function call(env: Env, method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: payload }), env);
}

function upload(meta: Record<string, unknown>) {
  const form = new FormData();
  form.set('image', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'frame.jpg');
  form.set('meta', JSON.stringify(meta));
  return form;
}

afterEach(() => mock.restoreAll());

function noNetwork() {
  return mock.method(globalThis, 'fetch', async () => { throw new Error('MOCK mode must not call providers.'); });
}

test('health is public and reports models', async () => {
  const { env } = environment();
  const response = await call(env, 'GET', '/v1/health', undefined, null);
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; mock: boolean; models: Record<string, string> };
  assert.equal(body.ok, true);
  assert.equal(body.mock, true);
  assert.equal(body.models.chat, 'openai-gpt-oss-120b');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('auth: wrong or missing token gets the contract error shape', async () => {
  const { env } = environment();
  for (const token of [null, 'nope']) {
    const response = await call(env, 'GET', '/v1/memories', undefined, token);
    assert.equal(response.status, 401);
    const body = await response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'unauthorized');
    assert.ok(body.error.message);
  }
  const notFound = await call(env, 'GET', '/v1/nope');
  assert.equal(notFound.status, 404);
  assert.equal(((await notFound.json()) as { error: { code: string } }).error.code, 'not_found');
});

test('real mode without a token fails closed', async () => {
  const { env } = environment({ MOCK: 'false', WINK_TOKEN: '' });
  const response = await call(env, 'GET', '/v1/memories', undefined, null);
  assert.equal(response.status, 503);
});

test('mock sample photographs use exact bundled paths without forwarding credentials', async () => {
  const seen: Request[] = [];
  const { env } = environment({ ASSETS: { fetch: async (request: Request) => {
    seen.push(request);
    return new Response('generated-photo', { headers: { 'Content-Type': 'image/webp' } });
  } } as Env['ASSETS'] });
  const listed = await (await call(env, 'GET', '/v1/memories')).json() as { memories: { imageUrl: string }[] };
  assert.equal(listed.memories.length, 4);
  for (const memory of listed.memories) {
    assert.equal(new URL(memory.imageUrl).searchParams.get('v'), 'photo-1', 'Sample URLs must bypass cached legacy SVGs');
  }
  for (const name of ['wine', 'book', 'keys', 'coffee']) {
    const response = await call(env, 'GET', '/v1/images/sample-' + name + '?token=do-not-forward');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(await response.text(), 'generated-photo');
    assert.equal(seen.at(-1)!.url, ORIGIN + '/tv/demo/' + name + '.webp');
    assert.equal(seen.at(-1)!.headers.has('Authorization'), false);
  }
  assert.equal((await call(env, 'GET', '/v1/images/sample-unknown')).status, 404);
  assert.equal((await call(env, 'GET', '/v1/images/constructor')).status, 404);
  assert.equal(seen.length, 4);

  env.MOCK = 'false';
  const realSample = await call(env, 'GET', '/v1/images/sample-wine');
  assert.equal(realSample.headers.get('content-type'), 'image/svg+xml');
  assert.equal(seen.length, 4, 'Real mode retains its existing image behavior');
});

test('mock sample images retain SVG fallback when bundled photographs are unavailable', async () => {
  for (const assets of [undefined, { fetch: async () => new Response('missing', { status: 404 }) }]) {
    const { env } = environment({ ASSETS: assets as Env['ASSETS'] });
    const response = await call(env, 'GET', '/v1/images/sample-book');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.match(await response.text(), /Project Hail Mary/);
  }
});

test('mock: save → list → ask → nearby → delete, broadcasting each step', async () => {
  const provider = noNetwork();
  const { env, sent, images } = environment();

  const saved = await call(env, 'POST', '/v1/memories', upload({
    utterance: "hey wink save this it's the wine sam liked", note: 'the wine sam liked',
    selection: { mode: 'point', box: { x: 0.31, y: 0.18, w: 0.35, h: 0.4 } }, kind: 'explicit', source: 'glasses',
    capturedAt: new Date().toISOString(), location: { lat: 35.2, lng: -97.44 },
  }));
  assert.equal(saved.status, 201);
  const { memory, speech } = await saved.json() as { memory: Record<string, any>; speech: string };
  assert.equal(memory.title, '2019 Malbec, Mendoza');
  assert.equal(memory.note, 'the wine sam liked');
  assert.match(memory.imageUrl, /^https:\/\/wink-api\.example\/v1\/images\/.+\.jpg$/);
  assert.equal(memory.imageKey, undefined);
  assert.deepEqual(memory.selection, { mode: 'point', box: { x: 0.31, y: 0.18, w: 0.35, h: 0.4 } });
  assert.equal(speech, 'Saved. 2019 Malbec, Mendoza. The wine sam liked.');
  assert.equal(sent.at(-1)?.type, 'memory.saved');
  assert.equal(images.size, 1);

  const img = await call(env, 'GET', new URL(memory.imageUrl).pathname, undefined, null);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');

  const list = await (await call(env, 'GET', '/v1/memories?limit=50')).json() as { memories: Array<{ id: string }> };
  assert.equal(list.memories[0]?.id, memory.id);
  assert.ok(list.memories.length >= 2);

  const answer = await (await call(env, 'POST', '/v1/ask', { question: 'what was that wine?', location: null })).json() as { speech: string; memories: Array<{ id: string }> };
  assert.equal(answer.memories[0]?.id, memory.id);
  assert.match(answer.speech, /Malbec/);
  assert.equal(sent.at(-1)?.type, 'answer');

  const none = await (await call(env, 'POST', '/v1/ask', { question: 'where is my passport?', location: null })).json() as { speech: string; memories: unknown[] };
  assert.equal(none.memories.length, 0);
  assert.match(none.speech, /don't have a memory/);

  const near = await (await call(env, 'POST', '/v1/nearby', { memoryId: memory.id, query: null, location: { lat: 35.2, lng: -97.44 } })).json() as { speech: string; places: Array<{ distanceMeters: number }> };
  assert.equal(near.places.length, 3);
  assert.match(near.speech, /^Three wine shops nearby\. The closest is .+, 400 meters away\.$/);
  assert.equal(sent.at(-1)?.type, 'nearby');

  const deleted = await call(env, 'DELETE', `/v1/memories/${memory.id}`);
  assert.equal(deleted.status, 204);
  assert.deepEqual(sent.at(-1), { type: 'memory.deleted', id: memory.id });
  assert.equal(images.size, 0);
  const after = await (await call(env, 'GET', '/v1/memories')).json() as { memories: Array<{ id: string }> };
  assert.ok(!after.memories.some((m) => m.id === memory.id));

  assert.equal(provider.mock.callCount(), 0);
});

test('mock glance and events relay', async () => {
  noNetwork();
  const { env, sent } = environment();
  const glance = await call(env, 'POST', '/v1/glance', upload({ utterance: "what's this book?", location: null }));
  assert.equal(glance.status, 200);
  const body = await glance.json() as { speech: string; title: string; objects: string[] };
  assert.equal(body.title, 'Project Hail Mary');
  assert.ok(body.speech.split(' ').length <= 25);

  const ok = await call(env, 'POST', '/v1/events', { type: 'gesture', gesture: 'pinch', value: 1 });
  assert.equal(ok.status, 202);
  assert.deepEqual(sent.at(-1), { type: 'gesture', gesture: 'pinch', value: 1 });
  const bad = await call(env, 'POST', '/v1/events', { type: 'memory.deleted', id: 'x' });
  assert.equal(bad.status, 400);
});

test('upload without an image is a 400', async () => {
  const { env } = environment();
  const form = new FormData();
  form.set('meta', '{}');
  const response = await call(env, 'POST', '/v1/memories', form);
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'missing_image');
});

test('deletion keeps the row retryable when R2 fails and images are never cached', async () => {
  const { env, images, sent } = environment();
  const response = await call(env, 'POST', '/v1/memories', upload({ note: 'book' }));
  const { memory } = await response.json() as { memory: { id: string; imageUrl: string } };
  const image = await call(env, 'GET', new URL(memory.imageUrl).pathname);
  assert.equal(image.headers.get('cache-control'), 'no-store');
  const remove = env.IMAGES.delete;
  env.IMAGES.delete = async () => { throw new Error('R2 unavailable'); };
  assert.equal((await call(env, 'DELETE', `/v1/memories/${memory.id}`)).status, 502);
  const list = await (await call(env, 'GET', '/v1/memories')).json() as { memories: Array<{ id: string }> };
  assert.ok(list.memories.some((m) => m.id === memory.id));
  assert.equal(sent.filter((event) => event.type === 'memory.deleted').length, 0);
  env.IMAGES.delete = remove;
  assert.equal((await call(env, 'DELETE', `/v1/memories/${memory.id}`)).status, 204);
  assert.equal(images.size, 0);
});

function realEnvironment() {
  return environment({ MOCK: 'false', DATABASE_URL: 'postgresql://wink_app:secret@ep-test.us-east-2.aws.neon.tech/wink',
    DO_MODEL_ACCESS_KEY: 'test-model-key', VISION_PROVIDER: 'workers-ai',
    AI: { async run(model: string) {
      if (model.includes('bge')) return { data: [Array.from({ length: 1024 }, () => 0.5)] };
      return { response: JSON.stringify({ title: 'Project Hail Mary', summary: 'A science fiction book.', objects: ['book'], visibleText: 'Andy Weir' }) };
    } },
  });
}

/** Neon SQL-over-HTTP reply: raw text values in array mode. */
function sqlResult(values: Record<string, unknown>[]) {
  const names = Object.keys(values[0] ?? {});
  return Response.json({ fields: names.map((name) => ({ name, dataTypeID: 25 })),
    rows: values.map((row) => names.map((key) => (row[key] == null ? null : String(row[key])))) });
}

test('real routes: vision → R2 → embedded Neon insert → search/answer → delete', async () => {
  const { env, images, sent } = realEnvironment();
  let row: Record<string, unknown> | undefined;
  let insertParams: unknown[] = [];
  mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert.equal(init.redirect, 'manual');
    if (input.startsWith('https://inference.do-ai.run/')) {
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'That was Project Hail Mary by Andy Weir.' } }] });
    }
    const payload = JSON.parse(String(init.body)) as { query: string; params: unknown[] };
    if (payload.query.startsWith('INSERT')) {
      insertParams = payload.params;
      const keys = ['id', 'created_at', 'kind', 'title', 'summary', 'visible_text', 'objects', 'note', 'image_key', 'selection', 'lat', 'lng', 'place', 'product_query'];
      row = Object.fromEntries(keys.map((key, i) => [key, payload.params[i]]));
      return sqlResult([]);
    }
    if (payload.query.startsWith('DELETE')) {
      const deleted = row;
      row = undefined;
      return sqlResult(deleted ? [{ image_key: deleted.image_key }] : []);
    }
    return sqlResult(row ? [{ ...row, score: '0.9' }] : []);
  });
  const saved = await call(env, 'POST', '/v1/memories', upload({ note: 'book from Sam', location: null }));
  assert.equal(saved.status, 201);
  const { memory } = await saved.json() as { memory: { id: string; title: string; imageKey?: string } };
  assert.equal(memory.title, 'Project Hail Mary');
  assert.equal(memory.imageKey, undefined);
  assert.match(String(insertParams[14]), /^\[0\.5,/);
  assert.equal(insertParams[15], '@cf/baai/bge-m3');
  assert.equal(images.size, 1);
  const answer = await call(env, 'POST', '/v1/ask', { question: 'what was that book?' });
  assert.equal(answer.status, 200);
  const answerBody = await answer.json() as { speech: string; memories: Array<{ id: string; score?: number }> };
  assert.match(answerBody.speech, /Andy Weir/);
  assert.equal(answerBody.memories[0]?.id, memory.id);
  assert.equal(answerBody.memories[0]?.score, undefined);
  assert.equal((await call(env, 'DELETE', `/v1/memories/${memory.id}`)).status, 204);
  assert.equal(images.size, 0);
  assert.deepEqual(sent.map((event) => event.type), ['memory.saved', 'answer', 'memory.deleted']);
});

test('real ask adds the newest memory when the question is about the last save', async () => {
  const { env } = realEnvironment();
  const old = { id: 'old', created_at: '2026-10-26T19:12:03.000Z', title: 'Oklahoma Sooners shirt', objects: '["shirt"]' };
  const newest = { id: 'newest', created_at: '2026-10-28T23:35:00.000Z', title: 'Project Hail Mary book', objects: '["book"]' };
  const queries: string[] = [];
  let prompt = '';
  mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    if (input.startsWith('https://inference.do-ai.run/')) {
      prompt = String(init.body);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'You just saved Project Hail Mary.' } }] });
    }
    const payload = JSON.parse(String(init.body)) as { query: string };
    queries.push(payload.query);
    // Search finds nothing clear; the newest-first listing returns the book.
    return payload.query.includes('<=>') ? sqlResult([{ ...old, score: '0.39' }]) : sqlResult([newest]);
  });
  const answer = await (await call(env, 'POST', '/v1/ask', { question: 'what did I just save?' })).json() as { speech: string; memories: Array<{ id: string }> };
  assert.deepEqual(answer.memories.map((m) => m.id), ['newest']);
  assert.match(answer.speech, /Project Hail Mary/);
  assert.match(prompt, /Project Hail Mary book/);
  assert.equal(queries.filter((q) => q.includes('ORDER BY created_at DESC')).length, 1);

  queries.length = 0;
  await call(env, 'POST', '/v1/ask', { question: 'what was that shirt?' });
  assert.equal(queries.some((q) => q.includes('ORDER BY created_at DESC')), false);
});

test('recent-save questions are recognised without catching ordinary ones', () => {
  for (const q of ['what did I just save?', 'What was the last thing I saved?', "what's the latest thing I captured", 'what was the book I just saved?']) {
    assert.match(q, RECENT_QUESTION, q);
  }
  for (const q of ['what was that book?', 'where did I park my car?', 'how long does the battery last?', 'save this']) {
    assert.doesNotMatch(q, RECENT_QUESTION, q);
  }
});

test('failed inserts clean images only on definite rejection, preserving ambiguous commits', async () => {
  const replies: Array<[() => Response, number]> = [
    [() => Response.json({ message: 'check violation', code: '23514' }, { status: 400 }), 0],
    [() => new Response('upstream', { status: 500 }), 1],
    [() => { throw new TypeError('connection reset'); }, 1],
  ];
  for (const [reply, retained] of replies) {
    const { env, images, sent } = realEnvironment();
    const transport = mock.method(globalThis, 'fetch', async () => reply());
    assert.equal((await call(env, 'POST', '/v1/memories', upload({ note: 'book' }))).status, 502);
    assert.equal(images.size, retained);
    assert.equal(sent.length, 0);
    transport.mock.restore();
  }
});

test('invalid route escapes, spoofed live events, and missing nearby memories return contract errors', async () => {
  const { env } = environment();
  assert.equal((await call(env, 'DELETE', '/v1/memories/%FF')).status, 400);
  assert.equal((await call(env, 'POST', '/v1/events', { type: 'gesture', gesture: 'point', box: { x: 'bad' } })).status, 400);
  assert.equal((await call(env, 'POST', '/v1/nearby', { memoryId: 'missing', location: { lat: 35, lng: -97 } })).status, 404);
});
