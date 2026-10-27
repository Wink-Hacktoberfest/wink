import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClientEvent } from '../src/events.ts';
import { LiveRoom } from '../src/live.ts';
import { seedMemories } from '../src/mock.ts';
import type { Env, StoredMemory } from '../src/types.ts';

function roomFixture() {
  const tvMessages: string[] = [], glassesMessages: string[] = [];
  const tv = { send: (text: string) => tvMessages.push(text) } as unknown as WebSocket;
  let attachment: unknown;
  const glasses = { send: (text: string) => glassesMessages.push(text),
    serializeAttachment: (value: unknown) => { attachment = structuredClone(value); },
    deserializeAttachment: () => structuredClone(attachment),
  } as unknown as WebSocket;
  const store = new Map<string, unknown>();
  const state = {
    storage: {
      async get<T>(key: string): Promise<T | undefined> { await Promise.resolve(); return structuredClone(store.get(key)) as T | undefined; },
      async put(key: string, value: unknown) { await Promise.resolve(); store.set(key, structuredClone(value)); },
    },
    acceptWebSocket() {}, setWebSocketAutoResponse() {},
    getWebSockets: (tag?: string) => tag === 'tv' ? [tv] : tag === 'glasses' ? [glasses] : [tv, glasses],
    getTags: (socket: WebSocket) => socket === glasses ? ['glasses'] : ['tv'],
  };
  return { room: new LiveRoom(state, {} as Env), tv, glasses, tvMessages, glassesMessages, state };
}

test('client events reject forged server events and malformed coordinates', () => {
  for (const value of [null, { type: 'memory.saved', memory: {} }, { type: 'pointer', x: 2, y: 0.5, pinching: true },
    { type: 'gesture', gesture: 'point', box: { x: 0.8, y: 0, w: 0.5, h: 1 } },
    { type: 'gesture', gesture: 'fingers', value: NaN }]) {
    assert.throws(() => parseClientEvent(value, true));
  }
  assert.throws(() => parseClientEvent({ type: 'pointer', x: 0.5, y: 0.5, pinching: true }));
});

test('relay validates roles, JSON, and rate limits pointer/frame events across hibernation', async () => {
  const f = roomFixture();
  await f.room.webSocketMessage(f.tv, '{"type":"transcript","text":"forged"}');
  await f.room.webSocketMessage(f.glasses, '{broken');
  await f.room.webSocketMessage(f.glasses, '{"type":"memory.deleted","id":"victim"}');
  for (let i = 0; i < 25; i++) {
    await f.room.webSocketMessage(f.glasses, JSON.stringify({ type: 'pointer', x: 0.5, y: 0.5, pinching: true }));
  }
  for (let i = 0; i < 4; i++) {
    await f.room.webSocketMessage(f.glasses, JSON.stringify({ type: 'frame', jpegBase64: '/9j/2Q==' }));
  }
  const restored = new LiveRoom(f.state, {} as Env);
  await restored.webSocketMessage(f.glasses, JSON.stringify({ type: 'pointer', x: 0.5, y: 0.5, pinching: false }));
  assert.equal(f.tvMessages.length, 22);
  assert.equal(f.glassesMessages.length, 0);
});

test('concurrent mock saves persist every accepted memory', async () => {
  const { room } = roomFixture();
  await Promise.all(Array.from({ length: 20 }, (_, i) => room.fetch(new Request('https://live/mock/memories', {
    method: 'POST', body: JSON.stringify({ ...seedMemories()[0], id: `concurrent-${i}` }),
  }))));
  const response = await room.fetch(new Request('https://live/mock/memories'));
  const { memories } = await response.json() as { memories: StoredMemory[] };
  assert.equal(memories.filter((memory) => memory.id.startsWith('concurrent-')).length, 20);
});
