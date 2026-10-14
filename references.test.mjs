import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReferenceIndex, findReferences, referenceCandidates, referenceNumber } from './references.mjs';

test('Chinese and English references share normalized keys and accurate text ranges', () => {
  const text = 'See Fig. 2(a), Figure S01, Table 1.2 and Eq. (3); 图二、表（1.2）、公式（3）。';
  const found = findReferences(text);
  assert.deepEqual(found.map(item => item.key), ['figure:2(a)', 'figure:S1', 'table:1.2', 'equation:3', 'figure:2', 'table:1.2', 'equation:3']);
  assert.ok(found.every(item => text.slice(item.start, item.end) === item.text));
  assert.equal(referenceNumber('十一'), '11'); assert.equal(referenceNumber('一百二十三'), '123');
  assert.equal(referenceNumber('<script>'), null);
  assert.deepEqual(findReferences('configuration 2, stable 1 and require 3'), []);
});

test('Image, table and equation labels resolve to actual objects, not prose citations', () => {
  const index = buildReferenceIndex([
    { id: 'b0', text: 'See Figure 2 and Table 1.', objects: [] },
    { id: 'b1', text: '', objects: [{ kind: 'figure', index: 0, label: 'Diagram' }] },
    { id: 'b2', text: 'Figure 2. Model architecture.', objects: [] },
    { id: 'b3', text: 'Table 1. Metrics.', objects: [] },
    { id: 'b4', text: 'Metric Definition', objects: [{ kind: 'table', index: 0 }] },
    { id: 'b5', text: '', objects: [{ kind: 'equation', index: 0, number: '3' }] },
    { id: 'b6', text: '(4)', objects: [{ kind: 'equation', index: 0 }] },
  ]);
  assert.equal(index.byKey.get('figure:2')[0].blockId, 'b1');
  assert.equal(index.byKey.get('table:1')[0].blockId, 'b4');
  assert.equal(index.byKey.get('equation:3')[0].blockId, 'b5');
  assert.equal(index.byKey.get('equation:4')[0].blockId, 'b6');
  assert.equal(index.targets.length, 4);
  assert.equal(referenceCandidates(index, findReferences('Fig. 2(a)')[0])[0].blockId, 'b1');
});

test('Duplicate and missing numbers retain candidates for explicit selection', () => {
  const index = buildReferenceIndex([
    { id: 'b0', text: '', objects: [{ kind: 'figure', index: 0, label: 'Figure 1. First' }] },
    { id: 'b1', text: '', objects: [{ kind: 'figure', index: 0, label: 'Figure 1. Second' }] },
    { id: 'b2', text: '', objects: [{ kind: 'table', index: 0, label: 'Unnumbered' }] },
  ]);
  assert.equal(referenceCandidates(index, findReferences('Figure 1')[0]).length, 2);
  assert.equal(index.byKey.has('table:7'), false);
  assert.equal(referenceCandidates(index, findReferences('Table 7')[0])[0].blockId, 'b2');
  assert.deepEqual(referenceCandidates(index, findReferences('Equation 9')[0]), []);
});

test('Labels are not borrowed across another figure and chapter numbering stays distinct', () => {
  const index = buildReferenceIndex([
    { id: 'b0', text: 'Figure 1. Adjacent figure', objects: [{ kind: 'figure', index: 0 }] },
    { id: 'b1', text: '', objects: [{ kind: 'figure', index: 0 }] },
    { id: 'b2', text: 'Figure 3.1. Caption', objects: [] },
    { id: 'b3', text: '', objects: [{ kind: 'figure', index: 0, label: 'Figure 3.2. Another' }] },
  ]);
  assert.equal(index.targets[1].number, '3.1');
  assert.equal(index.byKey.get('figure:1').length, 1);
  assert.notEqual(index.byKey.get('figure:3.1')[0].id, index.byKey.get('figure:3.2')[0].id);
});
