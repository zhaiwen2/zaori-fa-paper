import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationLimiter, TRANSLATION_REQUEST_INTERVAL_MS } from './translation-rate-limit.mjs';

function clock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; }, advance: ms => { time += ms; } };
}

test('Every rolling minute stays below 20 requests, including failed attempts and mixed callers', async () => {
  const time = clock(), limit = createTranslationLimiter(time), started = [];
  for (let i = 0; i < 100; i++) {
    try { await limit(() => { started.push(time.now()); if (i % 10 === 0) throw new Error('HTTP 429'); }); }
    catch (error) { assert.equal(error.message, 'HTTP 429'); }
  }
  assert.equal(started[0], TRANSLATION_REQUEST_INTERVAL_MS);
  for (const end of started) assert.ok(started.filter(at => at > end - 60000 && at <= end).length <= 20);
  for (let i = 1; i < started.length; i++) assert.ok(started[i] - started[i - 1] >= 3100);
});

test('The interval is measured after slow preparation, and long responses need no extra delay', async () => {
  const time = clock(), limit = createTranslationLimiter(time), started = [];
  await limit(() => { started.push(time.now()); }, { onReady: async () => time.advance(5000) });
  await limit(() => { started.push(time.now()); time.advance(8000); });
  await limit(() => { started.push(time.now()); });
  assert.equal(started[1] - started[0], 3100);
  assert.equal(started[2] - started[1], 8000);
});

test('Cancelling a wait sends nothing and does not consume another request slot', async () => {
  const time = clock(), limit = createTranslationLimiter(time), controller = new AbortController(); let sends = 0;
  await assert.rejects(limit(() => { sends++; }, { signal: controller.signal, onWait: async () => controller.abort() }), { name: 'AbortError' });
  assert.equal(sends, 0);
  await limit(() => { sends++; });
  assert.equal(time.now(), 3100);
  assert.equal(sends, 1);
});

test('Fast app restarts cool down before reusing the same API quota', async () => {
  const time = clock(), starts = [];
  await createTranslationLimiter(time)(() => starts.push(time.now()));
  await createTranslationLimiter(time)(() => starts.push(time.now()));
  assert.equal(starts[1] - starts[0], 3100);
});

test('Configurable spacing follows the current setting and zero removes the delay', async () => {
  const time = clock(), limit = createTranslationLimiter(time), starts = [];
  for (const intervalMs of [10000, 15000, 3100, 0]) await limit(() => starts.push(time.now()), { intervalMs });
  assert.deepEqual(starts, [10000, 25000, 28100, 28100]);
  await assert.rejects(limit(() => {}, { intervalMs: NaN }), /无效请求间隔/);
  const controller = new AbortController();
  await assert.rejects(limit(() => assert.fail('Cancelled wait must not send'), { intervalMs: 20000, signal: controller.signal, onWait: () => controller.abort() }), { name: 'AbortError' });
});
