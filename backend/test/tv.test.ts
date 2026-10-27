import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Minimal DOM fixture: exercises the shipped dashboard script without a browser dependency.
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  events: Record<string, (event?: any) => unknown> = {};
  textContent = '';
  src = '';
  className = '';
  disabled = false;
  hidden = false;
  isConnected = true;
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
    remove: (...names: string[]) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
    toggle: (name: string, on: boolean) => on ? this.classList.add(name) : this.classList.remove(name),
  };
  append(...nodes: Element[]) { nodes.forEach((node) => { node.parent = this; this.children.push(node); }); }
  prepend(node: Element) { node.parent = this; this.children.unshift(node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
  replaceWith(node: Element) { if (this.parent) { node.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this), 1, node); } }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  removeAttribute(key: string) { delete this.attributes[key]; if (key === 'src') this.src = ''; }
  addEventListener(name: string, callback: (event?: any) => unknown) { this.events[name] = callback; }
  querySelector(selector: string): Element | null {
    for (const child of this.children) {
      const match = selector.match(/^\.([\w-]+)(?:\[data-id="(.*)"\])?$/);
      if (match && child.classList.contains(match[1]!) && (!match[2] || child.dataset.id === match[2])) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  focus() {}
  scrollTo() {}
  scrollIntoView() {}
}
const source = readFileSync(new URL('../public/tv/app.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function dashboard(fetcher: (url: string, options?: any) => Promise<unknown> = async (url) => new Response(JSON.stringify(url.endsWith('/health') ? { mock: true } : { memories: [] })), search = '') {
  const nodes = new Map<string, Element>();
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const sockets: any[] = [];
  const timeouts = new Map<number, () => void>();
  const requests: { url: string; options: any }[] = [];
  let replacedUrl = '';
  const context: any = {
    URL, URLSearchParams, AbortSignal, console, innerWidth: 1920, innerHeight: 1080,
    location: { origin: 'http://localhost:8787', pathname: '/tv', hash: '', search },
    navigator: { onLine: true },
    localStorage: { setItem() {}, getItem() { return ''; } },
    history: { replaceState(_a: unknown, _b: unknown, url: string) { replacedUrl = url; } },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn: () => void) { const id = timeouts.size + 1; timeouts.set(id, fn); return id; },
    clearTimeout(id: number) { timeouts.delete(id); },
    CSS: { escape: (value: string) => value },
    fetch: (url: string, options: any) => { requests.push({ url, options }); return fetcher(url, options); },
    WebSocket: class { constructor() { sockets.push(this); } send() {} close() {} },
    document: {
      getElementById: node, createElement: () => new Element(), createTextNode: () => new Element(),
      querySelectorAll: () => [], elementFromPoint: () => null, addEventListener() {}, activeElement: null,
    },
    addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return { node, handle: context.wink.handle, sockets, requests, timeouts, replacedUrl: () => replacedUrl };
}
const memory = (id: string) => ({ id, title: 'Book ' + id, createdAt: '2026-10-26T19:00:00Z', imageUrl: 'http://localhost:8787/v1/images/' + id, objects: [], summary: 'A book', visibleText: '' });

test('TV clears preview and pointer on privacy pause and ignores subsequent frames', async () => {
  const tv = dashboard();
  await flush();
  tv.handle({ type: 'frame', jpegBase64: '/9j/AAAA' });
  tv.handle({ type: 'pointer', x: .5, y: .5, pinching: false });
  assert.equal(tv.node('pov').classList.contains('on'), true);
  tv.handle({ type: 'status', state: 'paused' });
  assert.equal(tv.node('pov').classList.contains('on'), false);
  assert.equal(tv.node('povImg').src, '');
  assert.equal(tv.node('cursor').classList.contains('on'), false);
  tv.handle({ type: 'frame', jpegBase64: '/9j/AAAA' });
  assert.equal(tv.node('povImg').src, '');
  tv.handle({ type: 'status', state: 'idle' });
  tv.handle({ type: 'frame', jpegBase64: '/9j/AAAA' });
  assert.equal(tv.node('pov').classList.contains('on'), true);
});

test('TV keeps credentials on its origin and removes token from visible URL', async () => {
  const tv = dashboard(undefined, '?token=test-token&api=https://untrusted.example');
  await flush();
  assert.ok(tv.requests.length >= 2);
  assert.ok(tv.requests.every(({ url }) => url.startsWith('http://localhost:8787/')));
  assert.equal(tv.requests[0]!.options.headers.Authorization, 'Bearer test-token');
  assert.ok(!tv.replacedUrl().includes('test-token'));
});

test('TV reports authentication failure before a WebSocket opens', async () => {
  const tv = dashboard(async () => new Response('{}', { status: 401 }));
  await flush();
  assert.match(tv.node('banner').textContent, /Wrong or missing token/);
});

test('TV preserves save and delete events received during initial synchronization', async () => {
  let resolveList!: (value: Response) => void;
  const tv = dashboard((url) => url.endsWith('/health') ? Promise.resolve(new Response('{"mock":true}')) : new Promise((resolve) => { resolveList = resolve; }));
  tv.handle({ type: 'memory.saved', memory: memory('new') });
  tv.handle({ type: 'memory.deleted', id: 'old' });
  resolveList(new Response(JSON.stringify({ memories: [memory('old')] })));
  await flush();
  assert.equal(tv.node('count').textContent, '1 memory');
  assert.ok(tv.node('grid').querySelector('.card[data-id="new"]'));
  assert.equal(tv.node('grid').querySelector('.card[data-id="old"]'), null);
});

test('TV keeps a memory visible when its deletion fails', async () => {
  const tv = dashboard(async (_url, options) => options?.method === 'DELETE' ? new Response('{"error":{"message":"Storage unavailable"}}', { status: 503 }) : new Response('{"memories":[]}'));
  await flush();
  tv.handle({ type: 'memory.saved', memory: memory('keep') });
  tv.node('grid').querySelector('.card[data-id="keep"]')!.events.click!();
  await tv.node('mDelete').events.click!();
  await flush();
  assert.equal(tv.node('count').textContent, '1 memory');
  assert.equal(tv.node('modal').classList.contains('on'), true);
  assert.match(tv.node('banner').textContent, /Storage unavailable/);
});
