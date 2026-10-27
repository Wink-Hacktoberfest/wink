import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chat, chatModel, describeImage, doChat, extractChatText, visionTarget } from '../src/inference.ts';
import { HttpError } from '../src/http.ts';
import type { Env } from '../src/types.ts';

const env = { DO_MODEL_ACCESS_KEY: 'test-key' } as Env;
const vision = { title: 'Project Hail Mary', summary: 'A book by Andy Weir.', visibleText: 'Andy Weir', objects: ['book'], businessName: null, productQuery: 'books' };
const completion = (content: unknown, extra = {}) => ({ choices: [{ message: { content }, ...extra }] });
const errorCode = (status: number, code: string) => (error: unknown) => error instanceof HttpError && error.status === status && error.code === code;

test('chat extracts only complete final text from provider formats', () => {
  assert.equal(extractChatText(completion('Saved.')), 'Saved.');
  assert.equal(extractChatText(completion([{ type: 'reasoning', text: 'Private thought' }, { type: 'text', text: 'A book.' }])), 'A book.');
  assert.equal(extractChatText(completion('<think>Thinking</think>A book.')), 'A book.');
  assert.equal(extractChatText(completion('<think>unfinished reasoning')), '');
  assert.equal(extractChatText(completion('<|start|>assistant<|channel|>analysis<|message|>Thought<|end|><|start|>assistant<|channel|>final<|message|>A book.<|fim_suffix|>')), 'A book.');
  assert.equal(extractChatText(completion('<|channel|>analysis<|message|>Thought')), '');
  assert.equal(extractChatText(completion('<|meta_sep|>analysis<|im_sep|>Thought<|meta_sep|>final<|im_sep|>A book.')), 'A book.');
  assert.equal(extractChatText(completion('Unfinished answer', { finish_reason: 'length' })), '');
  assert.equal(extractChatText({ choices: [{ message: { reasoning_content: 'Thought' } }] }), '');
});

test('DO chat retries unsupported reasoning without sending credentials outside provider', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://inference.do-ai.run/v1/chat/completions');
    assert.equal(init.redirect, 'manual');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-key');
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? Response.json({ error: 'Unsupported reasoning_effort' }, { status: 400 }) : Response.json(completion('A book.'));
  });
  assert.equal(await chat(env, 'System', 'Question'), 'A book.');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]!.reasoning_effort, 'low');
  assert.equal(bodies[1]!.reasoning_effort, undefined);
});

test('DO errors stay typed and do not expose response contents', async (t) => {
  for (const [status, expectedStatus, code] of [[429, 503, 'provider_busy'], [401, 502, 'provider_error'], [500, 502, 'provider_error'], [302, 502, 'provider_error']] as const) {
    t.mock.method(globalThis, 'fetch', async () => new Response('Sensitive upstream detail', { status }));
    await assert.rejects(doChat(env, 'model', []), (error: unknown) => errorCode(expectedStatus, code)(error) && !(error as Error).message.includes('Sensitive'));
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('invalid json'));
  await assert.rejects(doChat(env, 'model', []), errorCode(502, 'provider_error'));
  await assert.rejects(doChat({} as Env, 'model', []), errorCode(503, 'not_configured'));
});

test('vision selection honors explicit Workers AI preference', () => {
  assert.equal(visionTarget({ VISION_MODEL: 'vision-model' } as Env).provider, 'digitalocean');
  assert.equal(visionTarget({ VISION_MODEL: 'vision-model', VISION_PROVIDER: 'workers-ai' } as Env).provider, 'workers-ai');
  assert.equal(visionTarget({} as Env).model, '@cf/mistralai/mistral-small-3.1-24b-instruct');
});

test('DO vision sends the original crop and parses fenced JSON', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,AQID');
    return Response.json(completion('```json\n' + JSON.stringify(vision) + '\n```'));
  });
  assert.deepEqual(await describeImage({ ...env, VISION_MODEL: 'vision-model' }, new Uint8Array([1, 2, 3]), 'image/jpeg', null), vision);
});

test('Workers AI Mistral vision sends the crop as an image_url message', async () => {
  const aiEnv = { ...env, AI: { run: async (model: string, inputs: Record<string, unknown>) => {
    assert.equal(model, '@cf/mistralai/mistral-small-3.1-24b-instruct');
    const messages = inputs.messages as { content: unknown }[];
    assert.equal(inputs.prompt, undefined);
    assert.deepEqual((messages[1]!.content as unknown[])[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } });
    return completion('```json\n' + JSON.stringify(vision) + '\n```');
  } } } as Env;
  assert.deepEqual(await describeImage(aiEnv, new Uint8Array([1, 2, 3]), 'image/jpeg', 'a book'), vision);
});

