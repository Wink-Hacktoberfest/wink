import { describeImage } from '../inference.ts';
import { HttpError, json, readUpload } from '../http.ts';
import { broadcast, mockStore } from '../live.ts';
import { mockVision } from '../mock.ts';
import { isMock, optionalString, parseSelection, resolveLocation } from '../parse.ts';
import { backfillEmbeddings, deleteMemory, getMemory, insertMemory, listMemories, StoreRejectedError } from '../neon.ts';
import { matchBusiness } from '../snowflake.ts';
import { sanitizeSpeech } from '../speech.ts';
import type { Place, StoredMemory, VisionResult } from '../types.ts';
import { background, capitalize, toMemory, withTimeout, type RouteContext } from './context.ts';

function createdAtFrom(value: unknown): string {
  const now = Date.now();
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  // Trust the phone's clock unless it's clearly off.
  if (Number.isFinite(t) && t <= now + 5 * 60_000 && t >= now - 24 * 3600_000) return new Date(t).toISOString();
  return new Date(now).toISOString();
}

export function saveSpeech(title: string, note: string | null): string {
  const cleanTitle = title.replace(/[.!?\s]+$/, '');
  const cleanNote = note?.replace(/[.!?\s]+$/, '');
  return sanitizeSpeech(`Saved. ${cleanTitle}.${cleanNote ? ` ${capitalize(cleanNote)}.` : ''}`);
}

export async function createMemory({ request, env, ctx, url }: RouteContext): Promise<Response> {
  const { image, contentType, meta } = await readUpload(request);
  const mock = isMock(env);
  const id = crypto.randomUUID();
  let imageKey = `${crypto.randomUUID()}.jpg`;
  const note = optionalString(meta.note);
  const utterance = optionalString(meta.utterance);
  const location = resolveLocation(meta.location, env);
  const selection = parseSelection(meta.selection);
  const kind = meta.kind === 'passive' ? 'passive' : 'explicit';

  let vision: VisionResult;
  let place: Place | null = null;
  if (mock) {
    const canned = mockVision(note ?? utterance);
    vision = canned;
    try {
      await env.IMAGES.put(imageKey, image, { httpMetadata: { contentType: 'image/jpeg' } });
    } catch {
      imageKey = canned.sampleKey; // no R2 locally: show placeholder art instead
    }
  } else {
    const [, described] = await Promise.all([
      env.IMAGES.put(imageKey, image, { httpMetadata: { contentType: 'image/jpeg' } }).catch((error) => {
        console.error(`R2 put failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new HttpError(502, 'storage_error', 'The image could not be stored.');
      }),
      describeImage(env, image, contentType, note ?? utterance).catch((error): VisionResult => {
        // Still save (and still answer "Saved.") if the vision model is down.
        console.error(`vision failed, saving without a description: ${error instanceof Error ? error.message : String(error)}`);
        const title = note ? capitalize(note) : 'Saved photo';
        return { title, summary: title, visibleText: '', objects: [], businessName: null, productQuery: null };
      }),
    ]);
    vision = described;
    if (vision.businessName && location) {
      place = await withTimeout(matchBusiness(env, location, vision.businessName), 8000).catch((error) => {
        console.error(`Overture business match skipped: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    }
  }

  const stored: StoredMemory = {
    id,
    createdAt: createdAtFrom(meta.capturedAt),
    kind,
    title: vision.title,
    summary: vision.summary,
    visibleText: vision.visibleText,
    objects: vision.objects,
    note,
    imageKey,
    selection,
    location,
    place,
    productQuery: vision.productQuery,
  };
  try {
    if (mock) await mockStore(env, 'POST', '', stored);
    else await insertMemory(env, stored);
  } catch (error) {
    // A timeout/network failure may follow a committed INSERT: keep its image until reconciled.
    // Only discard images when Postgres explicitly rejected the statement, so nothing committed.
    const definiteFailure = error instanceof StoreRejectedError ||
      (error instanceof HttpError && error.code === 'not_configured');
    if (definiteFailure && !imageKey.startsWith('sample-')) {
      await env.IMAGES.delete(imageKey).catch(() => console.error('Failed to remove an uncommitted image.'));
    }
    throw error;
  }

  const memory = toMemory(stored, url.origin);
  const speech = saveSpeech(memory.title, note);
  await background(ctx, broadcast(env, { type: 'memory.saved', memory }));
  return json({ memory, speech }, 201);
}

export async function getMemories({ env, ctx, url }: RouteContext): Promise<Response> {
  const limit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get('limit') ?? '50')) || 50));
  const stored = isMock(env)
    ? (await mockStore<{ memories: StoredMemory[] }>(env, 'GET')).memories.slice(0, limit)
    : await listMemories(env, limit);
  if (!isMock(env)) {
    // Lists are frequent (app and TV start-up), so they quietly embed any rows still missing a vector.
    await background(ctx, backfillEmbeddings(env).catch((error) => {
      console.error(`embedding backfill skipped: ${error instanceof Error ? error.message : String(error)}`);
    }));
  }
  return json({ memories: stored.map((m) => toMemory(m, url.origin)) });
}

export async function removeMemory({ env, ctx, params }: RouteContext): Promise<Response> {
  const id = params.id ?? '';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new HttpError(400, 'invalid_id', 'That memory id is not valid.');
  const mock = isMock(env);
  const stored = mock
    ? (await mockStore<{ memory: StoredMemory | null }>(env, 'GET', id)).memory
    : await getMemory(env, id);
  // Delete the private image first. If R2 fails the row survives, so retry still knows its key.
  if (stored && !stored.imageKey.startsWith('sample-')) {
    try { await env.IMAGES.delete(stored.imageKey); }
    catch { throw new HttpError(502, 'storage_error', 'The image could not be deleted. Please try again.'); }
  }
  if (mock) await mockStore(env, 'DELETE', id);
  else await deleteMemory(env, id);
  await background(ctx, broadcast(env, { type: 'memory.deleted', id }));
  return new Response(null, { status: 204 });
}
