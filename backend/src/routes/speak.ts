import { HttpError, providerFetch } from '../http.ts';
import { isMock } from '../parse.ts';
import { sanitizeSpeech } from '../speech.ts';
import type { RouteContext } from './context.ts';

const AURA_MODEL = '@cf/deepgram/aura-2-en';
const ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const AUDIO_HEADERS = { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' };

/** Text → MP3 for the glasses. ElevenLabs when a key is set, otherwise Deepgram Aura-2 on Workers AI. */
export async function speak({ request, env }: RouteContext): Promise<Response> {
  const body = await request.json().catch(() => null) as { text?: unknown } | null;
  const text = sanitizeSpeech(typeof body?.text === 'string' ? body.text : '').slice(0, 600);
  if (!text) throw new HttpError(400, 'bad_request', 'text is required.');
  // The phone falls back to its built-in voice on any error, so MOCK mode stays offline.
  if (isMock(env)) throw new HttpError(503, 'not_configured', 'Voice is off in MOCK mode.');

  const key = env.ELEVENLABS_API_KEY?.trim();
  if (key) {
    const voice = encodeURIComponent(env.ELEVENLABS_VOICE_ID?.trim() || ELEVENLABS_VOICE);
    const response = await providerFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: env.ELEVENLABS_MODEL?.trim() || 'eleven_flash_v2_5' }),
    }, 15_000, 'ElevenLabs').catch(() => null);
    if (response?.ok) return new Response(response.body, { headers: AUDIO_HEADERS });
    await response?.body?.cancel();
    console.warn(`ElevenLabs unavailable (HTTP ${response?.status ?? 'error'}); using Aura.`);
  }

  if (!env.AI) throw new HttpError(503, 'not_configured', 'The Workers AI binding is missing.');
  const audio = await env.AI.run(AURA_MODEL, { text, speaker: env.AURA_SPEAKER?.trim() || 'luna', encoding: 'mp3' })
    .catch(() => { throw new HttpError(502, 'provider_error', 'The voice model could not speak.'); });
  if (audio instanceof ReadableStream || audio instanceof ArrayBuffer || audio instanceof Uint8Array) {
    return new Response(audio as BodyInit, { headers: AUDIO_HEADERS });
  }
  if (audio && typeof audio === 'object' && typeof (audio as { audio?: unknown }).audio === 'string') {
    const bytes = Uint8Array.from(atob((audio as { audio: string }).audio), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: AUDIO_HEADERS });
  }
  throw new HttpError(502, 'provider_error', 'The voice model returned no audio.');
}
