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
  private text = '';
  get textContent() { return this.text; }
  set textContent(value: string) { this.text = value; this.children = []; }
  get lastChild() { return this.children.at(-1); }
  value = '';
  onFocus?: () => void;
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
  closest(selector: string): Element | null {
    if (selector.startsWith('.') && this.classList.contains(selector.slice(1))) return this;
    return this.parent?.closest(selector) || null;
  }
  focus() { this.onFocus?.(); }
  scrollTo() {}
  scrollIntoView() {}
}
const source = readFileSync(new URL('../public/tv/app.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function dashboard(fetcher: (url: string, options?: any) => Promise<unknown> = async (url) => new Response(JSON.stringify(url.endsWith('/health') ? { mock: true } : { memories: [] })), search = '') {
  const nodes = new Map<string, Element>();
  let activeElement: Element | null = null;
  let pointerTarget: Element | null = null;
  const node = (id: string) => {
    if (!nodes.has(id)) {
      const element = new Element();
      element.onFocus = () => { activeElement = element; };
      nodes.set(id, element);
    }
    return nodes.get(id)!;
  };
  const panels = ['answer', 'livePanel', 'nearbyPanel'].map((panel, index) => {
    const button = node(['tabAnswer', 'tabLive', 'tabNearby'][index]!);
    button.dataset.panel = panel;
    return button;
  });
  const filters = ['all', 'today'].map((filter) => {
    const button = node('filter-' + filter);
    button.dataset.filter = filter;
    return button;
  });
  const navigation = ['memories', 'livePanel', 'nearbyPanel'].map((target) => {
    const button = node('nav-' + target);
    button.dataset.nav = target;
    return button;
  });
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
      querySelectorAll: (selector: string) => ({ '[data-panel]': panels, '[data-filter]': filters, '[data-nav]': navigation }[selector] || []),
      elementFromPoint: () => pointerTarget, addEventListener() {}, get activeElement() { return activeElement; },
    },
    addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return { node, handle: context.wink.handle, sockets, requests, timeouts, replacedUrl: () => replacedUrl, activeElement: () => activeElement, pointAt: (element: Element | null) => { pointerTarget = element; } };
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

test('TV combines text search with Today filtering and restores all memories', async () => {
  const tv = dashboard();
  await flush();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  tv.handle({ type: 'memory.saved', memory: { ...memory('today'), createdAt: today.toISOString(), visibleText: 'Botanical gardens' } });
  tv.handle({ type: 'memory.saved', memory: { ...memory('old'), createdAt: yesterday.toISOString(), summary: 'A botanical guide' } });
  tv.handle({ type: 'memory.saved', memory: { ...memory('other'), createdAt: today.toISOString() } });
  tv.node('memorySearch').events.input!({ target: { value: '  BOTANICAL  ' } });
  assert.ok(tv.node('grid').querySelector('.card[data-id="today"]'));
  assert.ok(tv.node('grid').querySelector('.card[data-id="old"]'));
  assert.equal(tv.node('grid').querySelector('.card[data-id="other"]'), null);
  tv.node('filter-today').events.click!();
  assert.ok(tv.node('grid').querySelector('.card[data-id="today"]'));
  assert.equal(tv.node('grid').querySelector('.card[data-id="old"]'), null);
  assert.equal(tv.node('filter-today').attributes['aria-pressed'], 'true');
  assert.equal(tv.node('filter-all').attributes['aria-pressed'], 'false');
  tv.node('memorySearch').events.input!({ target: { value: 'no match' } });
  assert.match(tv.node('grid').querySelector('.empty-wall')!.textContent, /No moments match/);
  tv.node('memorySearch').events.input!({ target: { value: '' } });
  tv.node('filter-all').events.click!();
  assert.equal(tv.node('grid').children.length, 3);
  assert.equal(tv.node('grid').querySelector('.empty-wall'), null);
});

test('TV applies active filters to live saves without duplicating an updated memory', async () => {
  const tv = dashboard();
  await flush();
  tv.node('memorySearch').events.input!({ target: { value: 'garden' } });
  tv.handle({ type: 'memory.saved', memory: memory('hidden') });
  assert.equal(tv.node('grid').querySelector('.card[data-id="hidden"]'), null);
  const match = { ...memory('match'), note: 'Garden ideas' };
  tv.handle({ type: 'memory.saved', memory: match });
  tv.handle({ type: 'memory.saved', memory: { ...match, title: 'Updated book' } });
  assert.equal(tv.node('grid').children.length, 1);
  assert.ok(tv.node('grid').querySelector('.card[data-id="match"]'));
  tv.node('memorySearch').events.input!({ target: { value: '' } });
  assert.equal(tv.node('grid').children.length, 2);
  assert.equal(tv.node('count').textContent, '2 memories');
});

test('TV cannot flick-delete a stale pointer target after filtering the memory wall', async () => {
  const tv = dashboard();
  await flush();
  tv.handle({ type: 'memory.saved', memory: memory('hidden') });
  tv.handle({ type: 'memory.saved', memory: memory('visible') });
  const oldCard = tv.node('grid').querySelector('.card[data-id="hidden"]')!;
  tv.pointAt(oldCard);
  tv.handle({ type: 'pointer', x: .5, y: .5, pinching: false });
  assert.equal(oldCard.classList.contains('hover'), true);
  tv.node('memorySearch').events.input!({ target: { value: 'visible' } });
  assert.equal(tv.node('grid').querySelector('.card[data-id="hidden"]'), null);
  assert.equal(tv.node('cursor').classList.contains('on'), false);
  tv.handle({ type: 'gesture', gesture: 'flick' });
  assert.equal(tv.requests.filter(({ options }) => options?.method === 'DELETE').length, 0);

  // A fresh pointer update still permits the intended visible memory to be forgotten.
  const visibleCard = tv.node('grid').querySelector('.card[data-id="visible"]')!;
  tv.pointAt(visibleCard);
  tv.handle({ type: 'pointer', x: .5, y: .5, pinching: false });
  assert.equal(visibleCard.classList.contains('hover'), true);
  tv.handle({ type: 'gesture', gesture: 'flick' });
  const deletes = tv.requests.filter(({ options }) => options?.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0]!.url, 'http://localhost:8787/v1/memories/visible');
  await flush();
});

