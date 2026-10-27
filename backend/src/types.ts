/** Contract types: mirror docs/api.md exactly. */
export type Location = { lat: number; lng: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Selection = { mode: 'full' | 'point' | 'frame' | 'lasso'; box: Box | null };

export type Place = {
  id: string;
  name: string;
  category: string;
  address: string | null;
  phone: string | null;
  lat: number;
  lng: number;
  distanceMeters: number | null;
};

export type Memory = {
  id: string;
  createdAt: string;
  kind: 'explicit' | 'passive';
  title: string;
  summary: string;
  visibleText: string;
  objects: string[];
  note: string | null;
  imageUrl: string;
  selection: Selection;
  location: Location | null;
  place: Place | null;
};

export type GestureName = 'point' | 'frame' | 'lasso' | 'palm' | 'thumbsUp' | 'fingers' | 'pinch' | 'flick';

export type LiveEvent =
  | { type: 'status'; state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused'; text?: string }
  | { type: 'transcript'; text: string }
  | { type: 'gesture'; gesture: GestureName; value?: number; box?: Box }
  | { type: 'pointer'; x: number; y: number; pinching: boolean }
  | { type: 'frame'; jpegBase64: string }
  | { type: 'memory.saved'; memory: Memory }
  | { type: 'memory.deleted'; id: string }
  | { type: 'glance'; speech: string; title: string; objects: string[] }
  | { type: 'answer'; question: string; speech: string; memories: Memory[] }
  | { type: 'nearby'; speech: string; places: Place[] };

/** What the vision model extracts from one image. */
export type VisionResult = {
  title: string;
  summary: string;
  visibleText: string;
  objects: string[];
  businessName: string | null;
  productQuery: string | null;
};

/** A stored memory row before the request-specific image URL is attached. */
export type StoredMemory = Omit<Memory, 'imageUrl'> & { imageKey: string; productQuery?: string | null };

// Minimal Cloudflare binding shapes (the team convention is hand-written types, no workers-types).
export interface R2ObjectBody {
  body: ReadableStream<Uint8Array>;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
}
export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
}
export interface DurableObjectId { toString(): string }
export interface DurableObjectStub { fetch(input: Request | string, init?: RequestInit): Promise<Response> }
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
export interface Ai { run(model: string, inputs: Record<string, unknown>): Promise<unknown> }
export interface Fetcher { fetch(input: Request | string, init?: RequestInit): Promise<Response> }
export interface ExecutionContext { waitUntil(promise: Promise<unknown>): void }

export interface Env {
  IMAGES: R2Bucket;
  LIVE: DurableObjectNamespace;
  AI?: Ai;
  ASSETS?: Fetcher;
  MOCK?: string;
  CHAT_PROVIDER?: string;
  CHAT_MODEL?: string;
  WORKERS_AI_CHAT_MODEL?: string;
  VISION_PROVIDER?: string;
  VISION_MODEL?: string;
  WORKERS_AI_VISION_MODEL?: string;
  EMBED_MODEL?: string;
  SNOWFLAKE_ACCOUNT_URL?: string;
  SNOWFLAKE_WAREHOUSE?: string;
  SNOWFLAKE_DATABASE?: string;
  SNOWFLAKE_SCHEMA?: string;
  SNOWFLAKE_ROLE?: string;
  OVERTURE_PLACES_TABLE?: string;
  DEMO_LAT?: string;
  DEMO_LNG?: string;
  WINK_TOKEN?: string;
  DO_MODEL_ACCESS_KEY?: string;
  SNOWFLAKE_PAT?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ELEVENLABS_MODEL?: string;
  AURA_SPEAKER?: string;
}
