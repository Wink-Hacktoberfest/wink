import { chat, describeImage } from '../inference.ts';
import { json, readUpload } from '../http.ts';
import { broadcast } from '../live.ts';
import { mockGlanceSpeech, mockVision } from '../mock.ts';
import { GLANCE_SYSTEM } from '../prompts.ts';
import { isMock, optionalString } from '../parse.ts';
import { sanitizeSpeech } from '../speech.ts';
import { background, type RouteContext } from './context.ts';

export async function glance({ request, env, ctx }: RouteContext): Promise<Response> {
  const { image, contentType, meta } = await readUpload(request);
  const utterance = optionalString(meta.utterance);
  let title: string, objects: string[], speech: string;
  if (isMock(env)) {
    const v = mockVision(utterance);
    ({ title, objects } = v);
    speech = sanitizeSpeech(mockGlanceSpeech(v));
  } else {
    const v = await describeImage(env, image, contentType, utterance);
    ({ title, objects } = v);
    const context = [
      `What the camera sees: ${v.title}. ${v.summary}`,
      v.visibleText ? `Readable text: ${v.visibleText}` : '',
      v.objects.length ? `Objects: ${v.objects.join(', ')}` : '',
      `The wearer asked: "${utterance ?? "what's this?"}"`,
    ].filter(Boolean).join('\n');
    const reply = await chat(env, GLANCE_SYSTEM, context, 600).catch((error) => {
      console.error(`glance chat failed: ${error instanceof Error ? error.message : String(error)}`);
      return `That looks like ${v.title}. ${v.summary}`;
    });
    speech = sanitizeSpeech(reply) || sanitizeSpeech(`That looks like ${v.title}.`);
  }
  await background(ctx, broadcast(env, { type: 'glance', speech, title, objects }));
  return json({ speech, title, objects });
}
