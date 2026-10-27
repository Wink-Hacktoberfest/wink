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

/** Read streams with a byte limit, including requests without Content-Length. */
export async function readBytes(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new HttpError(413, 'payload_too_large', 'The request is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function requestBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > maxBytes) throw new HttpError(413, 'payload_too_large', 'The request is too large.');
  try {
    return await readBytes(request.body, maxBytes);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_request', 'The request body could not be read.');
  }
}

export async function readJson(request: Request, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await requestBytes(request, maxBytes));
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
  } catch { /* fall through */ }
  throw new HttpError(400, 'invalid_json', 'A valid JSON object is required.');
}

export type UploadForm = { image: Uint8Array; contentType: string; meta: Record<string, unknown> };

/** Parses the contract's JPEG + meta upload without buffering an unlimited multipart body. */
export async function readUpload(request: Request, maxBytes = 10 * 1024 * 1024): Promise<UploadForm> {
  const bytes = await requestBytes(request, maxBytes);
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: request.headers }).formData();
  } catch {
    throw new HttpError(400, 'invalid_request', 'Send multipart/form-data with image and meta fields.');
  }
  const file = form.get('image');
  if (!file || typeof file === 'string' || file.size === 0) {
    throw new HttpError(400, 'missing_image', 'The image field must contain a nonempty JPEG.');
  }
  const image = new Uint8Array(await file.arrayBuffer());
  if ((file.type && file.type !== 'image/jpeg' && file.type !== 'application/octet-stream') ||
      image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
    throw new HttpError(415, 'invalid_image', 'Send a JPEG image.');
  }
  let meta: Record<string, unknown> = {};
  const rawMeta = form.get('meta');
  const metaText = typeof rawMeta === 'string' ? rawMeta : rawMeta ? await rawMeta.text() : '';
  if (new TextEncoder().encode(metaText).byteLength > 32 * 1024) {
    throw new HttpError(413, 'payload_too_large', 'Image metadata is too large.');
  }
  if (metaText.trim()) {
    try {
      const parsed: unknown = JSON.parse(metaText);
      if (!isRecord(parsed)) throw new Error('not an object');
      meta = parsed;
    } catch {
      throw new HttpError(400, 'invalid_meta', 'meta must be a JSON object string.');
    }
  }
  return { image, contentType: 'image/jpeg', meta };
}

/** The deadline covers both headers and body; redirects never receive provider credentials. */
export async function providerFetch(url: string, init: RequestInit, timeoutMs: number,
  label: string): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
        const bytes = await readBytes(response.body, 16 * 1024 * 1024);
        return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
          status: response.status, statusText: response.statusText, headers: response.headers,
        });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new HttpError(504, 'provider_timeout', `${label} timed out.`));
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw new HttpError(504, 'provider_timeout', `${label} timed out.`);
    if (error instanceof HttpError && error.code === 'payload_too_large') {
      throw new HttpError(502, 'provider_response', `${label} returned too much data.`);
    }
    throw new HttpError(502, 'provider_error', `${label} could not be reached.`);
  } finally {
    if (timer) clearTimeout(timer);
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
