import { chat } from '../inference.ts';
import { HttpError, json, readJson } from '../http.ts';
import { broadcast, mockStore } from '../live.ts';
import { DEMO_FALLBACK_LOCATION, mockNearby } from '../mock.ts';
import { extractJsonObject, isMock, optionalString, resolveLocation } from '../parse.ts';
import { NEARBY_SYSTEM } from '../prompts.ts';
import { getMemory, NEARBY_RADIUS_METERS, nearbyPlaces } from '../snowflake.ts';
import { numberWord, sanitizeSpeech, spokenDistance } from '../speech.ts';
import type { Place, StoredMemory } from '../types.ts';
import { background, capitalize, type RouteContext } from './context.ts';

export type PlaceSearch = { label: string; categories: string[]; keywords: string[] };

const RULES: Array<[RegExp, PlaceSearch]> = [
  [/book|novel/i, { label: 'book stores', categories: ['book_store', 'used_bookstore'], keywords: ['books'] }],
  [/wine|malbec|merlot|beer|liquor|whisk|spirit/i, { label: 'wine shops', categories: ['liquor_store', 'wine_bar', 'wine_wholesaler'], keywords: ['wine', 'liquor'] }],
  [/coffee|espresso|latte/i, { label: 'coffee shops', categories: ['coffee_shop', 'cafe', 'coffee_roastery'], keywords: ['coffee'] }],
  [/shoe|sneaker|boot/i, { label: 'shoe stores', categories: ['shoe_store', 'sporting_goods'], keywords: ['shoe'] }],
  [/plant|flower|monstera/i, { label: 'plant shops', categories: ['florist', 'nursery_and_gardening', 'garden_center'], keywords: ['plant', 'flower'] }],
  [/medic|pill|vitamin|pharm/i, { label: 'pharmacies', categories: ['pharmacy', 'drugstore'], keywords: ['pharmacy'] }],
  [/phone|charger|cable|laptop|headphone|electronic/i, { label: 'electronics stores', categories: ['electronics_store', 'mobile_phone_store'], keywords: ['electronics'] }],
  [/shirt|jacket|dress|cloth|hoodie/i, { label: 'clothing stores', categories: ['clothing_store', 'fashion'], keywords: ['clothing'] }],
  [/snack|food|grocer|fruit|milk|bread/i, { label: 'grocery stores', categories: ['grocery_store', 'supermarket', 'convenience_store'], keywords: ['market'] }],
  [/key|tool|screw|paint/i, { label: 'hardware stores', categories: ['hardware_store', 'locksmith'], keywords: ['hardware'] }],
];

/** Offline keyword → Overture category mapping, used in MOCK mode and when gpt-oss is unavailable. */
export function fallbackSearch(query: string): PlaceSearch {
  const hit = RULES.find(([re]) => re.test(query));
  if (hit) return hit[1];
  const words = query.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return { label: 'places', categories: [], keywords: words.slice(0, 3) };
}

function cleanSearch(raw: Record<string, unknown> | null, fallback: PlaceSearch): PlaceSearch {
  if (!raw) return fallback;
  const list = (v: unknown) => Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];
  const categories = list(raw.categories).map((c) => c.toLowerCase().replace(/[^a-z0-9_]+/g, '_')).slice(0, 4);
  const keywords = list(raw.keywords).map((k) => k.replace(/[^\p{L}\p{N} '&-]+/gu, '')).filter(Boolean).slice(0, 3);
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 40) : fallback.label;
  if (!categories.length && !keywords.length) return fallback;
  return {
    label,
    categories: [...new Set([...categories, ...fallback.categories])].slice(0, 6),
    keywords: keywords.length ? keywords : fallback.keywords,
  };
}

export function nearbySpeech(label: string, places: Place[]): string {
  if (!places.length) return sanitizeSpeech(`I couldn't find any ${label} within ${NEARBY_RADIUS_METERS / 1000} kilometers.`);
  const closest = places[0]!;
  const distance = spokenDistance(closest.distanceMeters);
  const away = distance ? `, ${distance} away` : '';
  if (places.length === 1) return sanitizeSpeech(`I found one nearby: ${closest.name}${away}.`);
  return sanitizeSpeech(`${capitalize(numberWord(places.length))} ${label} nearby. The closest is ${closest.name}${away}.`);
}

export async function nearby({ request, env, ctx }: RouteContext): Promise<Response> {
  const body = await readJson(request);
  const mock = isMock(env);
  const memoryId = optionalString(body.memoryId, 64);
  let query = optionalString(body.query, 200);
  const location = resolveLocation(body.location, env) ?? (mock ? DEMO_FALLBACK_LOCATION : null);
  if (!location) throw new HttpError(400, 'missing_location', 'location is required.');

  let memory: StoredMemory | null = null;
  if (memoryId) {
    memory = mock
      ? (await mockStore<{ memory: StoredMemory | null }>(env, 'GET', memoryId)).memory
      : await getMemory(env, memoryId);
  }
  if (memoryId && !memory && !query) throw new HttpError(404, 'not_found', 'That memory was not found.');
  const memoryText = memory ? [memory.productQuery, memory.title, memory.objects.join(', ')].filter(Boolean).join('; ') : '';
  const need = [query, memoryText].filter(Boolean).join('; ');
  if (!need) throw new HttpError(400, 'missing_query', 'Send memoryId or query.');
  query = need;

  let label: string, places: Place[];
  if (mock) {
    ({ label, places } = mockNearby(query, location));
  } else {
    const fallback = fallbackSearch(query);
    const search = await chat(env, NEARBY_SYSTEM, `The wearer wants to buy or find: ${query}`, 500)
      .then((text) => cleanSearch(extractJsonObject(text), fallback))
      .catch((error) => {
        console.error(`nearby keyword step failed: ${error instanceof Error ? error.message : String(error)}`);
        return fallback;
      });
    label = search.label;
    places = await nearbyPlaces(env, location, search.categories, search.keywords);
  }
  const speech = nearbySpeech(label, places);
  await background(ctx, broadcast(env, { type: 'nearby', speech, places }));
  return json({ speech, places });
}
