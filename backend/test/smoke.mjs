import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Run against a running local MOCK server. Never creates memories in a real account.
const base = new URL(process.env.WINK_BASE_URL || 'http://127.0.0.1:8787');
const token = process.env.WINK_TOKEN || '';
const headers = token ? { Authorization: `Bearer ${token}` } : {};
const health = await fetch(new URL('/v1/health', base)).then((response) => response.json());
assert.equal(health.mock, true, 'Smoke test requires MOCK=true; real-account mutation refused.');
const sockets = [];
const received = [];
let savedId;

async function request(path, method = 'GET', body) {
  const form = body instanceof FormData;
  const response = await fetch(new URL(path, base), {
    method, headers: { ...headers, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: form ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${response.ok ? '' : await response.text()}`);
  return response;
}
async function socket(role) {
  const url = new URL('/v1/live', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', role);
  if (token) url.searchParams.set('token', token);
  const ws = new WebSocket(url);
  sockets.push(ws);
  if (role === 'tv') ws.addEventListener('message', ({ data }) => {
    if (data !== 'pong') received.push(JSON.parse(data));
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket failed')); }, { once: true });
  });
  return ws;
}
async function event(type, predicate = () => true) {
  for (let i = 0; i < 100; i++) {
    const found = received.find((item) => item.type === type && predicate(item));
    if (found) return found;
    await delay(25);
  }
  throw new Error(`Missing TV event: ${type}`);
}
try {
  const page = await request('/tv');
  assert.match(await page.text(), /app\.js/);
  assert.equal((await request('/tv/app.js')).status, 200);
  await socket('tv');
  const glasses = await socket('glasses');
  await request('/v1/events', 'POST', { type: 'status', state: 'listening' });
  await event('status', (value) => value.state === 'listening');
  glasses.send(JSON.stringify({ type: 'pointer', x: 0.4, y: 0.5, pinching: true }));
  await event('pointer');
  glasses.send(JSON.stringify({ type: 'memory.deleted', id: 'forged' }));
  const form = new FormData();
  form.set('image', new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }), 'smoke.jpg');
  form.set('meta', JSON.stringify({ note: 'smoke test book', selection: { mode: 'full', box: null } }));
  const save = await request('/v1/memories', 'POST', form);
  assert.equal(save.status, 201);
  const saved = await save.json();
  savedId = saved.memory.id;
  await event('memory.saved', (value) => value.memory.id === savedId);
  const image = await request(new URL(saved.memory.imageUrl).pathname);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  const listed = await (await request('/v1/memories')).json();
  assert.ok(listed.memories.some((memory) => memory.id === savedId));
  const answer = await (await request('/v1/ask', 'POST', { question: 'what was that book?' })).json();
  assert.ok(answer.memories.some((memory) => memory.id === savedId));
  await event('answer');
  const near = await (await request('/v1/nearby', 'POST', { memoryId: savedId, location: { lat: 35.2059, lng: -97.4457 } })).json();
  assert.ok(near.places.length > 0 && near.places.length <= 5);
  await event('nearby');
  assert.equal((await request(`/v1/memories/${savedId}`, 'DELETE')).status, 204);
  await event('memory.deleted', (value) => value.id === savedId);
  assert.equal((await fetch(saved.memory.imageUrl)).status, 404);
  assert.ok(!received.some((value) => value.type === 'memory.deleted' && value.id === 'forged'));
  savedId = undefined;
  await request('/v1/events', 'POST', { type: 'status', state: 'idle' });
  console.log('PASS: TV assets, live relay, rejected forgery, save/list/image/ask/nearby/delete, and R2 deletion.');
} finally {
  if (savedId) await request(`/v1/memories/${savedId}`, 'DELETE').catch(() => {});
  sockets.forEach((ws) => ws.close());
}
