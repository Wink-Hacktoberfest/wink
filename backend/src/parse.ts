import { isRecord } from './http.ts';
import type { Box, Env, Location, Selection, VisionResult } from './types.ts';

function str(value: unknown, max = 500): string {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function nullableStr(value: unknown, max = 200): string | null {
  const text = str(value, max);
  if (!text || /^(null|none|n\/a|unknown)$/i.test(text)) return null;
  return text;
}

/** Finds the first balanced {...} object in model output (handles ```json fences and chatter). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  for (let start = cleaned.indexOf('{'); start !== -1; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = cleaned.slice(start, i + 1);
          try {
            const value: unknown = JSON.parse(candidate);
            if (isRecord(value)) return value;
          } catch {
            try {
              // Common model slip: trailing commas.
              const value: unknown = JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
              if (isRecord(value)) return value;
            } catch { /* try the next opening brace */ }
          }
          break;
        }
      }
    }
  }
  return null;
}

/** Defensive parse of the vision model's strict-JSON reply. Never throws. */
export function parseVisionJson(raw: unknown): VisionResult {
  const obj = typeof raw === 'string' ? extractJsonObject(raw) : isRecord(raw) ? raw : null;
  const fallbackText = typeof raw === 'string' ? str(raw, 300) : '';
  if (!obj) {
    return {
      title: fallbackText ? fallbackText.split(/[.!?\n]/)[0]!.slice(0, 60) || 'Something you saw' : 'Something you saw',
      summary: fallbackText || 'A photo you saved.',
      visibleText: '',
      objects: [],
      businessName: null,
      productQuery: null,
    };
  }
  const pick = (...keys: string[]) => keys.map((k) => obj[k]).find((v) => v !== undefined && v !== null);
  let objects: string[] = [];
  const rawObjects = pick('objects', 'items', 'labels');
  if (Array.isArray(rawObjects)) objects = rawObjects.map((o) => str(o, 60)).filter(Boolean).slice(0, 12);
  else if (typeof rawObjects === 'string') objects = rawObjects.split(',').map((o) => str(o, 60)).filter(Boolean).slice(0, 12);
  const title = str(pick('title', 'name', 'label'), 80) || objects[0] || 'Something you saw';
  return {
    title,
    summary: str(pick('summary', 'description', 'caption'), 300) || title,
    visibleText: str(pick('visibleText', 'visible_text', 'text', 'ocr'), 1000),
    objects,
    businessName: nullableStr(pick('businessName', 'business_name', 'business')),
    productQuery: nullableStr(pick('productQuery', 'product_query', 'product')),
  };
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function parseLocation(value: unknown): Location | null {
  if (!isRecord(value)) return null;
  const lat = num(value.lat);
  const lng = num(value.lng ?? value.lon ?? value.longitude);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null; // "null island" means the phone had no fix
  return { lat, lng };
}

/** Phone location, else DEMO_LAT/DEMO_LNG, else null. */
export function resolveLocation(value: unknown, env: Env): Location | null {
  return parseLocation(value) ?? parseLocation({ lat: env.DEMO_LAT, lng: env.DEMO_LNG });
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function parseBox(value: unknown): Box | null {
  if (!isRecord(value)) return null;
  const x = num(value.x), y = num(value.y), w = num(value.w), h = num(value.h);
  if (x === null || y === null || w === null || h === null) return null;
  return { x: clamp01(x), y: clamp01(y), w: clamp01(w), h: clamp01(h) };
}

export function parseSelection(value: unknown): Selection {
  if (!isRecord(value)) return { mode: 'full', box: null };
  const mode = ['full', 'point', 'frame', 'lasso'].includes(value.mode as string)
    ? value.mode as Selection['mode'] : 'full';
  return { mode, box: mode === 'full' ? null : parseBox(value.box) };
}

export function optionalString(value: unknown, max = 500): string | null {
  return nullableStr(value, max);
}

export function isMock(env: Env): boolean {
  return (env.MOCK ?? 'true').trim().toLowerCase() !== 'false';
}
