import { CORS_HEADERS, HttpError, errorResponse } from './http.ts';
import { connectLive } from './live.ts';
import { isMock } from './parse.ts';
import { ask } from './routes/ask.ts';
import type { RouteContext } from './routes/context.ts';
import { glance } from './routes/glance.ts';
import { createMemory, getMemories, removeMemory } from './routes/memories.ts';
import { events, health, image } from './routes/misc.ts';
import { nearby } from './routes/nearby.ts';
import type { Env, ExecutionContext } from './types.ts';

export { LiveRoom } from './live.ts';

type Handler = (context: RouteContext) => Promise<Response>;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler; auth: 'header' | 'none' | 'query' };

function route(method: string, path: string, handler: Handler, auth: Route['auth'] = 'header'): Route {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, key: string) => { keys.push(key); return '([^/]+)'; })}$`);
  return { method, pattern, keys, handler, auth };
}

async function live({ request, env, url }: RouteContext): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'upgrade_required', 'Connect with a WebSocket.');
  }
  const role = url.searchParams.get('role') ?? 'tv';
  if (role !== 'tv' && role !== 'glasses') throw new HttpError(400, 'invalid_role', 'role must be tv or glasses.');
  return connectLive(env, request, role);
}

const ROUTES: Route[] = [
  route('GET', '/v1/health', health, 'none'),
  route('POST', '/v1/memories', createMemory),
  route('GET', '/v1/memories', getMemories),
  route('DELETE', '/v1/memories/:id', removeMemory),
  route('POST', '/v1/glance', glance),
  route('POST', '/v1/ask', ask),
  route('POST', '/v1/nearby', nearby),
  route('POST', '/v1/events', events),
  route('GET', '/v1/images/:key', image, 'none'),
  route('GET', '/v1/live', live, 'query'),
];

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function authorize(request: Request, env: Env, url: URL, mode: Route['auth']): Promise<void> {
  if (mode === 'none') return;
  const expected = env.WINK_TOKEN?.trim();
  if (!expected) {
    if (isMock(env)) return; // zero-setup MOCK mode: open
    throw new HttpError(503, 'not_configured', 'WINK_TOKEN is not set.');
  }
  const header = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim();
  const actual = header ?? (mode === 'query' ? url.searchParams.get('token') ?? '' : '');
  const [left, right] = await Promise.all([digest(expected), digest(actual)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  if (!actual || difference !== 0) throw new HttpError(401, 'unauthorized', 'A valid Wink token is required.');
}

function withCors(response: Response): Response {
  if (response.status === 101) return response; // WebSocket upgrades are immutable
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext | undefined, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const matching = ROUTES.filter((r) => r.pattern.test(url.pathname));
  if (!matching.length) throw new HttpError(404, 'not_found', 'Route not found.');
  const found = matching.find((r) => r.method === request.method);
  if (!found) throw new HttpError(405, 'method_not_allowed', `Use ${matching.map((r) => r.method).join(' or ')}.`);
  await authorize(request, env, url, found.auth);
  const match = found.pattern.exec(url.pathname)!;
  const params: Record<string, string> = {};
  try {
    found.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1] ?? ''); });
  } catch {
    throw new HttpError(400, 'invalid_path', 'The request path is not valid.');
  }
  return found.handler({ request, env, ctx, url, params });
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v1/')) {
      try {
        return withCors(await handleApi(request, env, ctx, url));
      } catch (error) {
        if (!(error instanceof HttpError)) {
          console.error(`unhandled ${request.method} ${url.pathname}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
        const safe = error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'Something went wrong.');
        const response = errorResponse(safe.status, safe.code, safe.message);
        if (safe.status === 401) response.headers.set('WWW-Authenticate', 'Bearer');
        return withCors(response);
      }
    }
    if (url.pathname === '/' || url.pathname === '/tv/') {
      return Response.redirect(`${url.origin}/tv${url.search}`, 302);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return errorResponse(404, 'not_found', 'Not found.');
  },
};
