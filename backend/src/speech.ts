const MAX_WORDS = 25;

/** Makes text safe to speak into the wearer's ear: no markdown, emoji or URLs, at most ~25 words. */
export function sanitizeSpeech(input: unknown, maxWords = MAX_WORDS): string {
  if (typeof input !== 'string') return '';
  let text = input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/^\s*(?:#{1,6}|>|[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~#|]+/g, '')
    .replace(/\s*[\r\n]+\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/([.!?])(?:\s*[.!?])+/g, '$1')
    .trim();
  text = text.replace(/^[.,;:\s]+/, '');
  if (!text) return '';
  const words = text.split(' ');
  if (words.length > maxWords) {
    const clipped = words.slice(0, maxWords).join(' ');
    // Prefer ending on a full sentence if one finishes inside the cap.
    const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
    text = lastStop > clipped.length / 3 ? clipped.slice(0, lastStop + 1) : clipped.replace(/[,;:\s]+$/, '');
  }
  if (!/[.!?]$/.test(text)) text += '.';
  return text;
}

/** "about 2 minutes ago", "just now", "about 3 hours ago", "yesterday". */
export function timeAgo(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'some time ago';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes <= 1 ? 'about a minute ago' : `about ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'about an hour ago' : `about ${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export function numberWord(n: number): string {
  return SMALL[n] ?? String(n);
}

export function spokenDistance(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters)) return '';
  if (meters < 100) return `${Math.max(10, Math.round(meters / 10) * 10)} meters`;
  if (meters < 1000) return `${Math.round(meters / 50) * 50} meters`;
  const km = Math.round(meters / 100) / 10;
  return `${km} kilometers`;
}
