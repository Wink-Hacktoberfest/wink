import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { HttpError, providerFetch, readJson, readUpload } from '../src/http.ts';

afterEach(() => mock.restoreAll());
const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;

test('JSON limit counts UTF-8 bytes even without Content-Length', async () => {
  const request = new Request('https://wink/v1/events', { method: 'POST', body: JSON.stringify({ text: 'é'.repeat(10) }) });
  await assert.rejects(readJson(request, 25), hasCode('payload_too_large'));
});

test('uploads reject non-JPEG and non-object file metadata', async () => {
  const form = new FormData();
  form.set('image', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'fake.jpg');
  await assert.rejects(readUpload(new Request('https://wink', { method: 'POST', body: form })), hasCode('invalid_image'));
  form.set('image', new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }), 'real.jpg');
  form.set('meta', new Blob(['[]'], { type: 'application/json' }));
  await assert.rejects(readUpload(new Request('https://wink', { method: 'POST', body: form })), hasCode('invalid_meta'));
});

test('provider deadline includes a stalled response body', async () => {
  let signal: AbortSignal | undefined;
  mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Response(new ReadableStream({ start(controller) {
      signal!.addEventListener('abort', () => controller.error(new Error('aborted')));
    } }));
  });
  await assert.rejects(providerFetch('https://provider.example', {}, 10, 'Provider'), hasCode('provider_timeout'));
  assert.equal(signal?.aborted, true);
});

test('provider redirects are returned without following them', async () => {
  const transport = mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(init.redirect, 'manual');
    return new Response('redirect', { status: 302, headers: { Location: 'https://elsewhere.example' } });
  });
  assert.equal((await providerFetch('https://provider.example', {}, 100, 'Provider')).status, 302);
  assert.equal(transport.mock.callCount(), 1);
});
