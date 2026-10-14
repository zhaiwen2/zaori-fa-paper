import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomic } from './files.mjs';
import { createBlocks, rechunkPendingBlocks, units, pendingUnits, blockDone, validateTranslations, view, exportMarkdown } from './document.mjs';
import { prioritizeQueue } from './translation-queue.mjs';

test('Translation validation accepts changed content but rejects empty or mismatched responses', () => {
  const input = [{ id: 'a', text: 'See [2,3] with 1,234.5 units and ６ tests. ' }];
  const values = validateTranslations(input, [{ id: 'a', text: '参见 [2、3]，1234.5 个单位及 6 项测试。' }]);
  assert.match(values.a, /1234\.5/);
  const changed = validateTranslations(input, [{ id: 'a', text: '第二节，1234.5 个单位及 7 项测试。' }]);
  assert.match(changed.a, /7 项测试/);
  assert.ok(changed.a.endsWith(' '));
  assert.throws(() => validateTranslations(input, [{ id: 'a', text: '' }]), /空文本/);
  assert.throws(() => validateTranslations(input, [{ id: 'wrong', text: '译文' }]), /标识不匹配/);
});

test('HTML table cells translate while formulas, merged cells, markup and code stay intact', () => {
  const formula = String.raw`$MAE = \frac{1}{n}\sum_{i=1}^{n}|y_i-\hat{y}_i|$`;
  const brackets = String.raw`\(x_i^2\)`;
  const html = `<table><caption>Forecast accuracy</caption><tr><th>Metric</th><th colspan="2">Definition</th></tr><tr><td rowspan="2">MAE</td><td>${formula}</td><td>Before ${brackets} after &amp; <strong>result</strong><br>Next line</td></tr><tr><td><code>$not_a_formula$</code></td><td><a href="https://example.com">Study</a><script>unsafe instructions</script></td></tr></table>`;
  const [block] = createBlocks(html), input = units(block);
  assert.equal(block.preserve, false);
  assert.ok(input.some(unit => unit.text === 'Metric'));
  assert.ok(input.some(unit => unit.text.includes('after &')));
  assert.ok(input.every(unit => !/frac|x_i|not_a_formula|unsafe instructions/.test(unit.text)), 'Formulas/code/scripts must never be sent for translation');
  block.values = Object.fromEntries(input.map(unit => [unit.id, `译${unit.text}`]));
  const translated = view({ blocks: [block] }).blocks[0].target;
  assert.ok(translated.includes(formula)); assert.ok(translated.includes(brackets));
  assert.match(translated, /colspan="2"/); assert.match(translated, /rowspan="2"/);
  assert.match(translated, /<strong>译result<\/strong>/); assert.match(translated, /after &amp;/);
  assert.match(translated, /<code>\$not_a_formula\$<\/code>/);
  assert.ok(blockDone(block)); assert.ok(exportMarkdown({ blocks: [block] }, 'translated').includes(formula));
  const restored = JSON.parse(JSON.stringify(block)); assert.deepEqual(units(restored), input);
  assert.equal(view({ blocks: [restored] }).blocks[0].target, translated);
});

test('HTML table translations cannot inject new HTML, links or attributes', () => {
  const [block] = createBlocks('<table><tr><td>Original text</td></tr></table>');
  block.values = { [units(block)[0].id]: '<img src="bad" onerror="alert(1)"> & value' };
  const result = view({ blocks: [block] }).blocks[0].target;
  assert.match(result, /&lt;img/); assert.match(result, /&amp; value/); assert.doesNotMatch(result, /<img/);
});

test('Previously preserved HTML tables become translatable on load; references stay preserved', () => {
  const [table] = createBlocks('<table><tr><td>Definition</td><td>$x_i$</td></tr></table>');
  delete table.node.children; table.preserve = true;
  const [upgraded] = rechunkPendingBlocks([table]);
  assert.equal(upgraded.id, table.id); assert.equal(upgraded.preserve, false); assert.equal(units(upgraded).length, 1);
  assert.deepEqual(rechunkPendingBlocks([upgraded]), [upgraded]);
  const [heading] = createBlocks('# References');
  assert.equal(rechunkPendingBlocks([heading, table])[1].preserve, true);
  assert.equal(createBlocks('<table><tr><td>$x_i$</td></tr></table>')[0].preserve, true);
});

