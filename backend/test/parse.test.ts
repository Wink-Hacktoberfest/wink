import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractChatText } from '../src/inference.ts';
import { extractJsonObject, parseLocation, parseSelection, parseVisionJson } from '../src/parse.ts';

test('parses clean vision JSON', () => {
  const v = parseVisionJson('{"title":"2019 Malbec, Mendoza","summary":"A bottle of red wine.","visibleText":"MALBEC 2019","objects":["wine bottle","label"],"businessName":null,"productQuery":"red wine"}');
  assert.deepEqual(v, {
    title: '2019 Malbec, Mendoza', summary: 'A bottle of red wine.', visibleText: 'MALBEC 2019',
    objects: ['wine bottle', 'label'], businessName: null, productQuery: 'red wine',
  });
});

test('parses fenced JSON with chatter, snake_case keys and trailing commas', () => {
  const v = parseVisionJson('Sure! Here it is:\n```json\n{"title": "Gray Owl Coffee", "summary": "A cafe storefront {sign}.", "visible_text": "GRAY OWL", "objects": "sign, door", "business_name": "Gray Owl Coffee", "product_query": "null",}\n```');
  assert.equal(v.title, 'Gray Owl Coffee');
  assert.equal(v.summary, 'A cafe storefront {sign}.');
  assert.equal(v.visibleText, 'GRAY OWL');
  assert.deepEqual(v.objects, ['sign', 'door']);
  assert.equal(v.businessName, 'Gray Owl Coffee');
  assert.equal(v.productQuery, null);
});

test('falls back to prose when there is no JSON', () => {
  const v = parseVisionJson('A blue running shoe on a wooden floor. It has orange laces.');
  assert.equal(v.title, 'A blue running shoe on a wooden floor');
  assert.deepEqual(v.objects, []);
  assert.equal(parseVisionJson(null).title, 'Something you saw');
  assert.equal(parseVisionJson({ objects: ['keys'] }).title, 'keys');
});

test('extractJsonObject skips broken objects', () => {
  assert.deepEqual(extractJsonObject('{bad} then {"a": 1}'), { a: 1 });
  assert.equal(extractJsonObject('no json'), null);
});

test('gpt-oss replies: content, harmony leakage, and reasoning-only', () => {
  assert.equal(extractChatText({ choices: [{ message: { content: 'Hello.', reasoning_content: 'think' } }] }), 'Hello.');
  assert.equal(extractChatText({ choices: [{ message: { content: '<|channel|>analysis<|message|>hmm<|end|><|start|>assistant<|channel|>final<|message|>It is a book.' } }] }), 'It is a book.');
  assert.equal(extractChatText({ choices: [{ message: { content: null, reasoning_content: 'only thoughts' } }] }), '');
});

test('location and selection parsing', () => {
  assert.deepEqual(parseLocation({ lat: 35.2, lng: -97.4 }), { lat: 35.2, lng: -97.4 });
  assert.equal(parseLocation({ lat: 0, lng: 0 }), null);
  assert.equal(parseLocation(null), null);
  assert.deepEqual(parseSelection({ mode: 'point', box: { x: 0.3, y: 0.2, w: 1.4, h: 0.4 } }), { mode: 'point', box: { x: 0.3, y: 0.2, w: 1, h: 0.4 } });
  assert.deepEqual(parseSelection({ mode: 'full', box: { x: 0, y: 0, w: 1, h: 1 } }), { mode: 'full', box: null });
  assert.deepEqual(parseSelection(undefined), { mode: 'full', box: null });
});
