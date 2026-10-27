import { parseClientEvent } from './events.ts';
import { HttpError } from './http.ts';
import { seedMemories } from './mock.ts';
import type { Env, LiveEvent, StoredMemory } from './types.ts';

// Workers runtime globals and the hibernation-capable state, typed by hand (no workers-types).
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };
declare class WebSocketRequestResponsePair { constructor(request: string, response: string) }
interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
interface DurableObjectState {
  storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  getTags(ws: WebSocket): string[];
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
}

const ROOM = 'wink-room';
const MAX_MESSAGE = 1024 * 1024;

export type BroadcastTarget = 'all' | 'tv';

/**
 * One shared room. Uses the WebSocket Hibernation API so idle sockets cost nothing.
 * - glasses → tv relay for pointer/frame/status events
 * - POST /broadcast from the Worker routes pushes memory/glance/answer/nearby events
 * - /mock/memories keeps MOCK-mode memories so save → list → ask → delete feels real
 */
export class LiveRoom {
  private mockQueue: Promise<unknown> = Promise.resolve();
  private readonly rates = new WeakMap<WebSocket, { pointer: number[]; frame: number[] }>();
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    try {
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    } catch { /* older runtimes */ }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket upgrade.', { status: 426 });
      }
      const role = url.searchParams.get('role') === 'glasses' ? 'glasses' : 'tv';
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [role]);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const { event, to } = await request.json() as { event: LiveEvent; to?: BroadcastTarget };
      const sent = this.send(JSON.stringify(event), to === 'tv' ? 'tv' : undefined);
      return Response.json({ sent });
    }
    if (/^\/mock\/memories(?:\/[^/]+)?$/.test(url.pathname)) {
      // Awaited storage reads can interleave; serialize demo mutations to avoid losing saves.
      const work = this.mockQueue.then(() => this.mockMemories(request, url));
      this.mockQueue = work.catch(() => undefined);
      return work;
    }
    if (url.pathname === '/stats') {
      return Response.json({ tv: this.ctx.getWebSockets('tv').length, glasses: this.ctx.getWebSockets('glasses').length });
    }
    return new Response('Not found', { status: 404 });
  }

  private send(message: string, tag?: string): number {
    let sent = 0;
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.send(message);
        sent++;
      } catch { /* socket already closing */ }
    }
    return sent;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE || message === 'ping') return;
    const tags = this.ctx.getTags(ws);
    if (!tags.includes('glasses')) return; // only the glasses drive the TV
    let event: LiveEvent;
    try { event = parseClientEvent(JSON.parse(message), true); } catch { return; }
    if (event.type === 'pointer' || event.type === 'frame') {
      const now = Date.now();
      // Attachments survive hibernation, keeping high-rate event limits across wakeups.
      const socket = ws as WebSocket & { deserializeAttachment?(): unknown; serializeAttachment?(value: unknown): void };
      const previous = socket.deserializeAttachment?.() as { pointer: number[]; frame: number[] } | undefined;
      const rates = previous ?? this.rates.get(ws) ?? { pointer: [], frame: [] };
      rates[event.type] = rates[event.type].filter((time) => now - time < 1000);
      if (rates[event.type].length >= (event.type === 'pointer' ? 20 : 2)) return;
      rates[event.type].push(now);
      this.rates.set(ws, rates);
      socket.serializeAttachment?.(rates);
    }
    this.send(JSON.stringify(event), 'tv');
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
  }

  // ----- MOCK store -----
  private async mockList(): Promise<StoredMemory[]> {
    const added = (await this.ctx.storage.get<StoredMemory[]>('mock:added')) ?? [];
    const deleted = new Set((await this.ctx.storage.get<string[]>('mock:deleted')) ?? []);
    return [...added, ...seedMemories()].filter((m) => !deleted.has(m.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async mockMemories(request: Request, url: URL): Promise<Response> {
    const id = decodeURIComponent(url.pathname.slice('/mock/memories/'.length));
    if (request.method === 'GET' && !id) return Response.json({ memories: await this.mockList() });
    if (request.method === 'GET') {
      return Response.json({ memory: (await this.mockList()).find((m) => m.id === id) ?? null });
    }
    if (request.method === 'POST') {
      const memory = await request.json() as StoredMemory;
      const added = (await this.ctx.storage.get<StoredMemory[]>('mock:added')) ?? [];
      await this.ctx.storage.put('mock:added', [memory, ...added].slice(0, 100));
      return Response.json({ ok: true });
    }
    if (request.method === 'DELETE' && id) {
      const added = (await this.ctx.storage.get<StoredMemory[]>('mock:added')) ?? [];
      const victim = added.find((m) => m.id === id);
      await this.ctx.storage.put('mock:added', added.filter((m) => m.id !== id));
      const deleted = (await this.ctx.storage.get<string[]>('mock:deleted')) ?? [];
      await this.ctx.storage.put('mock:deleted', [...new Set([...deleted, id])].slice(-200));
      return Response.json({ imageKey: victim?.imageKey ?? null });
    }
    return new Response('Method not allowed', { status: 405 });
  }
}

// ----- helpers the routes use -----

function room(env: Env) {
  return env.LIVE.get(env.LIVE.idFromName(ROOM));
}

export async function broadcast(env: Env, event: LiveEvent, to: BroadcastTarget = 'all'): Promise<void> {
  try {
    const response = await room(env).fetch('https://live/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, to }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Live room returned ${response.status}`);
  } catch (error) {
    console.error(`broadcast ${event.type} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function connectLive(env: Env, request: Request, role: string): Promise<Response> {
  const target = new URL('https://live/connect');
  target.searchParams.set('role', role);
  return room(env).fetch(new Request(target.toString(), request));
}

export async function mockStore<T>(env: Env, method: string, id = '', body?: unknown): Promise<T> {
  const response = await room(env).fetch(`https://live/mock/memories${id ? `/${encodeURIComponent(id)}` : ''}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new HttpError(502, 'storage_error', 'The demo memory store is unavailable.');
  return await response.json() as T;
}
