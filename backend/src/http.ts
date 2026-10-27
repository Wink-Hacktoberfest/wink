export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readJson(request: Request, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > maxBytes) throw new HttpError(413, 'payload_too_large', 'The request is too large.');
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, 'invalid_request', 'The request body could not be read.');
  }
  if (text.length > maxBytes) throw new HttpError(413, 'payload_too_large', 'The request is too large.');
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
  } catch { /* fall through */ }
  throw new HttpError(400, 'invalid_json', 'A valid JSON object is required.');
}

export type UploadForm = { image: Uint8Array; contentType: string; meta: Record<string, unknown> };

/** Parses the multipart `image` + `meta` upload used by /v1/memories and /v1/glance. */
export async function readUpload(request: Request, maxBytes = 10 * 1024 * 1024): Promise<UploadForm> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > maxBytes) throw new HttpError(413, 'payload_too_large', 'The image is too large.');
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'invalid_request', 'Send multipart/form-data with image and meta fields.');
  }
  const file = form.get('image');
  if (!file || typeof file === 'string') {
    throw new HttpError(400, 'missing_image', 'The image field is required.');
  }
  const image = new Uint8Array(await (file as Blob).arrayBuffer());
  if (image.byteLength === 0) throw new HttpError(400, 'missing_image', 'The image is empty.');
  if (image.byteLength > maxBytes) throw new HttpError(413, 'payload_too_large', 'The image is too large.');
  let meta: Record<string, unknown> = {};
  const rawMeta = form.get('meta');
  if (typeof rawMeta === 'string' && rawMeta.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawMeta);
      if (isRecord(parsed)) meta = parsed;
      else throw new Error('not an object');
    } catch {
      throw new HttpError(400, 'invalid_meta', 'meta must be a JSON object string.');
    }
  } else if (rawMeta && typeof rawMeta !== 'string') {
    try {
      const parsed: unknown = JSON.parse(await (rawMeta as Blob).text());
      if (isRecord(parsed)) meta = parsed;
    } catch {
      throw new HttpError(400, 'invalid_meta', 'meta must be a JSON object string.');
    }
  }
  return { image, contentType: (file as Blob).type || 'image/jpeg', meta };
}

/** Provider fetch with a timeout. Workers reject redirect: 'error', so use 'manual'. */
export async function providerFetch(url: string, init: RequestInit, timeoutMs: number,
  label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
  } catch (error) {
    if (controller.signal.aborted) throw new HttpError(504, 'provider_timeout', `${label} timed out.`);
    throw new HttpError(502, 'provider_error', `${label} could not be reached.`);
  } finally {
    clearTimeout(timer);
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