test('TV submits one authenticated JSON question, shows its answer, and clears input on success', async () => {
  let resolveAnswer!: (response: Response) => void;
  const tv = dashboard(async (url) => {
    if (url.endsWith('/ask')) return new Promise<Response>((resolve) => { resolveAnswer = resolve; });
    return new Response(JSON.stringify(url.endsWith('/health') ? { mock: true } : { memories: [] }));
  }, '?token=test-token');
  await flush();
  tv.node('askInput').value = '  What was that book?  ';
  const pending = tv.node('askForm').events.submit!({ preventDefault() {} });
  assert.equal(tv.node('askSubmit').disabled, true);
  assert.equal(tv.node('askForm').attributes['aria-busy'], 'true');
  await tv.node('askForm').events.submit!({ preventDefault() {} });
  const asks = tv.requests.filter(({ url }) => url.endsWith('/ask'));
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.options.method, 'POST');
  assert.equal(asks[0]!.options.headers['Content-Type'], 'application/json');
  assert.equal(asks[0]!.options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(asks[0]!.options.body), { question: 'What was that book?', location: null });
  resolveAnswer(new Response(JSON.stringify({ speech: 'You saved Book one.', memories: [memory('one')] })));
  await pending;
  assert.equal(tv.node('answerSpeech').textContent, 'You saved Book one.');
  assert.equal(tv.node('answerQ').textContent, '“What was that book?”');
  assert.equal(tv.node('askInput').value, '');
  assert.equal(tv.node('askSubmit').disabled, false);
  assert.equal(tv.node('askForm').attributes['aria-busy'], 'false');
  tv.node('answerThumbs').querySelector('.thumb[data-id="one"]')!.events.click!();
  assert.equal(tv.node('mTitle').textContent, 'Book one');
});

test('TV retains failed questions and re-enables submission for retry', async () => {
  for (const response of [
    new Response('{"error":{"message":"Provider unavailable"}}', { status: 503 }),
    new Response('{"speech":null,"memories":[]}'),
  ]) {
    const tv = dashboard(async (url) => url.endsWith('/ask') ? response : new Response('{"memories":[]}'));
    await flush();
    tv.node('askInput').value = 'Find my book';
    await tv.node('askForm').events.submit!({ preventDefault() {} });
    assert.equal(tv.node('askInput').value, 'Find my book');
    assert.equal(tv.node('askSubmit').disabled, false);
    assert.equal(tv.node('askForm').attributes['aria-busy'], 'false');
    assert.match(tv.node('askHint').textContent, /Could not find an answer/);
  }
});

test('TV companion tabs support arrow, Home, and End keys with one focusable selected tab', async () => {
  const tv = dashboard();
  await flush();
  let prevented = false;
  tv.node('tabAnswer').events.keydown!({ key: 'ArrowLeft', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(tv.activeElement(), tv.node('tabNearby'));
  assert.equal(tv.node('nearbyPanel').hidden, false);
  assert.equal(tv.node('answer').hidden, true);
  assert.equal(tv.node('tabNearby').attributes['aria-selected'], 'true');
  assert.equal(tv.node('tabNearby').attributes.tabindex, '0');
  assert.equal(tv.node('tabAnswer').attributes.tabindex, '-1');
  tv.node('tabNearby').events.keydown!({ key: 'Home', preventDefault() {} });
  assert.equal(tv.activeElement(), tv.node('tabAnswer'));
  tv.node('tabAnswer').events.keydown!({ key: 'End', preventDefault() {} });
  assert.equal(tv.activeElement(), tv.node('tabNearby'));
  tv.node('tabNearby').events.keydown!({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(tv.activeElement(), tv.node('tabAnswer'));
});

test('TV quick navigation activates the matching companion panel and moves focus to its section', async () => {
  const tv = dashboard();
  await flush();
  tv.node('nav-livePanel').events.click!();
  assert.equal(tv.node('livePanel').hidden, false);
  assert.equal(tv.node('answer').hidden, true);
  assert.equal(tv.activeElement(), tv.node('companion'));
  assert.equal(tv.node('nav-livePanel').attributes['aria-current'], 'location');
  tv.node('exploreMemories').events.click!();
  assert.equal(tv.activeElement(), tv.node('memoriesSection'));
  assert.equal(tv.node('nav-memories').attributes['aria-current'], 'location');
  assert.equal(tv.node('nav-livePanel').attributes['aria-current'], 'false');
});
