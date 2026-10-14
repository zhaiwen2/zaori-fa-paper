import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlocks, units, blockDone } from './document.mjs';
import { prioritizeQueue, drainReadingQueue } from './translation-queue.mjs';
import { withTranslationTimeout } from './translation-timeout.mjs';

const document = () => ({ blocks: createBlocks('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\n`code`'), readingQueue: [] });
function complete(block) { for (const unit of units(block)) block.values[unit.id] = unit.text; }

test('Translation timeout aborts the request, stops the worker and reports an actionable error', async () => {
  let aborted = false, stopped = false;
  await assert.rejects(withTranslationTimeout(signal => new Promise(() => signal.addEventListener('abort', () => { aborted = true; })), {
    timeoutMs: 15, message: '单次翻译超时，已强制停止。', onTimeout: () => { stopped = true; },
  }), error => error.code === 'TRANSLATION_TIMEOUT' && error.message === '单次翻译超时，已强制停止。');
  assert.equal(aborted, true);
  assert.equal(stopped, true);
});

test('Queue deduplicates, prioritizes visible blocks and skips translated/preserved blocks', () => {
  const doc = document();
  complete(doc.blocks[0]);
  assert.equal(prioritizeQueue(doc, ['b0', 'b1', 'b1', 'b3', 'unknown']), true);
  assert.deepEqual(doc.readingQueue, ['b1']);
  prioritizeQueue(doc, ['b2', 'b1'], 'b1');
  assert.deepEqual(doc.readingQueue, ['b1', 'b2']);
  prioritizeQueue(doc, ['b2']);
  assert.deepEqual(doc.readingQueue, ['b2', 'b1']);
  assert.equal(prioritizeQueue(doc, ['b2']), false);
  const restored = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(restored.readingQueue, ['b2', 'b1']);
});

test('Worker runs serially, wakes when scrolling and preserves the waiting queue on pause', async () => {
  const doc = document(), current = { pause: false };
  prioritizeQueue(doc, ['b0']);
  const called = []; let running = 0, maxRunning = 0, snapshots = 0;
  await drainReadingQueue(doc, current, async id => {
    running++; maxRunning = Math.max(maxRunning, running); called.push(id);
    complete(doc.blocks.find(block => block.id === id));
    if (id === 'b1') current.pause = true;
    running--;
  }, async () => {
    snapshots++;
    if (doc.status === '等待阅读新段落' && !current.pause) {
      prioritizeQueue(doc, ['b1', 'b2']); current.wake();
    }
  }, () => {});
  assert.equal(maxRunning, 1);
  assert.deepEqual(called, ['b0', 'b1']);
  assert.deepEqual(doc.readingQueue, ['b2']);
  assert.equal(doc.status, '已暂停');
  assert.ok(snapshots >= 3);
});

test('Partial translations survive a pause and only missing units remain on resume', async () => {
  const doc = { blocks: createBlocks('Hello **world** again.'), readingQueue: ['b0'] };
  const current = { pause: false };
  await drainReadingQueue(doc, current, async () => {
    const first = units(doc.blocks[0])[0]; doc.blocks[0].values[first.id] = '你好 ';
    current.pause = true;
  }, async () => {}, () => {});
  assert.equal(blockDone(doc.blocks[0]), false);
  assert.deepEqual(doc.readingQueue, ['b0']);
  const remaining = units(doc.blocks[0]).filter(unit => !(unit.id in doc.blocks[0].values));
  assert.equal(remaining.length, units(doc.blocks[0]).length - 1);
});

test('The document queue adds no extra delay between completed requests', async () => {
  const doc = document(), current = { pause: false }, calls = [];
  prioritizeQueue(doc, ['b0', 'b1', 'b2']);
  const work = drainReadingQueue(doc, current, async id => {
    calls.push(id); complete(doc.blocks.find(block => block.id === id));
    if (calls.length === 3) current.pause = true;
  }, async () => {}, () => {});
  await Promise.race([work, new Promise((_, reject) => setImmediate(() => reject(new Error('Queue inserted a timer between local requests'))))]);
  assert.deepEqual(calls, ['b0', 'b1', 'b2']);
});

test('Cloud queue sends several visible paragraphs in one batch and removes only completed IDs', async () => {
  const doc = document(), current = { pause: false }, batches = [];
  prioritizeQueue(doc, ['b0', 'b1', 'b2']);
  await drainReadingQueue(doc, current, async ids => {
    batches.push(ids);
    for (const id of ids) complete(doc.blocks.find(block => block.id === id));
    current.pause = true;
  }, async () => {}, () => {}, 8);
  assert.deepEqual(batches, [['b0', 'b1', 'b2']]);
  assert.deepEqual(doc.readingQueue, []);
  assert.equal(doc.status, '已暂停');
});

test('A completed document releases its worker instead of waiting forever', async () => {
  const doc = document(), current = { pause: false };
  prioritizeQueue(doc, ['b0', 'b1', 'b2']);
  await drainReadingQueue(doc, current, async ids => {
    for (const id of ids) complete(doc.blocks.find(block => block.id === id));
  }, async () => {}, () => {}, 40);
  assert.equal(doc.status, '翻译完成');
  assert.deepEqual(doc.readingQueue, []);
  assert.equal(current.wake, undefined);
});

test('Pause releases even an operation that ignores its abort signal', async () => {
  const controller = new AbortController();
  const operation = withTranslationTimeout(() => new Promise(() => {}), { timeoutMs: 1000, signal: controller.signal });
  controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
});
