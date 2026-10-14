import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlocks, units, blockDone, checkBlockIds } from './document.mjs';
import { adoptTranslationRun, createTranslationBatches, edgeLanguageCode, edgeTranslationValues, readingBatchIds, translateBlocks, translationEndpoint, translationSnapshot } from './translation.mjs';

const makeDoc = count => ({ blocks: createBlocks(Array.from({ length: count }, (_, i) => `Paragraph ${i}. **Important** result.`).join('\n\n')), usage: {} });
const response = batch => ({ values: Object.fromEntries(batch.map(unit => [unit.id, `译文 ${unit.text}`])), usage: { total_tokens: 10 } });

test('Edge builds its fixed endpoint with language codes and ignores cloud credentials/model', () => {
  const config = translationSnapshot({ provider: 'edge', sourceLang: 'English', targetLang: '简体中文', model: 'unused', baseUrl: 'https://unused.invalid', glossary: 'unused' });
  assert.equal(translationEndpoint(config), 'https://edge.microsoft.com/translate/translatetext?from=en&to=zh-Hans');
  assert.equal(config.model, ''); assert.equal(config.glossary, '');
  assert.equal(edgeLanguageCode('zh-CHS'), 'zh-Hans');
  assert.match(translationEndpoint({ ...config, sourceLang: 'auto' }), /\?from=&to=zh-Hans$/);
  for (const targetLang of ['', 'auto', 'unknown language', 'en&to=fr']) assert.throws(() => translationEndpoint({ ...config, targetLang }), /Edge 语言/);
  assert.equal(createTranslationBatches(createBlocks(Array(85).fill('Sample paragraph.').join('\n\n')), config).length, 1);
});

test('Edge validates complete ordered responses and retains fragment whitespace', () => {
  const segments = [{ id: 'b0::0', text: ' Hello ' }, { id: 'b1::0', text: 'world' }];
  const result = [{ translations: [{ text: '你好' }] }, { translations: [{ text: '世界' }] }];
  assert.deepEqual(edgeTranslationValues(segments, result), { 'b0::0': ' 你好 ', 'b1::0': '世界' });
  for (const invalid of [null, [], result.slice(0, 1), [...result, result[0]], [{ translations: [{ text: '' }] }, result[1]], [null, result[1]]]) assert.throws(() => edgeTranslationValues(segments, invalid));
});

test('Switching to Edge retains completed translations with matching language aliases', () => {
  const doc = makeDoc(1); doc.run = { provider: 'chat', sourceLang: 'English', targetLang: '简体中文' };
  doc.blocks[0].values = { saved: '已有译文' }; const saved = JSON.stringify(doc.blocks);
  const edge = translationSnapshot({ provider: 'edge', sourceLang: 'en', targetLang: 'zh-CHS' });
  adoptTranslationRun(doc, edge); assert.equal(JSON.stringify(doc.blocks), saved);
  assert.equal(doc.runHistory[0].provider, 'chat');
  assert.throws(() => adoptTranslationRun(doc, { provider: 'local-api', sourceLang: 'en', targetLang: 'ja' }), /设置已改变/);
});

