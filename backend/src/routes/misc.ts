import { chatModel, visionTarget } from '../inference.ts';
import { HttpError, isRecord, json, readJson } from '../http.ts';
import { broadcast } from '../live.ts';
import { sampleImageSvg } from '../mock.ts';
import { isMock } from '../parse.ts';
import type { LiveEvent } from '../types.ts';
import type { RouteContext } from './context.ts';

export async function health({ env }: RouteContext): Promise<Response> {
  return json({
    ok: true,
    mock: isMock(env),
    models: {
      chat: chatModel(env),
      vision: visionTarget(env).model,
      embed: env.EMBED_MODEL?.trim() || 'snowflake-arctic-embed-l-v2.0',
    },
  });
}

export async function image({ env, params }: RouteContext): Promise<Response> {
  const key = params.key ?? '';
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) throw new HttpError(404, 'not_found', 'Image not found.');
  const svg = sampleImageSvg(key);
  if (svg) {
    return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
  }
  const object = await env.IMAGES.get(key);
  if (!object) throw new HttpError(404, 'not_found', 'Image not found.');
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: object.httpEtag,
    },
  });
}

const STATES = ['idle', 'listening', 'thinking', 'speaking', 'paused'];
const GESTURES = ['point', 'frame', 'lasso', 'palm', 'thumbsUp', 'fingers', 'pinch', 'flick'];

/** Validates the subset of LiveEvent the phone may POST: status, transcript, gesture. */
export function parseClientEvent(body: Record<string, unknown>): LiveEvent {
  if (body.type === 'status' && STATES.includes(body.state as string)) {
    return typeof body.text === 'string'
      ? { type: 'status', state: body.state as never, text: body.text.slice(0, 500) }
      : { type: 'status', state: body.state as never };
  }
  if (body.type === 'transcript' && typeof body.text === 'string') {
    return { type: 'transcript', text: body.text.slice(0, 1000) };
  }
  if (body.type === 'gesture' && GESTURES.includes(body.gesture as string)) {
    const event: LiveEvent = { type: 'gesture', gesture: body.gesture as never };
    if (typeof body.value === 'number') event.value = body.value;
    if (isRecord(body.box)) event.box = body.box as never;
    return event;
  }
  throw new HttpError(400, 'invalid_event', 'Send a status, transcript or gesture event.');
}

export async function events({ request, env }: RouteContext): Promise<Response> {
  const event = parseClientEvent(await readJson(request));
  await broadcast(env, event, 'tv');
  return new Response(null, { status: 202 });
}
