import { HttpError, bytesToBase64, isRecord, providerFetch } from './http.ts';
import { parseVisionJson } from './parse.ts';
import { VISION_SYSTEM, visionUserPrompt } from './prompts.ts';
import type { Env, VisionResult } from './types.ts';

const DO_CHAT_URL = 'https://inference.do-ai.run/v1/chat/completions';

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] };

export function chatModel(env: Env): string {
  return env.CHAT_MODEL?.trim() || 'openai-gpt-oss-120b';
}

/** Which provider/model actually handles vision. Empty VISION_MODEL falls back to Workers AI. */
export function visionTarget(env: Env): { provider: 'digitalocean' | 'workers-ai'; model: string } {
  const provider = env.VISION_PROVIDER?.trim().toLowerCase();
  const doModel = env.VISION_MODEL?.trim();
  if (provider !== 'workers-ai' && doModel) return { provider: 'digitalocean', model: doModel };
  return {
    provider: 'workers-ai',
    model: env.WORKERS_AI_VISION_MODEL?.trim() || '@cf/meta/llama-3.2-11b-vision-instruct',
  };
}

/** Pulls the final answer out of an OpenAI-style message, tolerating gpt-oss reasoning fields/tags. */
export function extractChatText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.choices)) return '';
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return '';
  const message = choice.message;
  let content = '';
  if (typeof message.content === 'string') content = message.content;
  else if (Array.isArray(message.content)) {
    content = message.content.map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : '')).join('');
  }
  // Harmony-format leakage: keep only the final channel.
  const finalMarker = content.lastIndexOf('<|channel|>final<|message|>');
  if (finalMarker !== -1) content = content.slice(finalMarker + '<|channel|>final<|message|>'.length);
  content = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|[^|]*\|>/g, '')
    .trim();
  return content;
}

async function doChatRequest(env: Env, body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
  const key = env.DO_MODEL_ACCESS_KEY?.trim();
  if (!key) throw new HttpError(503, 'not_configured', 'DO_MODEL_ACCESS_KEY is not set.');
  return providerFetch(DO_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs, 'DigitalOcean inference');
}

/** OpenAI-compatible chat on DigitalOcean Gradient serverless inference. */
export async function doChat(env: Env, model: string, messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number; reasoning?: boolean; timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: options.maxTokens ?? 700,
    temperature: options.temperature ?? 0.3,
  };
  if (options.reasoning) body.reasoning_effort = 'low';
  let response = await doChatRequest(env, body, timeoutMs);
  if (response.status === 400 && options.reasoning) {
    // Some deployments reject reasoning_effort; retry once without it.
    await response.body?.cancel();
    delete body.reasoning_effort;
    response = await doChatRequest(env, body, timeoutMs);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    console.error(`DO inference ${response.status} for ${model}: ${detail}`);
    if (response.status === 429) throw new HttpError(503, 'provider_busy', 'The model is busy. Try again.');
    throw new HttpError(502, 'provider_error', 'The model could not complete the request.');
  }
  const text = extractChatText(await response.json().catch(() => null));
  if (!text) throw new HttpError(502, 'provider_error', 'The model returned an empty reply.');
  return text;
}

/** gpt-oss for answers and speech. Low reasoning effort keeps it fast; a roomy token cap leaves space for reasoning. */
export function chat(env: Env, system: string, user: string, maxTokens = 700): Promise<string> {
  return doChat(env, chatModel(env), [{ role: 'system', content: system }, { role: 'user', content: user }],
    { maxTokens, temperature: 0.3, reasoning: true });
}

function aiErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function workersAiVision(env: Env, model: string, image: Uint8Array, prompt: string): Promise<unknown> {
  if (!env.AI) throw new HttpError(503, 'not_configured', 'The Workers AI binding is missing.');
  const inputs = {
    messages: [
      { role: 'system', content: VISION_SYSTEM },
      { role: 'user', content: prompt },
    ],
    image: Array.from(image),
    max_tokens: 512,
    temperature: 0.2,
  };
  let result: unknown;
  try {
    result = await env.AI.run(model, inputs);
  } catch (error) {
    // Meta's Llama 3.2 Vision on Workers AI needs a one-time "agree" to its license per account.
    if (/agree|licen[cs]e/i.test(aiErrorText(error))) {
      await env.AI.run(model, { prompt: 'agree' }).catch(() => undefined);
      result = await env.AI.run(model, inputs);
    } else {
      throw error;
    }
  }
  if (isRecord(result) && 'response' in result) return result.response;
  return result;
}

/** Image → structured description. Throws HttpError on provider failure. */
export async function describeImage(env: Env, image: Uint8Array, contentType: string,
  hint: string | null): Promise<VisionResult> {
  const target = visionTarget(env);
  const prompt = visionUserPrompt(hint);
  if (target.provider === 'workers-ai') {
    try {
      return parseVisionJson(await workersAiVision(env, target.model, image, prompt));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.error(`Workers AI vision failed: ${aiErrorText(error)}`);
      throw new HttpError(502, 'provider_error', 'The vision model could not read the image.');
    }
  }
  const dataUrl = `data:${contentType.startsWith('image/') ? contentType : 'image/jpeg'};base64,${bytesToBase64(image)}`;
  const text = await doChat(env, target.model, [
    { role: 'system', content: VISION_SYSTEM },
    { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] },
  ], { maxTokens: 600, temperature: 0.2, timeoutMs: 30_000 });
  return parseVisionJson(text);
}