test('Long HTML and Markdown tables keep their structure when loaded and batched', () => {
  const html = `<table>${Array(15).fill('<tr><td>' + 'A long table description. '.repeat(15) + '</td><td>$x_i^2$</td></tr>').join('')}</table>`;
  const markdown = '| Metric | Formula |\n| --- | --- |\n' + Array(15).fill('| ' + 'A long table description. '.repeat(15) + ' | $x_i^2$ |').join('\n');
  for (const input of [html, markdown]) {
    const blocks = createBlocks(input), before = view({ blocks });
    const loaded = rechunkPendingBlocks(blocks);
    assert.equal(loaded.length, 1); assert.equal(loaded[0], blocks[0]);
    assert.equal(view({ blocks: loaded }).blocks[0].source, before.blocks[0].source);
    assert.ok(units(loaded[0]).every(unit => !unit.text.includes('$x_i')));
  }
});

test('Long prose paragraphs become sentence-sized reading blocks without losing inline formatting', () => {
  const prose = Array.from({ length: 36 }, (_, index) => `We studied sample ${index + 1} and found a **clear result** in the control group.`).join(' ');
  const blocks = createBlocks(`# Abstract\n\n${prose}`);
  const paragraphs = blocks.slice(1);
  const text = node => node.type === 'text' ? node.value : (node.children ?? []).map(text).join('');
  assert.ok(paragraphs.length > 1);
  assert.ok(paragraphs.every(block => text(block.node).length <= 360));
  assert.equal(paragraphs.map(block => text(block.node)).join(''), prose.replaceAll('**', ''));
  assert.ok(paragraphs.some(block => JSON.stringify(block.node).includes('strong')));
});

test('Length splitting balances a final word and never breaks an English word', () => {
  const prose = 'Specifically, Day-Ahead Electricity Price Forecasting (DAEPF) gains significant attention in the operation of the day-ahead electricity market due to its decisive role, where suppliers and consumers rely on DAEPF to formulate forward-looking bids and quotes of electricity prices for the next day before the trading session.';
  const text = node => typeof node.value === 'string' ? node.value : (node.children ?? []).map(text).join('');
  for (const sample of [prose, `${'word '.repeat(71)}session.`, `${'An academic observation. '.repeat(13)}${'measurements '.repeat(5)}session.`, `${'文'.repeat(365)}结束。`, 'x'.repeat(380)]) {
    const chunks = createBlocks(sample).map(block => text(block.node));
    assert.equal(chunks.join(''), sample);
    assert.ok(chunks.every(chunk => chunk.trim() !== 'session.' && chunk.trim().length >= 72));
    for (let index = 1; index < chunks.length; index++) assert.ok(!(/[A-Za-z0-9]$/.test(chunks[index - 1]) && /^[A-Za-z0-9]/.test(chunks[index])));
  }
});

test('Legacy short split tails merge while cached translations remain intact', () => {
  const first = createBlocks('The complete trading')[0], tail = createBlocks(' session.')[0];
  first.id = 'b0-1'; tail.id = 'b0-2';
  first.values = { '0:0': '完整交易' }; tail.values = { '0:0': '时段。' };
  const [joined] = rechunkPendingBlocks([first, tail]);
  assert.equal(view({ blocks: [joined] }).blocks[0].target.trim(), '完整交易时段。');
  assert.equal(blockDone(joined), true);
  assert.equal(first.values['0:0'], '完整交易'); assert.equal(tail.values['0:0'], '时段。');
  assert.deepEqual(rechunkPendingBlocks([joined]), [joined]);
  const pending = { ...joined, values: {} };
  const [resumed] = rechunkPendingBlocks([pending]);
  assert.equal(units(resumed).length, 1, 'Retranslating an old merged tail sends complete text rather than a separate word');
  tail.edit = '人工修改'; assert.equal(rechunkPendingBlocks([first, tail]).length, 2);
  tail.edit = null; tail.id = 'b1-1'; assert.equal(rechunkPendingBlocks([first, tail]).length, 2);
});

