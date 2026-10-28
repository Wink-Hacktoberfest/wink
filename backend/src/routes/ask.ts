import { chat } from '../inference.ts';
import { HttpError, json, readJson } from '../http.ts';
import { broadcast, mockStore } from '../live.ts';
import { mockSearch } from '../mock.ts';
import { ASK_SYSTEM } from '../prompts.ts';
import { isMock } from '../parse.ts';
import { listMemories, searchMemories } from '../neon.ts';
import { sanitizeSpeech, timeAgo } from '../speech.ts';
import type { StoredMemory } from '../types.ts';
import { background, toMemory, type RouteContext } from './context.ts';

export const NO_MATCH_SPEECH = "I don't have a memory of that yet.";

/** "What did I just save?" is about time, which the embeddings don't capture, so it also gets the newest memory. */
export const RECENT_QUESTION = /\b(just|last|latest|most recent(ly)?)\b.*\b(sav(e|ed)|captur(e|ed))\b/i;

export function templateAnswer(m: StoredMemory, now = Date.now()): string {
  const when = timeAgo(m.createdAt, now);
  const note = m.note ? `, ${m.note}` : '';
  const where = m.place ? ` at ${m.place.name}` : '';
  return sanitizeSpeech(`That was ${m.title.replace(/[.!?]+$/, '')}${note}. You saved it ${when}${where}.`);
}

export function memoryContext(memories: StoredMemory[], now = Date.now()): string {
  return memories.map((m, i) => [
    `${i + 1}. ${m.title}`,
    `saved ${timeAgo(m.createdAt, now)}`,
    m.summary && `summary: ${m.summary}`,
    m.visibleText && `visible text: ${m.visibleText}`,
    m.objects.length ? `objects: ${m.objects.join(', ')}` : '',
    m.note && `wearer's note: ${m.note}`,
    m.place && `place: ${m.place.name}${m.place.address ? `, ${m.place.address}` : ''}`,
  ].filter(Boolean).join(' | ')).join('\n');
}

export async function ask({ request, env, ctx, url }: RouteContext): Promise<Response> {
  const body = await readJson(request);
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
  if (!question) throw new HttpError(400, 'missing_question', 'question is required.');

  let matches: StoredMemory[];
  let speech: string;
  if (isMock(env)) {
    const { memories } = await mockStore<{ memories: StoredMemory[] }>(env, 'GET');
    matches = mockSearch(memories, question);
    speech = matches[0] ? templateAnswer(matches[0]) : NO_MATCH_SPEECH;
  } else {
    const [found, latest] = await Promise.all([
      searchMemories(env, question),
      RECENT_QUESTION.test(question) ? listMemories(env, 1) : Promise.resolve([]),
    ]);
    matches = latest[0] ? [latest[0], ...found.filter((m) => m.id !== latest[0]!.id)] : found;
    if (!matches.length) {
      speech = NO_MATCH_SPEECH;
    } else {
      const prompt = `Question: ${question}\n\nSaved memories that may answer it:\n${memoryContext(matches)}`;
      const reply = await chat(env, ASK_SYSTEM, prompt, 700).catch((error) => {
        console.error(`ask chat failed: ${error instanceof Error ? error.message : String(error)}`);
        return templateAnswer(matches[0]!);
      });
      speech = sanitizeSpeech(reply) || templateAnswer(matches[0]!);
    }
  }
  const memories = matches.slice(0, 3).map((m) => toMemory(m, url.origin));
  await background(ctx, broadcast(env, { type: 'answer', question, speech, memories }));
  return json({ speech, memories });
}
