import type { Env, ExecutionContext, Memory, StoredMemory } from '../types.ts';

export type RouteContext = {
  request: Request;
  env: Env;
  ctx: ExecutionContext | undefined;
  url: URL;
  params: Record<string, string>;
};

export function imageUrl(origin: string, key: string): string {
  return `${origin}/v1/images/${encodeURIComponent(key)}`;
}

/** Strips storage-only fields and attaches the absolute image URL for this request's host. */
export function toMemory(stored: StoredMemory, origin: string): Memory {
  const { imageKey, productQuery: _productQuery, ...rest } = stored;
  const memory = { ...rest, imageUrl: imageUrl(origin, imageKey) };
  delete (memory as { score?: number }).score;
  return memory;
}

/** Run side effects (broadcasts) after the response when the runtime allows it. */
export function background(ctx: ExecutionContext | undefined, work: Promise<unknown>): Promise<unknown> | undefined {
  if (ctx) {
    ctx.waitUntil(work);
    return undefined;
  }
  return work;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}