test('Long paragraphs split around math, code and links without duplicating or dropping their content', () => {
  const prose = Array.from({ length: 24 }, (_, index) => `The result ${index} follows from $x_i$ and \`code\`, as shown in [the study](https://example.com).`).join(' ');
  const blocks = createBlocks(prose);
  const flatten = node => typeof node.value === 'string' ? node.value : (node.children ?? []).map(flatten).join('');
  assert.ok(blocks.length > 2);
  assert.ok(blocks.every(block => flatten(block.node).length <= 380));
  assert.equal(blocks.map(block => flatten(block.node)).join(''), prose.replace(/\$|`|\[|\]\([^)]*\)/g, ''));
  assert.ok(blocks.some(block => JSON.stringify(block.node).includes('inlineMath')));
  assert.ok(blocks.some(block => JSON.stringify(block.node).includes('inlineCode')));
});

test('Older pending long paragraphs are re-chunked while translated blocks remain untouched', () => {
  const oldChunks = createBlocks('Long pending sentence. '.repeat(30));
  const pending = { ...oldChunks[0], id: 'old-b0', node: { ...oldChunks[0].node, children: oldChunks.flatMap(block => block.node.children) }, values: {}, edit: null };
  const [translated] = createBlocks('Already saved. '.repeat(10));
  translated.values = Object.fromEntries(units(translated).map(unit => [unit.id, unit.text]));
  const blocks = rechunkPendingBlocks([pending, translated]);
  assert.ok(blocks.length > 2);
  assert.ok(blocks.slice(0, -1).every(block => block.id.startsWith(`${pending.id}-`)));
  assert.equal(blocks.at(-1), translated);
  assert.equal(blockDone(blocks.at(-1)), true);
});

test('Cached translations survive restart and old numeric notices are absent from views and exports', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paperbridge-cache-test-'));
  try {
    const doc = { id: 'sample', blocks: createBlocks('Section 2 and **3**.\n\nNext paragraph.'), readingQueue: [] };
    const block = doc.blocks[0], segments = units(block);
    block.values = validateTranslations(segments, segments.map(unit => ({ id: unit.id, text: unit.text.replace('2', '二') })));
    block.numberWarnings = { legacy: '数字待核对 · 译文已保存' };
    await atomic(path.join(dir, 'document.json'), JSON.stringify(doc));
    const restored = JSON.parse(await fs.readFile(path.join(dir, 'document.json'), 'utf8'));
    assert.equal(blockDone(restored.blocks[0]), true);
    assert.deepEqual(pendingUnits(restored.blocks[0]), []);
    prioritizeQueue(restored, ['b0', 'b1', 'b0']);
    assert.deepEqual(restored.readingQueue, ['b1']);
    assert.equal('review' in view(restored).progress, false);
    assert.equal('numberWarnings' in view(restored).blocks[0], false);
    assert.doesNotMatch(exportMarkdown(restored, 'translated'), /数字待核对|译文已保存/);
    restored.blocks[0].edit = '人工修改的译文';
    assert.deepEqual(pendingUnits(restored.blocks[0]), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Folder Markdown resolves local images without changing source, math or ordinary links', () => {
  const doc = { blocks: createBlocks(String.raw`# Paper

![Figure](images/figure.png)

![Reference figure][pic] and [Website][site]. Formula $x=2$.

[pic]: images/reference.png
[site]: https://example.com

<table><tr><td><img src="images/table.png?x=1&amp;y=2"><img src="https://example.com/remote.png">$y=3$</td></tr></table>`) };
  const original = structuredClone(doc);
  const parsed = exportMarkdown(doc, 'original', 'content/');
  assert.match(parsed, /content\/images\/figure\.png/);
  assert.match(parsed, /\[pic\]: content\/images\/reference\.png/);
  assert.match(parsed, /src="content\/images\/table\.png\?x=1&amp;y=2"/);
  assert.match(parsed, /src="https:\/\/example\.com\/remote\.png"/);
  assert.match(parsed, /\[site\]: https:\/\/example\.com/);
  assert.match(parsed, /\$x=2\$/); assert.match(parsed, /\$y=3\$/);
  assert.deepEqual(doc, original, 'Writing folder Markdown must not mutate the document or its cache');
  assert.doesNotMatch(exportMarkdown(doc, 'original'), /content\/images/);
  assert.match(exportMarkdown(doc, 'translated', 'content/'), /本段尚未完整翻译/);
});
