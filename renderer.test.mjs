import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createBlocks, view, progress, units } from './document.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const screenshots = path.join(here, 'artifacts');
mkdirSync(screenshots, { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), 'paperbridge-render-test-'));
protocol.registerSchemesAsPrivileged([{ scheme: 'paper', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setPath('userData', profile);
const doc = { id: 'fixture', title: 'Render fixture', kind: 'md', status: '待翻译', error: '', usage: {},
  blocks: createBlocks(Array.from({ length: 50 }, (_, i) => `Paragraph ${i}. **Formatted text**. ` + 'The original paragraph must remain stable while translations arrive. '.repeat(3)).join('\n\n')), readingQueue: [] };
let active = null, documentReads = 0, starts = 0, settingsWrites = 0, connectionTests = 0, failSave = false, translationReady = true, initialReadingBlocks = [];
const translationCalls = [];
const themes = [];
let contextAction = 'open', deleteConfirmed = false, documentDeleted = false;
let clearConfirmed = false;
const clearCalls = [];
const folderCalls = [], deleteCalls = [], renameCalls = [];
const clipboardCalls = [];
const externalCalls = [];
let config = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-test', sourceLang: 'English', targetLang: '简体中文',
  provider: 'chat', localBaseUrl: 'http://127.0.0.1:11434/v1', localModel: '', localBatchCharacters: 3000, localTranslateKey: '',
  cloudBatchSegments: 20, cloudBatchCharacters: 4000, cloudRequestIntervalSeconds: 3.1,
  glossary: '', minerModel: 'vlm', ocrLang: 'en', ocr: false, minerKey: 'fixture-miner-key', translateKey: 'fixture-chat-key',
  hasMinerKey: true, hasTranslationKey: true, secureStorage: true };
for (const [name, handler] of Object.entries({
  library: () => ({ items: documentDeleted ? [] : [{ ...doc, blocks: undefined, progress: progress(doc) }], active, parserReady: true, translationReady }),
  documentMenu: () => contextAction,
  documentFolder: id => { folderCalls.push(id); },
  renameDocument: (id, title) => { renameCalls.push([id, title]); doc.title = title; return title; },
  deleteDocument: id => { deleteCalls.push(id); if (!deleteConfirmed) return false; documentDeleted = true; return true; },
  clearTranslations: id => {
    clearCalls.push(id); if (!clearConfirmed) return false;
    active = null;
    for (const block of doc.blocks) { block.values = {}; block.edit = null; block.error = ''; }
    doc.readingQueue = []; doc.usage = {}; doc.error = ''; doc.status = '已暂停';
    return true;
  },
  settings: () => config,
  copyText: text => { clipboardCalls.push(text); },
  external: url => { externalCalls.push(url); },
  setTheme: theme => { themes.push(theme); return theme; },
  saveSettings: data => { settingsWrites++; if (failSave) throw new Error('保存失败示例'); config = { ...config, ...data }; return config; },
  testConnection: () => { connectionTests++; translationReady = true; return '连接正常'; },
  pause: () => { active = null; doc.status = '已暂停'; return '已暂停'; },
  document: () => { documentReads++; return view(doc); }, sample: () => doc.id, enqueueReading: () => {},
  translate: (...args) => { translationCalls.push(args); return '已开始翻译'; },
  startReading: (_id, ids) => { starts++; initialReadingBlocks = ids; translationReady = false; doc.error = ''; doc.status = '正在翻译'; active = { id: doc.id, kind: 'reading', queue: ids }; return { started: true }; },
})) ipcMain.handle(name, async (_event, ...args) => { try { return { ok: true, data: await handler(...args) }; } catch (error) { return { ok: false, error: error.message }; } });

let win;
async function evaluate(code) {
  try { return await win.webContents.executeJavaScript(code); }
  catch (error) { throw new Error(`${error.message}\nUI check: ${code.slice(0, 350)}`); }
}
async function until(code) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(code)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${code}`);
}
async function update(marker) {
  doc.status = marker; win.webContents.send('update', { id: doc.id });
  await until(`document.querySelector('#status').textContent === ${JSON.stringify(marker)}`);
}
async function checkReferenceBack(selector) {
  try { await until(`(() => {
    const button = document.querySelector('#reference-back'), rect = button.getBoundingClientRect(), reader = document.querySelector('#reader').getBoundingClientRect();
    const header = document.querySelector('#reading-columns'), top = reader.top + (header.hidden ? 0 : header.offsetHeight);
    const target = ${selector ? `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()` : 'null'};
    return !button.hidden && !button.closest('.app-titlebar') && getComputedStyle(button).position === 'fixed' && rect.height >= 42 && parseFloat(getComputedStyle(button).fontSize) >= 14 &&
      rect.left >= reader.left && rect.right <= reader.right && rect.top >= top && rect.bottom <= reader.bottom && (!target || (target.top-rect.bottom >= 8 && target.top-rect.bottom <= 12));
  })()`); } catch (error) {
    throw new Error(`${error.message}\n${await evaluate(`JSON.stringify({button:document.querySelector('#reference-back').getBoundingClientRect(),reader:document.querySelector('#reader').getBoundingClientRect(),hidden:document.querySelector('#reference-back').hidden,columns:document.querySelector('#reading-columns').offsetHeight})`)}`);
  }
}
app.whenReady().then(async () => {
try {
  protocol.handle('paper', () => new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD4sAAAAASUVORK5CYII=', 'base64'), { headers: { 'Content-Type': 'image/png' } }));
  win = new BrowserWindow({ show: false, width: 1380, height: 920, webPreferences: { preload: path.join(here, 'preload.cjs'), backgroundThrottling: false } });
  await win.loadFile(path.join(here, 'index.html'));
  await evaluate(`document.querySelector('#sample').click()`);
  await until(`document.querySelectorAll('#blocks > article').length === 50`);
  assert.equal(await evaluate(`!document.querySelector('.delete-document') && document.querySelectorAll('.document-row button').length === document.querySelectorAll('.document-item').length`), true, 'Library rows have no standalone delete button');
  await until(`document.querySelector('#local-save-state').textContent.length > 0`);
  assert.equal(starts, 1, 'Opening a document should start edge translation automatically');
  assert.equal(await evaluate(`!document.querySelector('.document-header') && !document.querySelector('#document-kind') && !document.body.textContent.includes('自动保存到本机')`), true, 'The extra document information strip is removed');
  assert.equal(await evaluate(`document.querySelector('[name="model"]').closest('label').textContent === '使用的模型名称' && document.querySelector('[name="localModel"]').closest('label').textContent === '使用的模型名称'`), true);
  assert.ok(initialReadingBlocks.length, 'The visible paragraphs should be queued on open');
  assert.equal(await evaluate(`!document.querySelector('#translate-all').hidden && !document.querySelector('#translate')`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#reader')).overflowAnchor === 'none'`), true,
    'The browser and the manual reading-position keeper should not both adjust the scroll position');
  const leakedLabels = await evaluate(`[...document.querySelectorAll('.block-label')].map(node => node.textContent).filter(text => /已翻译|尚未翻译/.test(text))`); assert.deepEqual(leakedLabels, []);
  assert.equal(await evaluate(`!document.querySelector('#font-size') && !!document.querySelector('#font-size-control')`), true);
  assert.equal(await evaluate(`document.querySelector('#blocks').dataset.mode === 'parallel' && !document.querySelector('#reading-columns').hidden`), true, 'New readers default to side-by-side comparison');
  assert.equal(await evaluate(`['translate-all','more','export','immersive-toggle','document-find'].every(id => document.querySelector('.app-titlebar').contains(document.getElementById(id)))`), true, 'Reading actions stay in the top bar');
  assert.equal(await evaluate(`document.querySelector('#original').textContent === '原文件 ↗'`), true);
  assert.equal(await evaluate(`(() => { const left = document.querySelector('#immersive-toggle').getBoundingClientRect(), right = document.querySelector('#document-find').getBoundingClientRect(); const blank = document.elementFromPoint((left.right + right.left) / 2, (right.top + right.bottom) / 2); return right.left > left.right && blank === document.querySelector('.reading-controls') && getComputedStyle(blank).getPropertyValue('-webkit-app-region') === 'drag' && [...document.querySelectorAll('.app-titlebar button')].every(button => getComputedStyle(button).getPropertyValue('-webkit-app-region') === 'no-drag'); })()`), true, 'Top-bar empty space is draggable while buttons remain clickable');
  assert.equal(await evaluate(`['import','settings-open'].every(id => document.querySelector('.sidebar').contains(document.getElementById(id))) && document.querySelector('.sidebar').firstElementChild.id === 'settings-open' && document.querySelector('#import').previousElementSibling.id === 'library' && document.querySelector('#document-find').previousElementSibling.id === 'immersive-toggle'`), true, 'Settings and import belong to the library, search follows the reading actions');
  assert.equal(await evaluate(`document.querySelector('#import').getBoundingClientRect().top >= document.querySelector('#library').getBoundingClientRect().bottom && document.querySelector('#import').getBoundingClientRect().bottom < innerHeight`), true, 'Import is visible directly below the document list');
  assert.equal(await evaluate(`document.querySelector('#settings-open').textContent.includes('API 与偏好设置') && document.querySelector('#settings-open').getBoundingClientRect().width > 100 && document.querySelector('#theme-toggle').closest('.app-titlebar') !== null`), true, 'Settings has a prominent text label and the theme switch is always accessible');
  assert.equal(await evaluate(`document.documentElement.dataset.theme === 'light' && document.querySelector('#theme-toggle').textContent.includes('白天') && !document.querySelector('.number-warning') && !document.body.textContent.includes('数字待核对')`), true, 'Fresh profiles default to daylight');
  assert.equal(await evaluate(`document.title === '早日发Paper' && document.querySelector('.app-brand').textContent === '早日发Paper' && !document.querySelector('.app-brand svg, .app-brand img')`), true, 'Product name has no preceding software icon');
  await evaluate(`document.querySelector('#theme-toggle').click()`); await until(`document.documentElement.dataset.theme === 'dark'`);
  await evaluate(`document.querySelector('[data-mode="bilingual"]').click()`);
  await until(`document.querySelector('#blocks').dataset.mode === 'bilingual'`);
  await evaluate(`document.querySelector('#settings-open').click()`);
  await until(`document.querySelector('#settings-dialog').open`);
  await evaluate(`document.querySelector('#about-open').click()`);
  assert.equal(await evaluate(`document.querySelector('#about-dialog').open && document.querySelector('.about-content').textContent === '软件的作者是国富贵儿，苦于看不懂英文，特此开发此软件。如有需求建议可以通过以下方式联系到我1919429703@qq.com。祝您天天开心'`), true);
  win.setSize(720, 480);
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  assert.equal(await evaluate(`(() => { const rect = document.querySelector('#about-dialog').getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; })()`), true, 'Author dialog fits the smaller window');
  await evaluate(`document.querySelector('[data-close="about-dialog"]').click()`);
  assert.equal(await evaluate(`!document.querySelector('#about-dialog').open && document.querySelector('#settings-dialog').open`), true, 'Closing About returns to settings without discarding configuration');
  assert.equal(await evaluate(`(() => { const close = document.querySelector('#settings-close').getBoundingClientRect(), footer = document.querySelector('#settings-dialog .dialog-actions').getBoundingClientRect(); return close.top >= 0 && close.right <= innerWidth && footer.bottom <= innerHeight; })()`), true, 'Settings close and footer remain reachable at the smaller window size');
  win.setSize(1380, 920);
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  assert.equal(await evaluate(`!document.querySelector('#parser-config').open && !document.querySelector('#translation-config').open && document.querySelector('[name="model"]').value === 'glm-test'`), true, 'Both configurations start collapsed while saved values remain loaded');
  assert.equal(await evaluate(`['cloudBatchSegments','cloudBatchCharacters','cloudRequestIntervalSeconds'].every(name => document.querySelector('#cloud-translation-fields').contains(document.querySelector('[name="' + name + '"]'))) && document.querySelector('[name="cloudBatchSegments"]').value === '20' && document.querySelector('[name="cloudRequestIntervalSeconds"]').min === '0'`), true);
  await evaluate(`document.querySelector('#parser-config > summary').click(); document.querySelector('#translation-config > summary').click()`);
  assert.equal(await evaluate(`document.querySelector('#parser-config .config-fields').firstElementChild.id === 'parser-api-link' && document.querySelector('#parser-api-link').textContent === '文档解析api申请网址'`), true);
  await evaluate(`document.querySelector('#parser-api-link').click()`);
  assert.deepEqual(externalCalls, ['https://mineru.net/apiManage/docs']);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.config-fields')).backgroundColor !== getComputedStyle(document.querySelector('.config-card > summary')).backgroundColor && parseFloat(getComputedStyle(document.querySelector('.config-fields')).marginLeft) > 0`), true);
  assert.equal(await evaluate(`document.querySelector('[name="translateKey"]').type === 'password' && document.querySelector('[name="minerKey"]').type === 'password'`), true);
  await evaluate(`document.querySelector('[data-secret-toggle="translateKey"]').click(); document.querySelector('[data-secret-toggle="minerKey"]').click(); document.querySelector('.settings-scroll').scrollTop = document.querySelector('.settings-scroll').scrollHeight`);
  assert.equal(await evaluate(`document.querySelector('[name="translateKey"]').type === 'text' && document.querySelector('[name="minerKey"]').type === 'text' && document.querySelector('#settings-close').getBoundingClientRect().top >= document.querySelector('#settings-dialog').getBoundingClientRect().top`), true);
  failSave = true;
  await evaluate(`document.querySelector('[name="model"]').value = 'new-model'; document.querySelector('[name="model"]').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#test-connection').click()`);
  await until(`document.querySelector('#settings-result').textContent.includes('测试失败')`);
  assert.equal(connectionTests, 0, 'A failed configuration save must not test stale settings');
  await evaluate(`document.querySelector('#settings-close').click()`);
  await until(`!document.querySelector('#settings-dialog').open`);
  assert.equal(config.model, 'glm-test');
  assert.match(await evaluate(`document.querySelector('#toast').textContent`), /未保存.*保留/);
  await evaluate(`document.querySelector('#settings-open').click()`);
  await until(`document.querySelector('#settings-dialog').open`);
  assert.equal(await evaluate(`document.querySelector('[name="model"]').value === 'new-model' && document.querySelector('[name="translateKey"]').type === 'password' && document.querySelector('[name="minerKey"]').type === 'password'`), true, 'Failed draft survives reopen while keys are masked');
  await evaluate(`document.querySelector('#settings-dialog').dispatchEvent(new Event('cancel', {cancelable:true}))`);
  await until(`!document.querySelector('#settings-dialog').open`);
  await evaluate(`document.querySelector('#settings-open').click()`);
  await until(`document.querySelector('#settings-dialog').open`);
  failSave = false;
  const beforeSave = settingsWrites;
  await evaluate(`document.querySelector('#settings-close').click()`);
  await until(`!document.querySelector('#settings-dialog').open`);
  assert.ok(settingsWrites > beforeSave, 'Closing retries the retained draft after a transient save failure');
  assert.equal(config.model, 'new-model');
  await evaluate(`document.querySelector('#settings-open').click()`);
  await until(`document.querySelector('#settings-dialog').open`);
  await evaluate(`document.querySelector('#translation-config > summary').click(); document.querySelector('[name="provider"]').value = 'local-api'; document.querySelector('[name="provider"]').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('[name="localModel"]').value = 'local-test'; document.querySelector('[name="localModel"]').dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.equal(await evaluate(`document.querySelector('#translation-config').contains(document.querySelector('[name="provider"]')) && !document.querySelector('#local-translation-fields').hidden && document.querySelector('#cloud-translation-fields').disabled && document.querySelector('[name="localTranslateKey"]').type === 'password'`), true,
    'Local configuration belongs inside the model translation section and does not submit cloud keys');
  win.showInactive();
  await evaluate(`document.title = '早日发Paper · 界面测试'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  writeFileSync(path.join(screenshots, 'paperbridge-local-settings-test.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  win.hide();
  await evaluate(`document.querySelector('#settings-close').click()`);
  await until(`!document.querySelector('#settings-dialog').open`);
  assert.equal(config.provider, 'local-api'); assert.equal(config.localModel, 'local-test');
  assert.equal(config.translateKey, 'fixture-chat-key'); assert.equal(config.model, 'new-model');
  await evaluate(`document.querySelector('#settings-open').click()`);
  await until(`document.querySelector('#settings-dialog').open`);
  assert.equal(await evaluate(`document.querySelector('[name="provider"]').value === 'local-api' && document.querySelector('[name="localModel"]').value === 'local-test' && !document.querySelector('#local-translation-fields').hidden`), true,
    'Opening settings restores the active local configuration');
  await evaluate(`document.querySelector('[name="provider"]').value = 'chat'; document.querySelector('[name="provider"]').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#settings-close').click()`);
  await until(`!document.querySelector('#settings-dialog').open`);
  assert.equal(config.localModel, 'local-test'); assert.equal(config.model, 'new-model');
  await evaluate(`document.querySelector('#settings-open').click()`);
  await until(`document.querySelector('#settings-dialog').open`);
  await evaluate(`document.querySelector('[name="provider"]').value = 'edge'; document.querySelector('[name="provider"]').dispatchEvent(new Event('change',{bubbles:true}));`);
  assert.equal(await evaluate(`document.querySelector('#translation-config summary').textContent.includes('翻译配置') && !document.querySelector('#edge-translation-fields').hidden && document.querySelector('#cloud-translation-fields').disabled && document.querySelector('#local-translation-fields').disabled && document.querySelector('[name="glossary"]').disabled`), true);
  await evaluate(`document.querySelector('#settings-close').click()`); await until(`!document.querySelector('#settings-dialog').open`);
  assert.equal(config.provider, 'edge'); assert.equal(config.translateKey, 'fixture-chat-key');
  await evaluate(`document.querySelector('#settings-open').click()`); await until(`document.querySelector('#settings-dialog').open`);
  assert.equal(await evaluate(`document.querySelector('[name="provider"]').value === 'edge' && !document.querySelector('#edge-translation-fields').hidden`), true);
  await evaluate(`document.querySelector('[name="provider"]').value = 'chat'; document.querySelector('[name="provider"]').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#settings-close').click()`);
  await until(`!document.querySelector('#settings-dialog').open`);
  assert.equal(await evaluate(`document.querySelector('#document-toolbar').parentElement.classList.contains('reading-controls') && document.querySelector('#sidebar-toggle').parentElement.classList.contains('app-titlebar') && document.querySelector('#outline-toggle').parentElement.id === 'outline-wrap' && document.querySelector('#settings-dialog').firstElementChild.id === 'settings-close'`), true);
  assert.equal(await evaluate(`(() => { const button = document.querySelector('#outline-toggle').getBoundingClientRect(), pane = document.querySelector('#outline-wrap').getBoundingClientRect(); return button.top >= pane.top && Math.abs(button.right - pane.right) < 30; })()`), true, 'Outline fold button must stay on its pane edge');
  assert.equal(await evaluate(`!!document.querySelector('#outline-toggle svg') && !!document.querySelector('#sidebar-toggle svg') && getComputedStyle(document.querySelector('#outline-toggle')).borderTopWidth === '0px' && document.querySelector('#outline-toggle').textContent.trim() === '隐藏目录'`), true, 'Outline toggle has a clear text label and remains borderless');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#b0 .block-tools')).display === 'none'`), true, 'Paragraph actions should stay hidden until the paragraph is clicked');
  await evaluate(`document.querySelector('#b20').click(); window.savedSource = document.querySelector('#b20 .source'); window.savedCard = savedSource.parentNode; window.savedOutline = document.querySelector('#outline').firstChild; window.savedLabel = savedCard.querySelector('.block-tools'); document.querySelector('#reader').scrollTop += savedSource.getBoundingClientRect().top - document.querySelector('#reader').getBoundingClientRect().top + 20; window.savedY = savedSource.getBoundingClientRect().top; const range = document.createRange(); range.selectNodeContents(savedSource.querySelector('strong')); getSelection().removeAllRanges(); getSelection().addRange(range);`);
  assert.equal(await evaluate(`getComputedStyle(savedLabel).display === 'flex' && savedCard.classList.contains('selected')`), true);
  active = { id: doc.id, kind: 'reading', currentBlock: 'b0', queue: ['b0'] };
  await update('Status only');
  assert.equal(await evaluate(`savedSource === document.querySelector('#b20 .source') && savedCard === document.querySelector('#b20') && savedOutline === document.querySelector('#outline').firstChild && getSelection().toString() === 'Formatted text'`), true);
  const first = doc.blocks[0];
  first.values[units(first)[0].id] = '部分译文';
  await update('Partial');
  assert.equal(await evaluate(`document.querySelector('#b0 .target').hidden`), true);
  for (const unit of units(first)) first.values[unit.id] = '完成的译文。'.repeat(20);
  await update('Complete above viewport');
  assert.equal(await evaluate(`!document.querySelector('#b0 .target').hidden`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#b0 .target')).backgroundColor === 'rgb(20, 38, 56)' && parseFloat(getComputedStyle(document.querySelector('#b0 .target')).borderLeftWidth) > 0`), true,
    'Translated text should have a distinct framed background');
  assert.ok(await evaluate(`Math.abs(savedSource.getBoundingClientRect().top - savedY) < 1`), 'Visible source jumped when translation arrived above it');
  assert.equal(await evaluate(`savedSource === document.querySelector('#b20 .source') && getSelection().toString() === 'Formatted text'`), true);
  await evaluate(`(() => { const drag = (id, x) => { document.getElementById(id).dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:x, buttons:1})); window.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:x+40, buttons:1})); window.dispatchEvent(new MouseEvent('mouseup', {bubbles:true})); }; drag('sidebar-splitter', 272); drag('outline-splitter', 155); })()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.sidebar')).width === '304px' && getComputedStyle(document.querySelector('#outline-wrap')).flexBasis === '230px'`), true,
    'Dragging either separator should resize and retain its pane width');
  await evaluate(`document.querySelector('#sidebar-splitter').dispatchEvent(new MouseEvent('mousedown', {bubbles:true,clientX:304,buttons:1})); window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:160,buttons:1})); window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.sidebar')).width === '160px' && !document.body.classList.contains('sidebar-collapsed')`), true, 'Library can shrink below the former 200px minimum');
  await evaluate(`document.querySelector('#sidebar-splitter').dispatchEvent(new MouseEvent('mousedown', {bubbles:true,clientX:160,buttons:1})); window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:100,buttons:1})); window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); document.querySelector('#outline-splitter').dispatchEvent(new MouseEvent('mousedown', {bubbles:true,clientX:230,buttons:1})); window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:80,buttons:1})); window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));`);
  assert.equal(await evaluate(`document.body.classList.contains('sidebar-collapsed') && document.body.classList.contains('outline-collapsed') && getComputedStyle(document.querySelector('#outline-wrap')).flexBasis === '0px' && document.querySelector('#outline-toggle').textContent.trim() === '打开目录' && localStorage.getItem('outlineHidden') === 'true' && !document.body.classList.contains('resizing-panes')`), true, 'Dragging to either minimum auto-hides the pane and releases its width');
  await evaluate(`document.querySelector('#sidebar-toggle').click(); document.querySelector('#outline-toggle').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.sidebar')).width === '160px' && getComputedStyle(document.querySelector('#outline-wrap')).flexBasis === '230px' && document.querySelector('#outline-toggle').textContent.trim() === '隐藏目录'`), true, 'Opening restores the last usable widths and label');
  await evaluate(`document.querySelector('#sidebar-splitter').dispatchEvent(new MouseEvent('mousedown', {bubbles:true,clientX:160,buttons:1})); window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:304,buttons:1})); window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));`);
  await evaluate(`document.querySelector('#sidebar-toggle').click(); document.querySelector('#outline-toggle').click()`);
  assert.equal(await evaluate(`document.body.classList.contains('sidebar-collapsed') && document.body.classList.contains('outline-collapsed')`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.sidebar')).flexBasis === '0px'`), true,
    'Collapsing the document pane should actually release its flex width');
  assert.equal(await evaluate(`document.querySelector('#outline-toggle').getAttribute('aria-expanded') === 'false' && getComputedStyle(document.querySelector('#outline-wrap')).backgroundColor === 'rgba(0, 0, 0, 0)'`), true);
  const fontWheel = await evaluate(`(() => { const before = getComputedStyle(document.querySelector('#b20 .source')).fontSize; const event = new WheelEvent('wheel', {deltaY:-100,ctrlKey:true,bubbles:true,cancelable:true}); document.dispatchEvent(event); return {before, after:getComputedStyle(document.querySelector('#b20 .source')).fontSize, prevented:event.defaultPrevented}; })()`);
  assert.ok(parseFloat(fontWheel.after) > parseFloat(fontWheel.before) && fontWheel.prevented, JSON.stringify(fontWheel));
  await evaluate(`document.querySelector('#immersive-toggle').click()`);
  assert.equal(await evaluate(`document.body.classList.contains('immersive') && document.querySelector('.immersive .reader').clientWidth > document.querySelector('.reading-layout').clientWidth * .8 && getComputedStyle(document.querySelector('.immersive .statusbar')).display !== 'none'`), true);
  await evaluate(`document.querySelector('#immersive-toggle').click(); document.querySelector('#sidebar-toggle').click(); document.querySelector('#outline-toggle').click()`);
  await evaluate(`window.savedY = savedSource.getBoundingClientRect().top`);
  const middle = doc.blocks[20];
  for (const unit of units(middle)) middle.values[unit.id] = '当前段落的完整译文。'.repeat(10);
  await update('Complete visible paragraph');
  assert.ok(await evaluate(`Math.abs(savedSource.getBoundingClientRect().top - savedY) < 1`));
  assert.equal(await evaluate(`savedSource === document.querySelector('#b20 .source') && savedLabel === document.querySelector('#b20 .block-tools')`), true);
  const next = doc.blocks[21]; next.values[units(next)[0].id] = '暂停时的部分译文';
  active = null; await update('Paused');
  assert.equal(await evaluate(`!document.querySelector('#b21 .target').hidden`), true);
  const before = documentReads;
  for (let i = 0; i < 20; i++) win.webContents.send('update', { id: doc.id });
  await update('Burst');
  assert.equal(documentReads - before, 1, 'A burst of notifications should produce a single document refresh');
  translationReady = true; active = null; doc.error = 'HTTP 429：服务限流';
  const beforeFailure = starts;
  await update('需要处理');
  assert.equal(starts, beforeFailure, 'A failed translation must not automatically retry and call the paid API again');
  translationReady = true; doc.error = '';
  await update('已暂停');
  assert.equal(starts, beforeFailure, 'A manually paused translation must stay paused until the user resumes it');
  await evaluate(`document.querySelector('#settings-open').click()`);
  await until(`document.querySelector('#settings-dialog').open`);
  await evaluate(`document.querySelector('#settings-close').click()`);
  await until(`!document.querySelector('#settings-dialog').open`);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(starts, beforeFailure, 'Opening unchanged settings must preserve a manual pause');
  doc.error = '翻译设置已改变。'; await update('需要处理');
  await evaluate(`document.querySelector('#settings-open').click()`);
  await until(`document.querySelector('#settings-dialog').open`);
  await evaluate(`document.querySelector('#translation-config').open = true; document.querySelector('[name="baseUrl"]').value = 'https://api.deepseek.com'; document.querySelector('[name="model"]').value = 'deepseek-chat'; document.querySelector('[name="cloudBatchSegments"]').value = '5'; document.querySelector('[name="cloudBatchCharacters"]').value = '1500'; document.querySelector('[name="cloudRequestIntervalSeconds"]').value = '6'; document.querySelector('[name="model"]').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#test-connection').click()`);
  await until(`document.querySelector('#settings-result').textContent === '连接正常'`);
  await evaluate(`document.querySelector('#settings-close').click()`);
  for (let i = 0; i < 150 && starts !== beforeFailure + 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(starts, beforeFailure + 1, 'A successful model test resumes stalled reading on close');
  assert.equal(config.model, 'deepseek-chat'); assert.equal(doc.error, '');
  translationReady = true; await update('正在翻译');
  await evaluate(`document.querySelector('#settings-open').click()`);
  await until(`document.querySelector('#settings-dialog').open`);
  assert.equal(active, null);
  assert.equal(await evaluate(`document.querySelector('[name="cloudBatchSegments"]').value === '5' && document.querySelector('[name="cloudBatchCharacters"]').value === '1500' && document.querySelector('[name="cloudRequestIntervalSeconds"]').value === '6'`), true, 'Cloud sending settings are restored on reopen');
  await evaluate(`document.querySelector('#settings-close').click()`);
  for (let i = 0; i < 150 && starts !== beforeFailure + 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(starts, beforeFailure + 2, 'Reading paused by opening settings resumes when settings close');
  translationReady = true;
  for (const block of doc.blocks) for (const unit of units(block)) block.values[unit.id] = '本地已有译文';
  active = { id: doc.id, kind: 'reading', currentBlock: null, queue: doc.blocks.slice(-6).map(block => block.id) };
  doc.readingQueue = [...active.queue];
  await update('翻译完成');
  assert.equal(await evaluate(`!document.querySelector('#queue-panel, #queue-summary, #queue-list, .local-indicator, .sidebar-footer') && !document.body.textContent.includes('段排队') && !document.body.textContent.includes('文档与译文保存在本机')`), true,
    'Queue and local-save indicators are removed even when backend queue snapshots change');
  active = null; doc.error = ''; await update('准备重译校验');
  await evaluate(`window.confirmCalls = 0; window.confirm = () => { window.confirmCalls++; return false; }; document.querySelector('#more').click()`);
  await until(`!document.querySelector('#more').disabled`);
  assert.deepEqual(translationCalls[0], [doc.id, null, true]);
  await evaluate(`document.querySelector('#b0').click(); [...document.querySelectorAll('#b0 .block-tools button')].find(button => button.textContent === '重译').click()`);
  await until(`!document.querySelector('#b0 .block-tools button:last-child').disabled`);
  assert.deepEqual(translationCalls[1], [doc.id, 'b0']); assert.equal(await evaluate(`window.confirmCalls`), 0);
  await evaluate(`document.querySelector('[data-mode="parallel"]').click()`);
  await until(`document.querySelector('#blocks').dataset.mode === 'parallel'`);
  assert.equal(await evaluate(`(() => { const source=document.querySelector('#b0 .source').getBoundingClientRect(), target=document.querySelector('#b0 .target').getBoundingClientRect(); return target.left > source.right && Math.abs(source.top-target.top)<1 && Math.abs(source.width-target.width)<1; })()`), true, 'Source and translation align in equal-width columns');
  const parallelSource = await evaluate(`document.querySelector('#b0 .source').textContent`);
  await evaluate(`document.querySelector('[data-mode="bilingual"]').click()`); await until(`document.querySelector('#blocks').dataset.mode === 'bilingual'`);
  assert.equal(await evaluate(`document.querySelector('#b0 .source').textContent`), parallelSource);
  await evaluate(`document.querySelector('[data-mode="parallel"]').click(); document.querySelector('#outline-toggle').click(); document.querySelector('#reader').scrollTop = 0`);
  await until(`document.querySelector('#blocks').dataset.mode === 'parallel'`);
  await until(`document.querySelector('button[data-mode="parallel"]').classList.contains('active') && !document.querySelector('button[data-mode="parallel"]').disabled`);
  win.showInactive(); await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await new Promise(resolve => setTimeout(resolve, 200));
  writeFileSync(path.join(screenshots, 'paperbridge-parallel-reader-test.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  win.hide();
  doc.title = '预测误差指标';
  doc.blocks = createBlocks(String.raw`<table><caption>Forecast accuracy</caption><tr><th>Metric</th><th>Definition</th><th>Advantages</th></tr><tr><td>MAE</td><td>$MAE = \frac{1}{n}\sum_{i=1}^{n}|y_i-\hat{y}_i|$</td><td>Intuitive and easy to understand.</td></tr><tr><td>MSE</td><td>\(MSE = \frac{1}{n}\sum_{i=1}^{n}(y_i-\hat{y}_i)^2\)</td><td>Sensitive to large errors.</td></tr><tr><td colspan="2"><code>$literal_code$</code></td><td onclick="alert(1)">Safe text<script>alert(1)</script><a href="javascript:alert(1)">Unsafe link</a></td></tr></table>

| Metric | Formula |
| --- | --- |
| Energy | $E=mc^2$ |`);
  const labels = { 'Forecast accuracy': '预测精度', Metric: '指标', Definition: '定义', Advantages: '优点', 'Intuitive and easy to understand.': '直观且易于理解。', 'Sensitive to large errors.': '对较大的误差敏感。' };
  for (const block of doc.blocks) block.values = Object.fromEntries(units(block).map(unit => [unit.id, labels[unit.text] ?? unit.text]));
  doc.readingQueue = []; await update('表格翻译完成');
  assert.equal(await evaluate(`document.querySelector('#b0 .target th').textContent === '指标' && document.querySelector('#b0 .target caption').textContent === '预测精度'`), true);
  assert.equal(await evaluate(`document.querySelectorAll('#b0 .source td .katex').length === 2 && document.querySelectorAll('#b0 .target td .katex').length === 2 && !document.querySelector('#b0 .katex-error')`), true, 'Both dollar and bracket formulas render inside HTML table cells');
  assert.equal(await evaluate(`document.querySelectorAll('#b1 .katex').length === 2 && !document.querySelector('.katex .katex')`), true, 'Markdown table formulas still render once in each language');
  assert.equal(await evaluate(`document.querySelector('#b0 .source code').textContent === '$literal_code$' && !document.querySelector('#b0 .source code .katex') && document.querySelector('#b0 .target td[colspan="2"]') !== null`), true);
  assert.equal(await evaluate(`!document.querySelector('#blocks [onclick], #blocks script, #blocks a[href^="javascript:"]')`), true, 'Untrusted table HTML must remain sanitized after math rendering');
  await evaluate(`document.querySelector('[data-mode="bilingual"]').click(); document.querySelector('#reader').scrollTop = 0`);
  await until(`document.querySelector('#blocks').dataset.mode === 'bilingual'`);
  win.showInactive(); await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await new Promise(resolve => setTimeout(resolve, 200));
  writeFileSync(path.join(screenshots, 'paperbridge-table-math-test.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  win.hide();
  await evaluate(`window.themeSource = document.querySelector('#b0 .source'); document.querySelector('#theme-toggle').click()`);
  await until(`document.documentElement.dataset.theme === 'light'`);
  assert.equal(await evaluate(`document.querySelector('#theme-toggle').textContent.includes('白天') && !document.querySelector('#theme-toggle').textContent.includes('黑夜') && document.querySelector('#theme-toggle').title.includes('切换黑夜')`), true);
  assert.equal(await evaluate(`getComputedStyle(document.body).backgroundColor === 'rgb(247, 249, 252)' && getComputedStyle(document.querySelector('#b0 .target')).backgroundColor === 'rgb(237, 248, 247)' && getComputedStyle(document.querySelector('#settings-open')).backgroundColor !== getComputedStyle(document.querySelector('.app-titlebar')).backgroundColor && themeSource === document.querySelector('#b0 .source')`), true);
  assert.equal(themes.at(-1), 'light');
  win.showInactive(); await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`); await new Promise(resolve => setTimeout(resolve, 200));
  writeFileSync(path.join(screenshots, 'paperbridge-day-theme-test.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG()); win.hide();
  await evaluate(`document.querySelector('#settings-open').click()`); await until(`document.querySelector('#settings-dialog').open`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#settings-dialog')).backgroundColor === 'rgb(255, 255, 255)' && !document.querySelector('#parser-config').open && !document.querySelector('#translation-config').open`), true);
  await evaluate(`document.querySelector('#settings-close').click()`); await until(`!document.querySelector('#settings-dialog').open`);
  doc.title = '图示与图标题'; doc.blocks = createBlocks('![Model architecture](images/figure.png)\n\nFigure 1. Overview of the proposed framework.');
  for (const block of doc.blocks) block.values = Object.fromEntries(units(block).map(unit => [unit.id, '图 1. 所提出框架的概览。']));
  await update('图标题翻译完成');
  await until(`document.querySelector('.figure-media img')?.naturalWidth === 1`);
  for (const readingMode of ['parallel', 'bilingual', 'original', 'translated']) {
    await evaluate(`document.querySelector('button[data-mode="${readingMode}"]').click()`);
    await until(`document.querySelector('#blocks').dataset.mode === '${readingMode}'`);
    assert.equal(await evaluate(`document.querySelectorAll('#blocks img').length === 1 && !document.querySelector('.target img') && !document.querySelector('#b0 .figure-media').hidden && document.querySelector('#b0 .source').hidden && document.querySelector('#b0 .target').hidden`), true, 'Each reading mode shows one shared image without empty text frames');
    if (readingMode !== 'original') assert.equal(await evaluate(`!document.querySelector('#b1 .target').hidden && document.querySelector('#b1 .target').textContent.includes('图 1.')`), true);
  }
  const inline = createBlocks('Text before [![Diagram](images/inline.png)](https://example.com/figure) and text after.')[0]; inline.id = 'b2';
  inline.values = Object.fromEntries(units(inline).map(unit => [unit.id, '示意说明。'])); doc.blocks.push(inline);
  await update('行内图片展示');
  assert.equal(await evaluate(`document.querySelectorAll('#b2 img').length === 1 && document.querySelector('#b2 .source').hidden && !document.querySelector('#b2 .target').hidden && !document.querySelector('#b2 .figure-media').hidden`), true, 'Inline images are also shared while translated mode hides original text');
  assert.equal(await evaluate(`document.querySelector('#b2 .figure-media a').href === 'https://example.com/figure' && !!document.querySelector('#b2 .figure-media a img')`), true, 'Extracting an image must preserve its original hyperlink');
  await win.reload(); await until(`document.querySelector('#status').textContent === '行内图片展示'`);
  assert.equal(await evaluate(`document.documentElement.dataset.theme === 'light' && localStorage.getItem('theme') === 'light' && document.querySelectorAll('#blocks img').length === 2`), true, 'Theme and single-image layout survive reload');
  await evaluate(`document.querySelector('#theme-toggle').click()`); await until(`document.documentElement.dataset.theme === 'dark'`);
  assert.equal(await evaluate(`document.querySelector('#theme-toggle').textContent.includes('黑夜') && document.querySelector('#theme-toggle').title.includes('切换白天') && !document.querySelector('.number-warning')`), true);
  assert.equal(await evaluate(`getComputedStyle(document.body).backgroundColor === 'rgb(15, 23, 38)' && document.querySelectorAll('#blocks img').length === 2`), true);
  doc.title = '引用跳转演示';
  const gap = count => Array.from({ length: count }, (_, i) => `Reading context ${i}. See Figure 1. ` + 'The reader should return to the same paragraph after visiting a referenced object. '.repeat(2)).join('\n\n');
  doc.blocks = createBlocks(`# Navigation\n\nSee Fig. **1**, Table 2 and Eq. (3). Also see Eq. (4), Eq. (6), Figure 99 and [Figure 1](#original-figure-link). Inline code \`Figure 8\` must remain unchanged.\n\n${gap(18)}\n\n![Figure 1. Framework](images/figure.png)\n\nFigure 1. The proposed framework.\n\n${gap(12)}\n\nTable 2. Comparison of metrics.\n\n| Metric | Result |\n| --- | --- |\n| Score | 2 |\n\n${gap(12)}\n\n$$\nE=mc^2\\tag{3}\n$$\n\n${gap(10)}\n\n$$\nx=y\\tag*{4}\n$$\n\n<table><caption>Table 3. Numbered formula</caption><tr><td>$$x=y\\tag{6}$$</td></tr></table>`);
  for (const block of doc.blocks) block.values = Object.fromEntries(units(block).map(unit => [unit.id, unit.text]));
  await update('引用跳转就绪');
  const introId = doc.blocks.find(block => view({ blocks: [block] }).blocks[0].source.includes('See Fig.')).id;
  const figureId = doc.blocks.find(block => JSON.stringify(block.node).includes('images/figure.png')).id;
  const tableId = doc.blocks.find(block => block.node.type === 'table').id;
  const equationId = doc.blocks.find(block => block.node.type === 'math').id;
  await evaluate(`document.querySelector('button[data-mode="bilingual"]').click(); document.querySelector('#reader').scrollTop = 0`);
  await until(`document.querySelector('#blocks').dataset.mode === 'bilingual'`);
  assert.equal(await evaluate(`document.querySelector('#${introId} .source a[data-reference-key="figure:1"] strong').textContent === '1' && !document.querySelector('#${introId} code a') && document.querySelector('#${introId} a[href="#original-figure-link"]').classList.contains('document-reference')`), true, 'References preserve inline formatting, code and authored fragment links');
  await evaluate(`document.querySelector('#reader').scrollTop = document.getElementById('${introId}').offsetTop; window.originBlock = document.getElementById('${introId}'); window.originOffset = originBlock.getBoundingClientRect().top; document.querySelector('#${introId} .source a[data-reference-key="figure:1"]').click()`);
  await until(`!!document.querySelector('#${figureId} .figure-media img.reference-highlight')`);
  assert.equal(await evaluate(`!document.querySelector('#reference-back').hidden && !document.querySelector('#reference-dialog').open`), true);
  await checkReferenceBack(`#${figureId} img.reference-highlight`);
  await evaluate(`document.querySelector('#reference-back').click()`);
  assert.ok(await evaluate(`Math.abs(originBlock.getBoundingClientRect().top-originOffset)<1 && document.querySelector('#reference-back').hidden`));
  await evaluate(`document.querySelector('#${introId} .target a[data-reference-key="table:2"]').click()`);
  await until(`!!document.querySelector('#${tableId} table.reference-highlight')`);
  await checkReferenceBack(`#${tableId} table.reference-highlight`);
  await evaluate(`document.querySelector('#reader').scrollTop += 150`);
  await checkReferenceBack();
  win.showInactive(); await evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`);
  win.setSize(1100, 920); await checkReferenceBack(); win.setSize(1380, 920);
  await evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`); await checkReferenceBack(); win.hide();
  await evaluate(`document.querySelector('#${introId} .source a[data-reference-key="equation:3"]').click()`);
  await until(`!!document.querySelector('#${equationId} .katex.reference-highlight')`);
  await evaluate(`document.querySelector('#reference-back').click()`);
  assert.equal(await evaluate(`!document.querySelector('#reference-back').hidden`), true, 'Consecutive jumps can return one step at a time');
  await evaluate(`document.querySelector('#reference-back').click()`);
  assert.ok(await evaluate(`Math.abs(originBlock.getBoundingClientRect().top-originOffset)<1`));
  for (const number of [4, 6]) {
    const numbered = doc.blocks.find(block => block.node.value?.includes(number === 4 ? 'tag*{4}' : 'tag{6}'));
    await evaluate(`document.querySelector('#${introId} .source a[data-reference-key="equation:${number}"]').click()`);
    await until(`!!document.querySelector('#${numbered.id} .katex.reference-highlight')`);
    assert.equal(await evaluate(`!document.querySelector('#reference-dialog').open`), true, 'Starred and HTML-table equation tags resolve without manual selection');
    await evaluate(`document.querySelector('#reference-back').click()`);
  }
  await evaluate(`document.querySelector('#reader').scrollTop = document.getElementById('b8').offsetTop + 30; window.middleOrigin = document.querySelector('#b8 .source'); window.middleOffset = middleOrigin.getBoundingClientRect().top; document.querySelector('#b8 .source a[data-reference-key="figure:1"]').click()`);
  await until(`!!document.querySelector('#${figureId} img.reference-highlight')`);
  for (const unit of units(doc.blocks[1])) doc.blocks[1].values[unit.id] = '新加载的译文。'.repeat(180);
  await update('跳转期间译文更新');
  await evaluate(`document.querySelector('#reference-back').click()`);
  assert.ok(await evaluate(`Math.abs(middleOrigin.getBoundingClientRect().top-middleOffset)<1`), 'Return uses paragraph identity and screen offset after translations above it grow');
  assert.equal(await evaluate(`document.querySelector('#reference-back').hidden`), true);
  for (const unit of units(doc.blocks[1])) doc.blocks[1].values[unit.id] = unit.text;
  await update('引用译文恢复');
  await evaluate(`document.querySelector('#${introId} .source a[data-reference-key="figure:99"]').click()`);
  await until(`document.querySelector('#reference-dialog').open`);
  assert.equal(await evaluate(`document.querySelectorAll('#reference-choices button').length === 1`), true, 'Missing numbers require explicit selection even if only one figure exists');
  await evaluate(`document.querySelector('#reference-choices button').click()`);
  await until(`!document.querySelector('#reference-dialog').open`);
  await evaluate(`document.querySelector('#reference-back').click(); document.querySelector('#${introId} .source a[data-reference-key="figure:99"]').click()`);
  assert.equal(await evaluate(`!document.querySelector('#reference-dialog').open && !!document.querySelector('#${figureId} .figure-media img.reference-highlight')`), true, 'A manually mapped reference jumps directly next time');
  await evaluate(`document.querySelector('#reference-back').click()`);
  for (const readingMode of ['parallel', 'translated', 'original']) {
    await evaluate(`document.querySelector('button[data-mode="${readingMode}"]').click()`); await until(`document.querySelector('#blocks').dataset.mode === '${readingMode}'`);
    const textRoot = readingMode === 'translated' ? '.target' : '.source';
    await evaluate(`document.querySelector('#${introId} ${textRoot} a[data-reference-key="equation:3"]').click()`);
    await until(`!!document.querySelector('#${equationId} .katex.reference-highlight')`);
    assert.equal(await evaluate(`document.querySelector('#${equationId} .katex.reference-highlight').getClientRects().length > 0`), true);
    await checkReferenceBack(`#${equationId} .katex.reference-highlight`);
    await evaluate(`document.querySelector('#reference-back').click()`);
  }
  const editedTable = doc.blocks.find(block => block.id === tableId); editedTable.edit = '人工编辑后保留的表格说明。';
  await update('译文未含目标表格');
  await evaluate(`document.querySelector('button[data-mode="translated"]').click(); document.querySelector('#${introId} .target a[data-reference-key="table:2"]').click()`);
  await until(`document.querySelector('#blocks').dataset.mode === 'original' && !!document.querySelector('#${tableId} .source table.reference-highlight')`);
  await evaluate(`document.querySelector('#reference-back').click()`);
  assert.equal(await evaluate(`document.querySelector('#blocks').dataset.mode === 'translated'`), true, 'Missing translated objects temporarily fall back to original and restore the previous mode on return');
  editedTable.edit = null; await update('原表格恢复');
  await evaluate(`document.querySelector('#${introId} .target a[data-reference-key="table:2"]').click()`);
  await checkReferenceBack(`#${tableId} .target table`);
  for (const unit of units(editedTable)) editedTable.values[unit.id] = '表格译文更新';
  await update('跳转目标译文更新');
  await checkReferenceBack(`#${tableId} .target table`);
  await evaluate(`document.querySelector('#reference-back').click()`);
  await evaluate(`document.querySelector('button[data-mode="original"]').click()`);
  await evaluate(`document.querySelector('#immersive-toggle').click(); document.querySelector('#reader').scrollTop = 0; document.querySelector('#${introId} .source a[data-reference-key="figure:1"]').click()`);
  await until(`!!document.querySelector('#${figureId} .figure-media img.reference-highlight')`);
  await checkReferenceBack(`#${figureId} img.reference-highlight`);
  await evaluate(`document.querySelector('#reference-back').click(); document.querySelector('#immersive-toggle').click(); document.querySelector('button[data-mode="bilingual"]').click()`);
  await until(`document.querySelector('#blocks').dataset.mode === 'bilingual'`);
  const duplicate = createBlocks('![Figure 1. Other framework](images/second.png)')[0]; duplicate.id = 'b999'; doc.blocks.push(duplicate);
  await update('重复编号选择');
  await evaluate(`document.querySelector('#${introId} .source a[data-reference-key="figure:1"]').click()`); await until(`document.querySelector('#reference-dialog').open`);
  assert.equal(await evaluate(`document.querySelectorAll('#reference-choices button').length === 2`), true);
  await evaluate(`[...document.querySelectorAll('#reference-choices button')].find(button => button.textContent.includes('Other framework')).click()`);
  await until(`!!document.querySelector('#b999 img.reference-highlight')`);
  await evaluate(`document.querySelector('#reference-back').click()`);
  await win.reload(); await until(`document.querySelector('#status').textContent === '重复编号选择'`);
  await evaluate(`document.querySelector('#${introId} .source a[data-reference-key="figure:1"]').click()`);
  await until(`!!document.querySelector('#b999 img.reference-highlight')`);
  assert.equal(await evaluate(`!document.querySelector('#reference-dialog').open`), true, 'Manual mappings survive reload');
  await evaluate(`document.querySelector('#reference-back').click(); document.querySelector('#${introId} .source a[data-reference-key="figure:1"]').dispatchEvent(new MouseEvent('click', { bubbles:true, shiftKey:true }))`);
  await until(`document.querySelector('#reference-dialog').open`);
  assert.equal(await evaluate(`document.querySelectorAll('#reference-choices button').length === 2`), true, 'Shift-click can correct a saved mapping');
  await evaluate(`document.querySelector('[data-close="reference-dialog"]').click(); document.querySelector('button[data-mode="parallel"]').click(); document.querySelector('#${introId} .source a[data-reference-key="table:2"]').click()`);
  await until(`!!document.querySelector('#${tableId} table.reference-highlight')`);
  await checkReferenceBack(`#${tableId} table.reference-highlight`);
  win.showInactive(); await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await new Promise(resolve => setTimeout(resolve, 200));
  writeFileSync(path.join(screenshots, 'paperbridge-reference-navigation-test.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG()); win.hide();
  doc.id = 'other-fixture'; doc.title = '另一份文档';
  await evaluate(`document.querySelector('#sample').click()`);
  await until(`document.querySelector('#window-title').textContent === '另一份文档'`);
  assert.equal(await evaluate(`document.querySelector('#reference-back').hidden`), true, 'Switching documents clears the previous return history');
  await evaluate(`document.querySelector('#${introId} .source a[data-reference-key="figure:1"]').click()`);
  await until(`document.querySelector('#reference-dialog').open`);
  assert.equal(await evaluate(`document.querySelectorAll('#reference-choices button').length === 2`), true, 'Saved mappings belong only to their document');
  await evaluate(`document.querySelector('[data-close="reference-dialog"]').click()`);
  doc.title = '文内搜索示例';
  const requestsBeforeSearch = translationCalls.length, startsBeforeSearch = starts;
  const searchRows = Array.from({ length: 80 }, (_, row) => `<tr>${Array.from({ length: 16 }, (_, column) => `<td>${row === 79 && column === 15 ? 'far-marker' : `Cell ${row}-${column}`}</td>`).join('')}</tr>`).join('');
  doc.blocks = createBlocks('# Search fixture\n\nNeedle **needle** NEEDLE. Literal `[x+y]`, `<img>` and 🌊.\n\n' + Array.from({ length: 180 }, (_, i) => `ReadingToken ${i}. Some surrounding source text.`).join('\n\n') + `\n\n<table><caption>Searchable table</caption>${searchRows}</table>`);
  for (const block of doc.blocks) block.values = Object.fromEntries(units(block).map(unit => [unit.id, '缓存译文']));
  const searchIntro = doc.blocks[1];
  const introUnits = units(searchIntro);
  searchIntro.values[introUnits[0].id] = '关键词'; searchIntro.values[introUnits.at(-1).id] = '关键词';
  await update('文内搜索就绪');
  await evaluate(`window.beforeSearchNode = document.querySelector('#b1 .source'); window.findKey = new KeyboardEvent('keydown', { key:'f',ctrlKey:true,bubbles:true,cancelable:true }); document.dispatchEvent(findKey)`);
  await until(`!document.querySelector('#document-search').hidden && findKey.defaultPrevented`);
  async function queryDocument(value, count) {
    await evaluate(`document.querySelector('#document-search-input').value = ${JSON.stringify(value)}; document.querySelector('#document-search-input').dispatchEvent(new Event('input',{bubbles:true}))`);
    await until(`document.querySelectorAll('.document-search-result').length === ${count} && document.querySelector('#document-search-count').textContent === ${JSON.stringify(value.trim() ? count ? `共 ${count} 处匹配` : '没有找到匹配内容' : '输入关键词搜索当前文档')}`);
  }
  await queryDocument('needle', 3);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.document-search-result mark')].map(node => node.textContent)`), ['Needle','needle','NEEDLE'], 'Every occurrence is listed, including across inline formatting and case variants');
  await evaluate(`document.querySelectorAll('.document-search-result')[1].click()`);
  assert.equal(await evaluate(`[...CSS.highlights.get('document-search-current')][0].toString()`), 'needle');
  assert.equal(await evaluate(`document.querySelector('#b1 .source') === beforeSearchNode && document.querySelector('#b1 .source strong').textContent === 'needle' && !document.querySelector('#b1 mark')`), true, 'Native highlights retain source nodes and formatting');
  await evaluate(`document.querySelector('#reference-back').click()`);
  await queryDocument('[x+y]', 2);
  await queryDocument('<img>', 2);
  assert.equal(await evaluate(`!document.querySelector('#document-search-results img')`), true, 'Search strings are literal data and result snippets cannot inject HTML');
  await queryDocument('🌊', 1);
  await evaluate(`document.querySelector('.document-search-result').click()`);
  assert.equal(await evaluate(`[...CSS.highlights.get('document-search-current')][0].toString()`), '🌊');
  await evaluate(`document.querySelector('#reference-back').click(); document.querySelector('button[data-mode="translated"]').click()`);
  await queryDocument('needle', 3);
  await evaluate(`document.querySelector('.document-search-result').click()`);
  assert.equal(await evaluate(`document.querySelector('#blocks').dataset.mode === 'original' && [...CSS.highlights.get('document-search-current')][0].toString() === 'Needle'`), true, 'A hidden original match becomes visible');
  await evaluate(`document.querySelector('#reference-back').click()`);
  assert.equal(await evaluate(`document.querySelector('#blocks').dataset.mode === 'translated'`), true);
  await evaluate(`document.querySelector('button[data-mode="original"]').click()`);
  await queryDocument('关键词', 2);
  await evaluate(`document.querySelectorAll('.document-search-result')[1].click()`);
  assert.equal(await evaluate(`document.querySelector('#blocks').dataset.mode === 'bilingual' && [...CSS.highlights.get('document-search-current')][0].toString() === '关键词'`), true, 'Saved translation text remains searchable when only original text was rendered');
  await evaluate(`document.querySelector('#reference-back').click()`);
  searchIntro.values[introUnits.at(-1).id] = '关键词更新后的内容';
  await update('搜索中的译文更新');
  await queryDocument('更新后的内容', 1);
  await queryDocument('ReadingToken', 180);
  assert.equal(await evaluate(`document.querySelector('.document-search-result:last-child').textContent.includes('ReadingToken 179')`), true, 'Results are not truncated to an arbitrary first page');
  await queryDocument('far-marker', 1);
  await evaluate(`document.querySelector('.document-search-result').click()`);
  await until(`document.querySelector('#blocks').dataset.mode === 'original'`);
  assert.equal(await evaluate(`(() => { const range=[...CSS.highlights.get('document-search-current')][0], box=range.getBoundingClientRect(), reader=document.querySelector('#reader').getBoundingClientRect(), table=range.startContainer.parentElement.closest('table'); return range.toString() === 'far-marker' && table.scrollLeft > 0 && box.top >= reader.top && box.bottom < reader.bottom && box.left >= reader.left && box.right <= reader.right; })()`), true, 'A deep table match is scrolled vertically and horizontally into view');
  await evaluate(`document.querySelector('#reference-back').click(); document.querySelector('#immersive-toggle').click()`);
  await queryDocument('needle', 3); await evaluate(`document.querySelector('.document-search-result').click()`);
  assert.equal(await evaluate(`document.body.classList.contains('immersive') && CSS.highlights.has('document-search-current') && !document.querySelector('#document-search').hidden`), true);
  win.showInactive(); await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await new Promise(resolve => setTimeout(resolve, 200));
  writeFileSync(path.join(screenshots, 'paperbridge-document-search-test.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  await evaluate(`document.querySelector('#reference-back').click(); document.querySelector('#immersive-toggle').click()`);
  win.setSize(1100, 920); await evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`);
  await evaluate(`document.querySelector('.document-search-result').click()`);
  assert.equal(await evaluate(`document.querySelector('#document-search').hidden && CSS.highlights.has('document-search-current')`), true, 'Narrow windows close the overlay on navigation so it cannot cover the match');
  await evaluate(`document.querySelector('#reference-back').click(); document.querySelector('#document-find').click()`);
  await queryDocument('not-present-anywhere', 0); await queryDocument('   ', 0);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate(`document.querySelector('#document-search').hidden && !CSS.highlights.has('document-search-current')`), true);
  win.setSize(1380, 920); win.hide();
  await evaluate(`document.querySelector('#search').value='不存在的文档名'; document.querySelector('#search').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`!document.querySelector('.document-row')`), true, 'Library title filtering stays independent from in-document search');
  await evaluate(`document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input'))`);
  await evaluate(`document.querySelector('#document-find').click()`); await queryDocument('needle', 3);
  await evaluate(`document.querySelector('.document-search-result').click()`);
  doc.id = 'search-other-fixture';
  await evaluate(`document.querySelector('#sample').click()`);
  await until(`localStorage.getItem('selected') === 'search-other-fixture'`);
  assert.equal(await evaluate(`document.querySelector('#document-search').hidden && document.querySelector('#document-search-input').value === '' && !document.querySelector('.document-search-result') && !CSS.highlights.has('document-search-current')`), true, 'Switching documents removes stale queries, results and ranges');
  assert.equal(translationCalls.length, requestsBeforeSearch); assert.equal(starts, startsBeforeSearch);
  await evaluate(`navigator.clipboard.writeText = async () => { throw new DOMException('Write permission denied', 'NotAllowedError'); }; document.querySelector('#b1').click(); [...document.querySelectorAll('#b1 .block-tools button')].find(button=>button.textContent==='复制').click()`);
  for (let i = 0; i < 150 && !clipboardCalls.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(clipboardCalls, [view(doc).blocks[1].editable], 'Copy uses desktop IPC even when browser clipboard permission is denied');
  await until(`document.querySelector('#toast').textContent === '已复制 Markdown'`);
  const pendingBlock = doc.blocks.find(block => !block.preserve && units(block).length);
  pendingBlock.values = {}; pendingBlock.edit = null;
  translationReady = true; active = { id: doc.id, kind: 'reading', queue: [] };
  await update('正在翻译');
  const beforeToggle = starts;
  const retained = JSON.stringify(doc.blocks);
  await evaluate(`document.querySelector('#reading-toggle').click()`);
  await until(`document.querySelector('#reading-toggle').getAttribute('aria-pressed') === 'false' && !document.querySelector('#reading-toggle').disabled`);
  assert.equal(active, null); assert.equal(JSON.stringify(doc.blocks), retained);
  await update('已暂停');
  assert.equal(starts, beforeToggle);
  assert.equal(await evaluate(`localStorage.getItem('readingEnabled') === 'false' && !document.querySelector('#translate-all').disabled`), true, 'Disabling reading translation keeps manual translation available');
  await evaluate(`document.querySelector('#settings-open').click()`); await until(`document.querySelector('#settings-dialog').open`);
  await evaluate(`document.querySelector('#settings-close').click()`); await until(`!document.querySelector('#settings-dialog').open`);
  assert.equal(starts, beforeToggle, 'Closing settings cannot bypass the reading switch');
  await evaluate(`document.querySelector('#reading-toggle').click()`);
  for (let i = 0; i < 150 && starts !== beforeToggle + 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(starts, beforeToggle + 1, 'Turning reading on resumes even a paused document');
  await evaluate(`document.querySelector('#clear-translations').click()`);
  await until(`!document.querySelector('#clear-translations').disabled`);
  assert.equal(JSON.stringify(doc.blocks), retained);
  assert.equal(await evaluate(`localStorage.getItem('readingEnabled') === 'true' && document.querySelector('#reading-toggle').getAttribute('aria-pressed') === 'true'`), true, 'Cancelling clear preserves the previous reading preference');
  clearConfirmed = true;
  const sourceBeforeClear = await evaluate(`document.querySelector('#blocks').textContent`);
  await evaluate(`document.querySelector('#clear-translations').click()`);
  await until(`document.querySelector('#reading-toggle').getAttribute('aria-pressed') === 'false' && !document.querySelector('#clear-translations').disabled`);
  assert.deepEqual(clearCalls, [doc.id, doc.id]);
  assert.equal(progress(doc).done, 0); assert.equal(active, null);
  assert.equal(await evaluate(`localStorage.getItem('readingEnabled') === 'false' && document.querySelector('#progress').textContent.startsWith('0 /') && !!document.querySelector('#b1 .source')`), true);
  assert.ok(sourceBeforeClear.length > 0);
  const afterClearStarts = starts;
  await win.webContents.reload();
  await until(`document.querySelector('#window-title').textContent === ${JSON.stringify(doc.title)}`);
  assert.equal(starts, afterClearStarts, 'Reloading a cleared document does not translate it again');
  assert.equal(await evaluate(`document.querySelector('#reading-toggle').getAttribute('aria-pressed') === 'false'`), true);
  await evaluate(`document.querySelector('[data-close="reference-dialog"]').click(); window.contextEvent = new MouseEvent('contextmenu', { bubbles:true, cancelable:true }); document.querySelector('.document-row').dispatchEvent(contextEvent)`);
  await until(`contextEvent.defaultPrevented`);
  for (let i = 0; i < 150 && !folderCalls.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(folderCalls, [doc.id], 'Right-click open acts on the clicked document');
  contextAction = 'rename';
  await evaluate(`document.querySelector('.document-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }))`);
  await until(`document.querySelector('#rename-dialog').open`);
  assert.equal(await evaluate(`document.querySelector('#rename-name').value`), doc.title);
  await evaluate(`document.querySelector('#rename-name').value = '重命名后的论文'; document.querySelector('#rename-form').requestSubmit()`);
  await until(`!document.querySelector('#rename-dialog').open && document.querySelector('#window-title').textContent === '重命名后的论文'`);
  assert.deepEqual(renameCalls, [[doc.id, '重命名后的论文']]);
  assert.equal(await evaluate(`document.querySelector('.document-item strong').textContent`), '重命名后的论文');
  contextAction = 'delete';
  await evaluate(`document.querySelector('.document-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }))`);
  for (let i = 0; i < 150 && !deleteCalls.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(deleteCalls, [doc.id]);
  assert.equal(await evaluate(`!document.querySelector('#workspace').hidden && document.querySelectorAll('.document-row').length === 1`), true, 'Cancelling deletion keeps the current document on screen');
  deleteConfirmed = true;
  await evaluate(`document.querySelector('.document-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }))`);
  await until(`document.querySelector('#workspace').hidden && !document.querySelector('.document-row') && !localStorage.getItem('selected') && document.querySelector('#reference-back').hidden`);
  assert.match(await evaluate(`document.querySelector('#toast').textContent`), /永久删除/);
  assert.equal(await evaluate(`document.querySelector('#document-find').hidden && document.querySelector('#document-search').hidden`), true, 'Deleting the document also clears search UI');
  console.log('PASS: reader stability/navigation, document search all occurrences/precise ranges/table scroll/updates/modes/reset, native clipboard routing and document context actions');
  win.destroy(); app.exit(0);
} catch (error) { console.error(error); win?.destroy(); app.exit(1); }
});
