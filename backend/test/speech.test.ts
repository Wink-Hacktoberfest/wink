import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeSpeech, spokenDistance, timeAgo } from '../src/speech.ts';
import { nearbySpeech } from '../src/routes/nearby.ts';
import { saveSpeech } from '../src/routes/memories.ts';

test('strips markdown, emoji and URLs', () => {
  const out = sanitizeSpeech('**That was** _Project Hail Mary_ 📚 by Andy Weir. See https://example.com/book [here](https://x.y).');
  assert.equal(out, 'That was Project Hail Mary by Andy Weir. See here.');
  assert.doesNotMatch(out, /[*_📚]|http/);
});

test('flattens lists and headings into sentences', () => {
  const out = sanitizeSpeech('# Answer\n- It is a wine bottle\n- From Mendoza');
  assert.equal(out, 'Answer. It is a wine bottle. From Mendoza.');
});

test('caps at 25 words, preferring a sentence boundary', () => {
  const long = 'That was the 2019 Malbec from Mendoza that Sam liked at dinner. ' +
    'It has a red label with a gold condor and you saved it about two minutes ago near the window.';
  const out = sanitizeSpeech(long);
  assert.ok(out.split(' ').length <= 25, out);
  assert.equal(out, 'That was the 2019 Malbec from Mendoza that Sam liked at dinner.');
  const runOn = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  assert.equal(sanitizeSpeech(runOn).split(' ').length, 25);
});

test('non-strings and empty input become empty speech', () => {
  assert.equal(sanitizeSpeech(undefined), '');
  assert.equal(sanitizeSpeech('  🎉  '), '');
});

test('time ago and distances read naturally', () => {
  const now = Date.parse('2026-10-26T20:00:00Z');
  assert.equal(timeAgo('2026-10-26T19:58:00Z', now), 'about 2 minutes ago');
  assert.equal(timeAgo('2026-10-26T19:59:50Z', now), 'just now');
  assert.equal(timeAgo('2026-10-26T17:00:00Z', now), 'about 3 hours ago');
  assert.equal(spokenDistance(412), '400 meters');
  assert.equal(spokenDistance(1460), '1.5 kilometers');
});

test('save and nearby templates', () => {
  assert.equal(saveSpeech('2019 Malbec, Mendoza', 'the wine sam liked'), 'Saved. 2019 Malbec, Mendoza. The wine sam liked.');
  assert.equal(saveSpeech('Project Hail Mary.', null), 'Saved. Project Hail Mary.');
  const place = { id: '1', name: 'Gray Owl Books', category: 'book_store', address: null, phone: null, lat: 0, lng: 0, distanceMeters: 412 };
  assert.equal(nearbySpeech('book stores', [place, place, place]), 'Three book stores nearby. The closest is Gray Owl Books, 400 meters away.');
  assert.equal(nearbySpeech('book stores', []), "I couldn't find any book stores within 3 kilometers.");
});