test('Workers AI Llama 3.2 Vision uses prompt + image, and preserves the crop', async () => {
  const aiEnv = { ...env, WORKERS_AI_VISION_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct', AI: { run: async (_model: string, inputs: Record<string, unknown>) => {
    assert.equal(typeof inputs.prompt, 'string');
    assert.equal(inputs.messages, undefined);
    assert.deepEqual(inputs.image, [1, 2, 3]);
    return { response: JSON.stringify(vision) };
  } } } as Env;
  assert.deepEqual(await describeImage(aiEnv, new Uint8Array([1, 2, 3]), 'image/jpeg', 'a book'), vision);
});

test('DO failures and malformed vision output fall back to Workers AI', async (t) => {
  let calls = 0;
  const aiEnv = { ...env, VISION_MODEL: 'vision-model', AI: { run: async () => { calls++; return { response: JSON.stringify(vision) }; } } };
  for (const reply of [new Response('busy', { status: 429 }), Response.json(completion('not JSON')), Response.json(completion('{}'))]) {
    t.mock.method(globalThis, 'fetch', async () => reply);
    assert.deepEqual(await describeImage(aiEnv, new Uint8Array([1]), 'image/jpeg', null), vision);
  }
  assert.equal(calls, 3);
});

test('malformed Workers AI output fails instead of creating a bogus memory', async () => {
  const aiEnv = { ...env, AI: { run: async () => ({ response: 'upstream error' }) } } as Env;
  await assert.rejects(describeImage(aiEnv, new Uint8Array([1]), 'image/jpeg', null), errorCode(502, 'provider_error'));
});

test('license acceptance remains an account-owner setup action', async () => {
  let calls = 0;
  const aiEnv = { ...env, AI: { run: async () => { calls++; throw new Error('Please agree to license'); } } } as Env;
  await assert.rejects(describeImage(aiEnv, new Uint8Array([1]), 'image/jpeg', null), errorCode(503, 'not_configured'));
  assert.equal(calls, 1);
});

test('Workers AI calls time out even if the binding never resolves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const aiEnv = { ...env, AI: { run: () => new Promise<never>(() => {}) } };
  const result = assert.rejects(describeImage(aiEnv, new Uint8Array([1]), 'image/jpeg', null), errorCode(504, 'provider_timeout'));
  t.mock.timers.tick(25_000);
  await result;
});

test('vision failure without a fallback remains a typed provider error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(completion('This is not JSON.')));
  await assert.rejects(describeImage({ ...env, VISION_MODEL: 'vision-model' }, new Uint8Array([1]), 'image/jpeg', null), errorCode(502, 'provider_error'));
  await assert.rejects(describeImage(env, new Uint8Array([1]), 'image/jpeg', null), errorCode(503, 'not_configured'));
});

test('CHAT_PROVIDER=workers-ai runs gpt-oss on Workers AI and reads only the final answer', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('DigitalOcean must not be called'); });
  const seen: { model: string; inputs: Record<string, unknown> }[] = [];
  const aiEnv = { CHAT_PROVIDER: 'workers-ai', AI: { run: async (model: string, inputs: Record<string, unknown>) => {
    seen.push({ model, inputs });
    return { object: 'chat.completion', choices: [{ finish_reason: 'stop', message: { content: 'It was a book.', reasoning_content: 'Private thought' } }] };
  } } } as Env;
  assert.equal(chatModel(aiEnv), '@cf/openai/gpt-oss-120b');
  assert.equal(await chat(aiEnv, 'System', 'Question'), 'It was a book.');
  assert.equal(seen[0]!.model, '@cf/openai/gpt-oss-120b');
  assert.deepEqual(seen[0]!.inputs.reasoning, { effort: 'low' });
  assert.equal((seen[0]!.inputs.messages as unknown[]).length, 2);
});

test('Workers AI chat failures stay typed', async (t) => {
  const failing = { CHAT_PROVIDER: 'workers-ai', AI: { run: async (): Promise<unknown> => { throw new Error('upstream'); } } } as unknown as Env;
  await assert.rejects(chat(failing, 'System', 'Question'), errorCode(502, 'provider_error'));
  const truncated = { CHAT_PROVIDER: 'workers-ai', AI: { run: async (): Promise<unknown> => completion('Half an', { finish_reason: 'length' }) } } as unknown as Env;
  await assert.rejects(chat(truncated, 'System', 'Question'), errorCode(502, 'provider_error'));
  await assert.rejects(chat({ CHAT_PROVIDER: 'workers-ai' } as Env, 'System', 'Question'), errorCode(503, 'not_configured'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = { CHAT_PROVIDER: 'workers-ai', AI: { run: (): Promise<unknown> => new Promise<never>(() => {}) } } as unknown as Env;
  const result = assert.rejects(chat(hanging, 'System', 'Question'), errorCode(504, 'provider_timeout'));
  t.mock.timers.tick(25_000);
  await result;
});