test('Changing cloud endpoint/model preserves cached translations and continues pending fragments', async () => {
  const doc = makeDoc(2);
  doc.run = { provider: 'chat', baseUrl: 'https://old.invalid/v1', model: 'old', sourceLang: 'English', targetLang: '简体中文', glossary: '' };
  const first = doc.blocks[0]; for (const unit of units(first)) first.values[unit.id] = '缓存译文';
  const saved = JSON.stringify(first), previous = doc.run;
  const config = { ...previous, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' };
  adoptTranslationRun(doc, config);
  assert.equal(doc.run, config); assert.deepEqual(doc.runHistory, [previous]);
  const sent = [];
  await translateBlocks(doc, { pause: false }, doc.blocks, async batch => { sent.push(...batch); return response(batch); }, async () => {}, () => {}, undefined, Infinity, config);
  assert.equal(JSON.stringify(first), saved);
  assert.ok(sent.length > 0 && sent.every(unit => unit.id.startsWith(doc.blocks[1].id + '::')));
  assert.ok(doc.blocks.every(blockDone));
  assert.throws(() => adoptTranslationRun(doc, { ...config, targetLang: '日语' }), /设置已改变/);
  assert.throws(() => adoptTranslationRun(doc, { ...config, glossary: 'changed' }), /设置已改变/);
});

test('Batch estimates use actual boundaries, preserve IDs and skip cached/preserved fragments', () => {
  const doc = makeDoc(85), first = doc.blocks[0];
  first.values[units(first)[0].id] = '已有译文';
  const preserved = createBlocks('`code`')[0];
  const batches = createTranslationBatches([...doc.blocks, preserved]);
  const records = batches.flat();
  assert.equal(records.length, doc.blocks.flatMap(units).length - 1);
  assert.equal(new Set(records.map(record => record.id)).size, records.length);
  assert.ok(batches.every(batch => batch.length <= 200 && batch.reduce((sum, record) => sum + record.unit.text.length, 0) <= 22500));
  assert.ok(records.every(record => !record.block.preserve));
  assert.equal(first.values[units(first)[0].id], '已有译文');
});

test('Short paragraphs share one request across the old 40-block and 80-fragment boundaries', () => {
  const blocks = createBlocks(Array.from({ length: 85 }, (_, i) => `Short paragraph ${i}.`).join('\n\n'));
  assert.equal(createTranslationBatches(blocks).length, 1);
  assert.equal(createTranslationBatches(blocks)[0].length, 85);
});

test('Reading fills one request with following blocks, skips caches and stops before another batch', () => {
  const doc = { blocks: createBlocks(Array.from({ length: 400 }, (_, i) => `Short paragraph ${i}.`).join('\n\n')) };
  const saved = doc.blocks[2]; for (const unit of units(saved)) saved.values[unit.id] = '已保存';
  const ids = readingBatchIds(doc, ['b0', 'b1']);
  assert.equal(ids.length, 200);
  assert.deepEqual(ids.slice(0, 3), ['b0', 'b1', 'b3']);
  assert.equal(ids.at(-1), 'b200');
  assert.equal(createTranslationBatches(doc.blocks.filter(block => ids.includes(block.id))).length, 1);
  assert.deepEqual(readingBatchIds(doc, []), []);
});

test('Reading yields after one request so newly visible blocks can take priority', async () => {
  const doc = makeDoc(85); let calls = 0;
  await translateBlocks(doc, { pause: false }, doc.blocks, async batch => { calls++; return response(batch); }, async () => {}, () => {}, undefined, 1);
  assert.equal(calls, 1);
  assert.ok(doc.blocks.some(block => !blockDone(block)));
});

test('Reading also stops at the character budget and never adds a partial neighboring block', () => {
  const doc = { blocks: createBlocks(Array.from({ length: 100 }, () => 'X'.repeat(340) + '.').join('\n\n')) };
  const ids = readingBatchIds(doc, ['b0', 'b1']);
  assert.equal(ids.length, 65);
  const batches = createTranslationBatches(doc.blocks.filter(block => ids.includes(block.id)));
  assert.equal(batches.length, 1);
  assert.ok(batches[0].reduce((total, record) => total + record.unit.text.length, 0) <= 22500);
  assert.equal(ids.at(-1), 'b64');
});

test('A failed later batch preserves completed and partial translations for resuming', async () => {
  const doc = makeDoc(85), current = { pause: false }, saved = [];
  let calls = 0;
  await assert.rejects(translateBlocks(doc, current, doc.blocks, async batch => {
    if (++calls === 2) throw new Error('HTTP 429');
    return response(batch);
  }, async () => saved.push(JSON.stringify(doc)), () => {}), /HTTP 429/);
  assert.equal(calls, 2);
  assert.equal(doc.usage.total_tokens, 10);
  assert.ok(saved.length >= 2);
  const cached = JSON.stringify(doc.blocks[0].values);
  await translateBlocks(doc, current, doc.blocks, async batch => response(batch), async () => {}, () => {});
  assert.ok(doc.blocks.every(blockDone));
  assert.equal(JSON.stringify(doc.blocks[0].values), cached);
});

test('Pausing between requests retains results and sends no next batch', async () => {
  const doc = makeDoc(85), current = { pause: false }; let calls = 0;
  await translateBlocks(doc, current, doc.blocks, async batch => { calls++; current.pause = true; return response(batch); }, async () => {}, () => {});
  assert.equal(calls, 1);
  assert.ok(doc.blocks.some(blockDone));
  assert.ok(doc.blocks.some(block => !blockDone(block)));
});

test('Translation errors retain their timeout identity and redact block messages', async () => {
  const doc = makeDoc(1), error = Object.assign(new Error('secret-token'), { code: 'TRANSLATION_TIMEOUT' });
  await assert.rejects(translateBlocks(doc, { pause: false }, doc.blocks, async () => { throw error; }, async () => {}, () => {}, () => '已隐藏'), candidate => candidate === error);
  assert.equal(doc.blocks[0].error, '已隐藏');
});

test('Legacy cached translations can migrate services only with the same languages', () => {
  const config = { provider: 'chat', baseUrl: 'https://example.invalid', model: 'fixture', sourceLang: 'English', targetLang: '简体中文', glossary: '' };
  const doc = { run: { provider: 'local', sourceLang: 'en', targetLang: 'zh' } };
  adoptTranslationRun(doc, config);
  assert.equal(doc.runHistory[0].provider, 'local');
  adoptTranslationRun(doc, Object.fromEntries(Object.entries(config).reverse()));
  assert.equal(doc.runHistory.length, 1);
  assert.throws(() => adoptTranslationRun(doc, { ...config, targetLang: '日语' }), /设置已改变/);
  adoptTranslationRun(doc, { ...config, targetLang: '日语' }, true);
  assert.equal(doc.run.targetLang, '日语');
});

test('Re-chunked legacy block IDs are accepted while malformed IDs are rejected', () => {
  checkBlockIds(['b0', 'b3-1', 'b3-1-2']);
  for (const ids of [['../b0'], ['b0-x'], [null], Array(101).fill('b0'), 'b0']) assert.throws(() => checkBlockIds(ids), /无效/);
});

test('Local configuration resolves a loopback endpoint separately from the cloud configuration', () => {
  const settings = { provider: 'local-api', localBaseUrl: 'http://127.0.0.1:11434/v1', localModel: 'local-fixture', localBatchCharacters: 3000,
    baseUrl: 'https://cloud.invalid/v1', model: 'cloud-fixture', sourceLang: 'English', targetLang: '简体中文', glossary: '' };
  const local = translationSnapshot(settings);
  assert.equal(local.model, 'local-fixture');
  assert.equal(translationEndpoint(local), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(translationEndpoint({ ...local, baseUrl: 'http://[::1]:1234/v1/chat/completions' }), 'http://[::1]:1234/v1/chat/completions');
  for (const baseUrl of ['http://192.168.1.5:1234/v1', 'https://cloud.invalid/v1', 'http://user:pass@localhost:1234/v1', 'file:///v1']) {
    assert.throws(() => translationEndpoint({ ...local, baseUrl }));
  }
  assert.equal(translationSnapshot({ ...settings, provider: 'chat' }).model, 'cloud-fixture');
});

test('Local batch capacity controls translation and reading prefetch consistently', () => {
  const doc = { blocks: createBlocks(Array.from({ length: 50 }, () => 'X'.repeat(300)).join('\n\n')) };
  const config = { provider: 'local-api', batchCharacters: 3000 };
  assert.equal(createTranslationBatches(doc.blocks, config).length, 5);
  assert.equal(readingBatchIds(doc, ['b0'], config).length, 10);
  assert.equal(createTranslationBatches(doc.blocks).length, 1);
});

test('Cloud settings control batch size, reading prefetch and resume without losing caches', () => {
  const doc = { blocks: createBlocks(Array.from({ length: 8 }, () => 'X'.repeat(300)).join('\n\n')) };
  const settings = { provider: 'chat', sourceLang: 'English', targetLang: '简体中文', cloudBatchSegments: 2, cloudBatchCharacters: 1000, cloudRequestIntervalSeconds: 8 };
  const config = translationSnapshot(settings);
  assert.equal(config.requestIntervalMs, 8000);
  assert.deepEqual(createTranslationBatches(doc.blocks, config).map(batch => batch.length), [2, 2, 2, 2]);
  assert.deepEqual(readingBatchIds(doc, ['b0'], config), ['b0', 'b1']);
  assert.equal(createTranslationBatches(doc.blocks, { ...config, batchSegments: 200, batchCharacters: 500 }).length, 8);
  doc.run = config;
  for (const unit of units(doc.blocks[0])) doc.blocks[0].values[unit.id] = '缓存译文';
  const saved = JSON.stringify(doc.blocks[0]);
  adoptTranslationRun(doc, { ...config, batchSegments: 1, batchCharacters: 500, requestIntervalMs: 10000 });
  assert.equal(JSON.stringify(doc.blocks[0]), saved);
  assert.equal(createTranslationBatches(doc.blocks, doc.run).length, 7);
  assert.throws(() => createTranslationBatches(doc.blocks, { ...config, batchCharacters: 200 }), /字数上限/);
  const defaults = translationSnapshot({ provider: 'chat' });
  assert.equal(defaults.batchSegments, 20); assert.equal(defaults.batchCharacters, 4000); assert.equal(defaults.requestIntervalMs, 3100);
  assert.equal(translationSnapshot({ ...settings, provider: 'edge' }).requestIntervalMs, undefined);
});

test('Switching cloud and local services preserves caches only when their languages match', () => {
  const cloud = { provider: 'chat', baseUrl: 'https://cloud.invalid/v1', model: 'cloud', sourceLang: 'English', targetLang: '简体中文', glossary: '' };
  const local = { ...cloud, provider: 'local-api', baseUrl: 'http://localhost:11434/v1', model: 'local', batchCharacters: 3000 };
  const doc = makeDoc(1); doc.run = cloud;
  doc.blocks[0].values = Object.fromEntries(units(doc.blocks[0]).map(unit => [unit.id, '已有译文']));
  const saved = JSON.stringify(doc.blocks);
  adoptTranslationRun(doc, local);
  assert.equal(JSON.stringify(doc.blocks), saved);
  assert.equal(doc.runHistory[0].provider, 'chat');
  adoptTranslationRun(doc, { ...local, batchCharacters: 6000 });
  assert.throws(() => adoptTranslationRun(doc, { ...cloud, targetLang: '日语' }), /设置已改变/);
  adoptTranslationRun(doc, cloud);
  assert.equal(doc.run.provider, 'chat');
});
