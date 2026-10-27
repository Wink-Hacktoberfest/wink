import { HttpError, isRecord } from './http.ts';
import type { Box, LiveEvent } from './types.ts';

const STATES = ['idle', 'listening', 'thinking', 'speaking', 'paused'];
const GESTURES = ['point', 'frame', 'lasso', 'palm', 'thumbsUp', 'fingers', 'pinch', 'flick'];
const normalized = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function validBox(value: unknown): value is Box {
  return isRecord(value) && normalized(value.x) && normalized(value.y) && normalized(value.w) && normalized(value.h) &&
    value.w > 0 && value.h > 0 && value.x + value.w <= 1.000001 && value.y + value.h <= 1.000001;
}

/** Only phone-originated events are accepted; clients cannot forge saved memories or answers. */
export function parseClientEvent(body: unknown, socket = false): LiveEvent {
  const invalid = () => new HttpError(400, 'invalid_event', socket
    ? 'Send a valid status, transcript, gesture, pointer or frame event.'
    : 'Send a valid status, transcript or gesture event.');
  if (!isRecord(body)) throw invalid();
  if (body.type === 'status' && STATES.includes(body.state as string)) {
    if (body.text !== undefined && typeof body.text !== 'string') throw invalid();
    return typeof body.text === 'string'
      ? { type: 'status', state: body.state as never, text: body.text.slice(0, 500) }
      : { type: 'status', state: body.state as never };
  }
  if (body.type === 'transcript' && typeof body.text === 'string') {
    return { type: 'transcript', text: body.text.slice(0, 1000) };
  }
  if (body.type === 'gesture' && GESTURES.includes(body.gesture as string)) {
    const event: LiveEvent = { type: 'gesture', gesture: body.gesture as never };
    if (body.value !== undefined) {
      if (typeof body.value !== 'number' || !Number.isFinite(body.value)) throw invalid();
      event.value = body.value;
    }
    if (body.box !== undefined) {
      if (!validBox(body.box)) throw invalid();
      const { x, y, w, h } = body.box;
      event.box = { x, y, w, h };
    }
    return event;
  }
  if (socket && body.type === 'pointer' && normalized(body.x) && normalized(body.y) && typeof body.pinching === 'boolean') {
    return { type: 'pointer', x: body.x, y: body.y, pinching: body.pinching };
  }
  if (socket && body.type === 'frame' && typeof body.jpegBase64 === 'string' &&
      body.jpegBase64.length <= 400_000 && /^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(body.jpegBase64) && body.jpegBase64.length % 4 === 0) {
    return { type: 'frame', jpegBase64: body.jpegBase64 };
  }
  throw invalid();
}
