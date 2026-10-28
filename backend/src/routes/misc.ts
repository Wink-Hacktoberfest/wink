import { chatModel, embedModel, visionTarget } from '../inference.ts';
import { HttpError, json, readJson } from '../http.ts';
import { broadcast } from '../live.ts';
import { sampleImageAsset, sampleImageSvg } from '../mock.ts';
import { isMock } from '../parse.ts';
import { parseClientEvent } from '../events.ts';
export { parseClientEvent } from '../events.ts';
import type { RouteContext } from './context.ts';

export async function health({ env }: RouteContext): Promise<Response> {
  return json({
    ok: true,
    mock: isMock(env),
    models: {
      chat: chatModel(env),
      vision: visionTarget(env).model,
      embed: embedModel(env),
    },
  });
}

export async function image({ env, params, url }: RouteContext): Promise<Response> {
  const key = params.key ?? '';
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) throw new HttpError(404, 'not_found', 'Image not found.');
  const asset = isMock(env) ? sampleImageAsset(key) : null;
  if (asset && env.ASSETS) {
    try {
      // Fetch only an allowlisted bundled asset, without forwarding tokens or query strings.
      const response = await env.ASSETS.fetch(new Request(new URL(asset, url.origin)));
      if (response.ok && response.headers.get('Content-Type')?.startsWith('image/webp')) {
        return new Response(response.body, { headers: {
          'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        } });
      }
    } catch { /* Keep the existing SVG fallback available without an asset binding. */ }
  }
  const svg = sampleImageSvg(key);
  if (svg) {
    return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
  }
  const object = await env.IMAGES.get(key);
  if (!object) throw new HttpError(404, 'not_found', 'Image not found.');
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ETag: object.httpEtag,
    },
  });
}

export async function events({ request, env }: RouteContext): Promise<Response> {
  const event = parseClientEvent(await readJson(request));
  await broadcast(env, event, 'tv');
  return new Response(null, { status: 202 });
}
