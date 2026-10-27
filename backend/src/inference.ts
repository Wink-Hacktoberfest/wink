import { HttpError, bytesToBase64, isRecord, providerFetch } from './http.ts';
import { extractJsonObject, parseVisionJson } from './parse.ts';
import { VISION_SYSTEM, visionUserPrompt } from './prompts.ts';
import type { Env, VisionResult } from './types.ts';

const DO_CHAT_URL = 'https://inference.do-ai.run/v1/chat/completions';
const WORKERS_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] };

export function chatModel(env: Env): string {
  return env.CHAT_MODEL?.trim() || 'openai-gpt-oss-120b';
}

/** Preferred vision target; Workers AI also serves as the failure fallback when bound. */
export function visionTarget(env: Env): { provider: 'digitalocean' | 'workers-ai'; model: string } {
  const provider = env.VISION_PROVIDER?.trim().toLowerCase();
  const doModel = env.VISION_MODEL?.trim();
  if (provider !== 'workers-ai' && doModel) return { provider: 'digitalocean', model: doModel };
  return { provider: 'workers-ai', model: env.WORKERS_AI_VISION_MODEL?.trim() || WORKERS_VISION_MODEL };
}

/** Read only final answer text; never turn reasoning-only or truncated output into spoken answers. */
export function extractChatText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.choices)) return '';
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return '';
  if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') return '';
  const message = choice.message;
  let content = '';
  if (typeof message.content === 'string') content = message.content;
  else if (Array.isArray(message.content)) {
    content = message.content.map((p) => (
      isRecord(p) && (p.type === 'text' || p.type === 'output_text' || p.type === undefined)
      && typeof p.text === 'string' ? p.text : ''
    )).join(' ');
  }
  const finalMarker = /<\|(?:channel|meta_sep)\|>final<\|(?:message|im_sep)\|>/g;
  const finalMatches = [...content.matchAll(finalMarker)];
  const lastFinal = finalMatches.at(-1);
  if (lastFinal) content = content.slice(lastFinal.index! + lastFinal[0].length);
  else if (/<\|(?:channel|meta_sep)\|>(?:analysis|commentary)/.test(content)) return '';
  return content
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<analysis>[\s\S]*?(?:<\/analysis>|$)/gi, '')
    .replace(/<\|[^|]*\|>/g, '')
    .trim();
}

async function doChatRequest(env: Env, body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
  const key = env.DO_MODEL_ACCESS_KEY?.trim();
  if (!key) throw new HttpError(503, 'not_configured', 'DO_MODEL_ACCESS_KEY is not set.');
  if (timeoutMs <= 0) throw new HttpError(504, 'provider_timeout', 'DigitalOcean inference timed out.');
  return providerFetch(DO_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs, 'DigitalOcean inference');
}

/** OpenAI-compatible chat on DigitalOcean Gradient serverless inference. */
export async function doChat(env: Env, model: string, messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number; reasoning?: boolean; timeoutMs?: number } = {}): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? 25_000);
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    max_tokens: options.maxTokens ?? 700,
    temperature: options.temperature ?? 0.3,
  };
  if (options.reasoning) body.reasoning_effort = 'low';
  let response = await doChatRequest(env, body, deadline - Date.now());
  if (response.status === 400 && options.reasoning) {
    // Some model deployments reject reasoning_effort. Retry only within the original deadline.
    await response.body?.cancel();
    delete body.reasoning_effort;
    response = await doChatRequest(env, body, deadline - Date.now());
  }
  if (!response.ok) {
    await response.body?.cancel();
    console.error(`DigitalOcean inference failed with HTTP ${response.status}.`);
    if (response.status === 429) throw new HttpError(503, 'provider_busy', 'The model is busy. Try again.');
    throw new HttpError(502, 'provider_error', 'The model could not complete the request.');
  }
  const text = extractChatText(await response.json().catch(() => null));
  if (!text) throw new HttpError(502, 'provider_error', 'The model did not return a complete reply.');
  return text;
}

/** Low effort keeps gpt-oss fast while leaving token space for its reasoning. */
export function chat(env: Env, system: string, user: string, maxTokens = 700): Promise<string> {
  return doChat(env, chatModel(env), [{ role: 'system', content: system }, { role: 'user', content: user }],
    { maxTokens, temperature: 0.3, reasoning: true });
}

/** Fail the request instead of storing provider errors, refusals, or broken JSON as a memory. */
function visionResult(raw: unknown): VisionResult {
  const obj = typeof raw === 'string' ? extractJsonObject(raw) : isRecord(raw) ? raw : null;
  const hasDescription = obj && ['title', 'name', 'label', 'summary', 'description', 'caption'].some(
    (key) => typeof obj[key] === 'string' && (obj[key] as string).trim().length > 0,
  );
  if (!hasDescription) throw new HttpError(502, 'provider_error', 'The vision model did not return an image description.');
  return parseVisionJson(obj);
}

async function workersAiVision(env: Env, model: string, image: Uint8Array, prompt: string): Promise<VisionResult> {
  if (!env.AI) throw new HttpError(503, 'not_configured', 'The Workers AI binding is missing.');
  // The image-input schema uses prompt + image, unlike the model's text-only chat schema.
  const inputs = { prompt: `${VISION_SYSTEM}\n\n${prompt}`, image: Array.from(image), max_tokens: 700, temperature: 0.2 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      env.AI.run(model, inputs),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HttpError(504, 'provider_timeout', 'Workers AI vision timed out.')), 25_000);
      }),
    ]);
    return visionResult(isRecord(result) && 'response' in result ? result.response : result);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/agree|licen[cs]e/i.test(detail)) {
      // Account owner must accept the license during setup; inference never changes account terms.
      throw new HttpError(503, 'not_configured', 'The account owner must accept the Workers AI vision model license.');
    }
    console.error('Workers AI vision failed.');
    throw new HttpError(502, 'provider_error', 'The vision model could not read the image.');
  } finally {
    clearTimeout(timer);
  }
}

/** Image → structured description; preserve the phone's crop and fall back on provider failure. */
export async function describeImage(env: Env, image: Uint8Array, contentType: string,
  hint: string | null): Promise<VisionResult> {
  const target = visionTarget(env);
  const prompt = visionUserPrompt(hint);
  if (target.provider === 'workers-ai') return workersAiVision(env, target.model, image, prompt);
  const dataUrl = `data:${contentType.startsWith('image/') ? contentType : 'image/jpeg'};base64,${bytesToBase64(image)}`;
  try {
    const text = await doChat(env, target.model, [
      { role: 'system', content: VISION_SYSTEM },
      { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ], { maxTokens: 700, temperature: 0.2, timeoutMs: 25_000 });
    return visionResult(text);
  } catch (error) {
    if (!env.AI) throw error;
    console.warn('DigitalOcean vision unavailable; using Workers AI.');
    return workersAiVision(env, env.WORKERS_AI_VISION_MODEL?.trim() || WORKERS_VISION_MODEL, image, prompt);
  }
}
