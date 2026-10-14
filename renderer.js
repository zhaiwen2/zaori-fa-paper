import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import renderMathInElement from 'katex/dist/contrib/auto-render.mjs';
import DOMPurify from 'dompurify';
import { buildReferenceIndex, findReferences, referenceCandidates, referenceNames } from './references.mjs';

const $ = selector => document.querySelector(selector);
const bridge = window.paperbridge;
const markdown = new MarkdownIt({ html: true, linkify: false, breaks: false }).use(texmath, {
  engine: katex, delimiters: 'dollars', katexOptions: { throwOnError: false, trust: false, maxExpand: 1000 },
});
for (const type of ['html_block', 'html_inline']) {
  markdown.renderer.rules[type] = (tokens, index) => DOMPurify.sanitize(tokens[index].content, {
    ALLOWED_TAGS: ['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'p', 'br', 'strong', 'em', 'img', 'sup', 'sub', 'code', 'pre', 'a'],
    ALLOWED_ATTR: ['src', 'alt', 'title', 'rowspan', 'colspan', 'href'],
  });
}
let selected = null, current = null, items = [], active = null, mode = localStorage.getItem('mode') || 'parallel';
if (!['parallel', 'bilingual', 'original', 'translated'].includes(mode)) mode = 'parallel';
let loadSequence = 0, editBlock = null, renameDocumentId = null, toastTimer, scrollTimer;
let parserReady = false, translationReady = false, readingTimer, lastVisible = '', autoStarting = false, parseStarting = false;
let readingEnabled = localStorage.getItem('readingEnabled') !== 'false';
let renderedDocument = null, outlineSignature = '', librarySignature = '';
let updateTimer, updating = false, updatePending = false;
let referenceIndex = { targets: [], byKey: new Map() }, referenceVersion = 0, jumpHistory = [], referenceMappings = {};
const linkedReferences = new WeakMap();
let highlightedReference, referenceHighlightTimer, referenceReturnAnchor, referenceReturnTarget;
let documentSearchTimer, documentSearchSignature = '', currentSearchMatch = null;
let theme = localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  $('#theme-toggle').textContent = theme === 'light' ? '☀ 白天' : '☾ 黑夜';
  $('#theme-toggle').title = theme === 'light' ? '当前为白天主题，点击切换黑夜' : '当前为黑夜主题，点击切换白天';
  $('#theme-toggle').setAttribute('aria-label', $('#theme-toggle').title);
  $('#theme-toggle').setAttribute('aria-pressed', String(theme === 'light'));
  api('setTheme', theme).catch(error => toast(error.message));
}
$('#theme-toggle').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); };
applyTheme();
if (localStorage.getItem('navigationLayoutV2') !== 'true') {
  localStorage.setItem('sidebarHidden', 'false');
  localStorage.setItem('outlineHidden', 'false');
  localStorage.setItem('immersive', 'false');
  localStorage.setItem('navigationLayoutV2', 'true');
}
let sidebarHidden = localStorage.getItem('sidebarHidden') === 'true';
let outlineHidden = localStorage.getItem('outlineHidden') === 'true';
const fontSizes = [12, 14, 16, 18, 20, 22, 24, 28];
let immersive = localStorage.getItem('immersive') === 'true';
let fontSize = Number(localStorage.getItem('fontSize')) || 16;
if (!fontSizes.includes(fontSize)) fontSize = 16;

function applyReadingPreferences() {
  const anchor = current ? visibleCards()[0] : null, top = anchor?.getBoundingClientRect().top;
  document.body.classList.toggle('sidebar-collapsed', sidebarHidden);
  document.body.classList.toggle('outline-collapsed', outlineHidden);
  document.body.classList.toggle('immersive', immersive);
  document.documentElement.style.setProperty('--reading-font-size', `${fontSize}px`);
  $('#font-size-control').textContent = `A${fontSize}`; $('#font-size-control').title = `正文字号 ${fontSize}px · 按住 Ctrl 并滚动鼠标滚轮调整`;
  $('#sidebar-toggle').title = sidebarHidden ? '展开文档侧栏' : '折叠文档侧栏';
  $('#sidebar-toggle').setAttribute('aria-label', $('#sidebar-toggle').title);
  $('#outline-toggle').title = outlineHidden ? '打开目录' : '隐藏目录';
  $('#outline-toggle span').textContent = $('#outline-toggle').title;
  $('#outline-toggle').setAttribute('aria-label', $('#outline-toggle').title);
  $('#outline-toggle').setAttribute('aria-expanded', String(!outlineHidden));
  $('#sidebar-toggle').setAttribute('aria-expanded', String(!sidebarHidden));
  $('#immersive-toggle').textContent = immersive ? '退出沉浸 · Esc' : '沉浸阅读';
  $('#immersive-toggle').setAttribute('aria-pressed', String(immersive));
  localStorage.setItem('sidebarHidden', String(sidebarHidden));
  localStorage.setItem('immersive', String(immersive));
  localStorage.setItem('fontSize', String(fontSize));
  localStorage.setItem('outlineHidden', String(outlineHidden));
  if (anchor) $('#reader').scrollTop += anchor.getBoundingClientRect().top - top;
  scheduleReading();
}
$('#sidebar-toggle').onclick = () => {
  if (immersive) { immersive = false; sidebarHidden = false; } else sidebarHidden = !sidebarHidden;
  applyReadingPreferences();
};
$('#outline-toggle').onclick = () => { outlineHidden = !outlineHidden; applyReadingPreferences(); };
$('#immersive-toggle').onclick = () => { immersive = !immersive; applyReadingPreferences(); };
function adjustFontSize(direction) {
  const next = Math.max(0, Math.min(fontSizes.length - 1, fontSizes.indexOf(fontSize) + direction));
  if (fontSizes[next] === fontSize) return;
  const anchor = visibleCards()[0]?.querySelector('.prose:not([hidden])'), top = anchor?.getBoundingClientRect().top;
  fontSize = fontSizes[next]; document.documentElement.style.setProperty('--reading-font-size', `${fontSize}px`);
  $('#font-size-control').textContent = `A${fontSize}`; $('#font-size-control').title = `正文字号 ${fontSize}px · 按住 Ctrl 并滚动鼠标滚轮调整`;
  localStorage.setItem('fontSize', String(fontSize));
  requestAnimationFrame(() => { if (anchor?.isConnected) $('#reader').scrollTop += anchor.getBoundingClientRect().top - top; });
}
document.addEventListener('wheel', event => {
  if (!event.ctrlKey || $('#workspace').hidden) return;
  event.preventDefault(); adjustFontSize(event.deltaY < 0 ? 1 : -1);
}, { passive: false });
document.addEventListener('keydown', event => {
  if (!document.querySelector('dialog[open]')) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && current?.blocks.length) {
      event.preventDefault(); showDocumentSearch(true); return;
    }
    if (event.key === 'Escape' && !$('#document-search').hidden) { event.preventDefault(); showDocumentSearch(false); return; }
  }
  if (event.key === 'Escape' && immersive && !document.querySelector('dialog[open]')) { immersive = false; applyReadingPreferences(); }
});
applyReadingPreferences();

async function api(name, ...args) {
  const result = await bridge[name](...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function toast(text) {
  $('#toast').textContent = text; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000);
}

function perform(fn) {
  return async event => {
    const button = event?.currentTarget;
    if (button?.tagName === 'BUTTON') button.disabled = true;
    try { await fn(event); } catch (error) { toast(error.message); }
    finally { if (button?.isConnected) button.disabled = false; }
  };
}

function renderMarkdown(text, showImages = true) {
  let html;
  try { html = markdown.render(text); } catch { html = `<pre>${markdown.utils.escapeHtml(text)}</pre>`; }
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: /^(?:(?:paper|https?|mailto):|#|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i });
  const cells = template.content.querySelectorAll('td, th, caption');
  for (const cell of cells) renderMathInElement(cell, {
    delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }],
    ignoredClasses: ['katex'], throwOnError: false, trust: false, maxExpand: 1000,
  });
  if (cells.length) template.innerHTML = DOMPurify.sanitize(template.innerHTML, { ALLOWED_URI_REGEXP: /^(?:(?:paper|https?|mailto):|#|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i });
  for (const image of template.content.querySelectorAll('img')) {
    if (!showImages) { image.remove(); continue; }
    const source = image.getAttribute('src') ?? '';
    try {
      if (/^[a-z][a-z\d+.-]*:|^\/|^\\/i.test(source)) throw new Error();
      const url = new URL(source, `paper://asset/${selected}/`);
      if (!url.pathname.startsWith(`/${selected}/`)) throw new Error();
      image.src = url.href; image.loading = 'lazy'; image.removeAttribute('srcset');
      image.alt ||= '文档图片';
    } catch {
      const replacement = document.createElement('span'); replacement.className = 'image-placeholder';
      replacement.textContent = `[图片未加载：${image.alt || '外部或不支持的资源'}]`; image.replaceWith(replacement);
    }
  }
  // Documents cannot embed executable/interactive UI, including raw HTML from a model.
  template.content.querySelectorAll('input,button,form,iframe,object,embed,video,audio,style,link').forEach(node => node.remove());
  for (const anchor of template.content.querySelectorAll('a')) { anchor.removeAttribute('target'); anchor.rel = 'noreferrer'; }
  return template.innerHTML;
}

function drawLibrary() {
  const query = $('#search').value.trim().toLowerCase();
  const signature = JSON.stringify([items, selected, query, !!active, parserReady, translationReady]);
  if (signature === librarySignature) return;
  librarySignature = signature;
  $('#document-count').textContent = items.length;
  $('#library').replaceChildren();
  for (const item of items.filter(item => item.title.toLowerCase().includes(query))) {
    const button = document.createElement('button'); button.className = `document-item${item.id === selected ? ' selected' : ''}`;
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = item.kind === 'pdf' ? 'PDF' : 'MD';
    const body = document.createElement('span'); body.className = 'document-item-body';
    const name = document.createElement('strong'); name.textContent = item.title;
    const detail = document.createElement('small'); detail.textContent = `${item.progress.done}/${item.progress.total} 段 · ${item.status}`;
    body.append(name, detail); button.append(icon, body);
    button.onclick = perform(async () => { await selectDocument(item.id); await startParseIfReady(item.id); });
    const row = document.createElement('div'); row.className = 'document-row';
    row.oncontextmenu = perform(async event => {
      event.preventDefault();
      const action = await api('documentMenu', item.id);
      if (action === 'open') await api('documentFolder', item.id);
      else if (action === 'rename') {
        renameDocumentId = item.id; $('#rename-name').value = item.title;
        $('#rename-dialog').showModal(); $('#rename-name').focus(); $('#rename-name').select();
      } else if (action === 'delete') await deleteDocument(item.id);
    });
    button.title = `${item.title} · 右键可打开文件夹、重命名或永久删除`;
    row.append(button); $('#library').append(row);
  }
  if (!items.length) { const note = document.createElement('p'); note.className = 'library-empty'; note.textContent = '你的文献会出现在这里'; $('#library').append(note); }
}

function updateSetupPrompt() {
  const missing = [];
  if (!parserReady) missing.push('文档解析');
  if (!translationReady) missing.push('翻译配置');
  $('#config-prompt').hidden = missing.length === 0;
  $('#config-summary').textContent = missing.length ? `尚未配置：${missing.join('、')}` : '';
  $('#parser-config-state').textContent = parserReady ? '已配置' : '未配置';
  $('#parser-config-state').classList.toggle('configured', parserReady);
  $('#translation-config-state').textContent = translationReady ? '已配置' : '未配置';
  $('#translation-config-state').classList.toggle('configured', translationReady);
}

async function deleteDocument(id) {
  if (!await api('deleteDocument', id)) return;
  localStorage.removeItem(`scroll:${id}`);
  localStorage.removeItem(`references:${id}`);
  if (selected === id) {
    resetReferenceNavigation(null);
    ++loadSequence; selected = null; current = null; lastVisible = '';
    localStorage.removeItem('selected'); clearTimeout(readingTimer);
    $('#blocks').replaceChildren(); $('#outline').replaceChildren();
    $('#workspace').hidden = true; $('#welcome').hidden = false; $('#local-save-state').textContent = '';
    $('#document-toolbar').hidden = true; $('#reading-pause').hidden = true;
    $('#window-title').textContent = '早日发Paper';
  }
  await refreshLibrary();
  if (!selected && items.length) await selectDocument(items[0].id);
  if (!items.length) { immersive = false; applyReadingPreferences(); }
  toast('已永久删除软件内的文档；导入时的原文件未删除');
}

$('#rename-form').onsubmit = perform(async event => {
  event.preventDefault();
  const title = $('#rename-name').value.trim();
  if (!title) throw new Error('请填写文档名称。');
  const id = renameDocumentId;
  await api('renameDocument', id, title); $('#rename-dialog').close();
  await refreshLibrary(); if (selected === id) await selectDocument(id, true);
  toast('文档已重命名');
});

async function refreshLibrary() {
  const result = await api('library'); items = result.items; active = result.active;
  parserReady = result.parserReady; translationReady = result.translationReady; updateSetupPrompt(); drawLibrary();
}

async function selectDocument(id, preserveScroll = false) {
  if (id !== selected && active?.kind === 'reading' && !active.pause) await api('pause');
  const sequence = preserveScroll ? loadSequence : ++loadSequence;
  const doc = await api('document', id);
  if (sequence !== loadSequence || preserveScroll && id !== selected) return;
  const same = preserveScroll && id === selected;
  const previousScroll = same ? $('#reader').scrollTop : Number(localStorage.getItem(`scroll:${id}`) || 0);
  if (id !== selected) { lastVisible = ''; resetReferenceNavigation(id); }
  selected = id; current = doc; localStorage.setItem('selected', id);
  $('#welcome').hidden = true; $('#workspace').hidden = false;
  drawLibrary(); drawDocument();
  if (!same) $('#reader').scrollTop = previousScroll;
  scheduleReading();
  if (!same) await ensureReading(id);
}

async function ensureReading(id = selected, resume = false) {
  if (!readingEnabled || !id || id !== selected || autoStarting || active || !translationReady || (!resume && current?.error) ||
    document.querySelector('dialog[open]') ||
    (!resume && ['需要处理', '已暂停'].includes(current?.status)) || !current?.blocks.some(block => !block.preserved && !block.done)) return;
  autoStarting = true;
  try {
    if (mode === 'original') { mode = 'bilingual'; localStorage.setItem('mode', mode); }
    await api('startReading', id, visibleBlockIds());
    if (!readingEnabled) await api('pause');
    if (id !== selected) return;
    await refreshLibrary();
    drawDocument(); scheduleReading();
  } catch (error) {
    if (id === selected && current) { current.error = error.message; drawDocument(); }
  } finally { autoStarting = false; }
}

function visibleCards() {
  const rect = $('#reader').getBoundingClientRect();
  return [...$('#blocks').children].filter(card => {
    const bounds = card.getBoundingClientRect();
    return bounds.bottom > rect.top && bounds.top < rect.bottom;
  });
}
function visibleBlockIds() {
  const eligible = new Set(current?.blocks.filter(b => !b.preserved && !b.done).map(b => b.id));
  return visibleCards().map(card => card.id).filter(id => eligible.has(id)).slice(0, 100);
}

function resetReferenceNavigation(id) {
  jumpHistory = []; $('#reference-back').hidden = true;
  referenceReturnAnchor = null; referenceReturnTarget = null;
  clearTimeout(documentSearchTimer); $('#document-search').hidden = true;
  $('#document-find').hidden = true;
  $('#document-find').setAttribute('aria-expanded', 'false'); $('#document-search-input').value = '';
  $('#document-search-results').replaceChildren(); documentSearchSignature = ''; currentSearchMatch = null;
  CSS.highlights.delete('document-search-current');
  clearTimeout(referenceHighlightTimer); highlightedReference?.classList.remove('reference-highlight');
  if ($('#reference-dialog').open) $('#reference-dialog').close();
  try {
    const saved = JSON.parse(localStorage.getItem(`references:${id}`) || '{}');
    referenceMappings = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { referenceMappings = {}; }
}

function rebuildReferenceIndex() {
  referenceIndex = buildReferenceIndex(current.blocks.filter(block => !block.hidden).map(block => {
    const card = document.getElementById(block.id), source = card.querySelector('.source'), plain = [];
    const textNodes = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    while (textNodes.nextNode()) if (!textNodes.currentNode.parentElement.closest('.katex, code, pre, .image-placeholder')) plain.push(textNodes.currentNode.data);
    const objects = [
      ...[...card.querySelectorAll('.figure-media img')].map((image, index) => ({ kind: 'figure', index, label: image.title || image.alt })),
      ...[...source.querySelectorAll('table')].map((table, index) => ({ kind: 'table', index, label: table.querySelector('caption')?.textContent })),
      ...[...source.querySelectorAll('.katex')].map((formula, index) => {
        const tag = formula.querySelector('.katex-tag, .tag')?.textContent || '';
        return { kind: 'equation', index, label: formula.textContent, number: tag.trim().replace(/^[（(](.*)[）)]$/, '$1') };
      }),
    ];
    return { id: block.id, text: plain.join('').trim(), objects };
  }));
  referenceVersion++;
}

function linkDocumentReferences(root) {
  if (root.referenceVersion === referenceVersion) return;
  root.referenceVersion = referenceVersion;
  for (const link of root.querySelectorAll('a[href^="#"]')) {
    const reference = findReferences(link.textContent.trim())[0];
    if (reference?.start === 0) {
      link.classList.add('document-reference'); link.dataset.referenceKey = reference.key;
      linkedReferences.set(link, reference);
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), groups = new Map();
  while (walker.nextNode()) {
    const text = walker.currentNode;
    const container = text.parentElement.closest('p, li, td, th, caption, h1, h2, h3, h4, h5, h6') || root;
    if (!groups.has(container)) groups.set(container, []);
    const skipped = text.parentElement.closest('a, code, pre, .katex, math, button');
    groups.get(container).push({ node: text, value: skipped ? '\0' : text.data });
  }
  for (const nodes of groups.values()) {
    let offset = 0;
    for (const item of nodes) { item.start = offset; offset += item.value.length; item.end = offset; }
    const text = nodes.map(item => item.value).join('');
    for (const reference of findReferences(text).reverse()) {
      const from = nodes.find(item => item.start <= reference.start && item.end > reference.start);
      const to = nodes.find(item => item.start < reference.end && item.end >= reference.end);
      if (!from || !to) continue;
      const range = document.createRange();
      range.setStart(from.node, reference.start - from.start); range.setEnd(to.node, reference.end - to.start);
      const link = document.createElement('a'); link.href = '#document-reference'; link.className = 'document-reference';
      link.title = `跳转到${referenceNames[reference.kind]} ${reference.number}；Shift 点击可选择位置`;
      link.dataset.referenceKey = reference.key;
      link.append(range.extractContents()); range.insertNode(link); linkedReferences.set(link, reference);
    }
  }
}

function referenceElement(target) {
  const card = document.getElementById(target.blockId);
  if (!card) return null;
  if (target.kind === 'search') return card.querySelector(`.${target.side}`);
  if (target.kind === 'figure') return card.querySelectorAll('.figure-media img')[target.index];
  const source = card.querySelector('.source'), targetText = card.querySelector('.target');
  const root = !source.hidden ? source : !targetText.hidden ? targetText : source;
  return root.querySelectorAll(target.kind === 'table' ? 'table' : '.katex')[target.index];
}

function positionReferenceBack() {
  const button = $('#reference-back'); button.hidden = !jumpHistory.length;
  if (button.hidden) return;
  const reader = $('#reader').getBoundingClientRect();
  const currentAnchor = referenceReturnTarget ? referenceElement(referenceReturnTarget) : referenceReturnAnchor;
  const anchor = currentAnchor?.isConnected && currentAnchor.getClientRects().length ? currentAnchor : visibleCards()[0];
  const target = (referenceReturnTarget?.kind === 'search' ? documentSearchRange(anchor, referenceReturnTarget)?.getBoundingClientRect() : null) || anchor?.getBoundingClientRect();
  const header = $('#reading-columns').hidden ? 0 : $('#reading-columns').offsetHeight;
  const top = reader.top + header + 10;
  button.style.left = `${Math.max(reader.left + 12, Math.min((target?.right ?? reader.right) - button.offsetWidth, reader.right - button.offsetWidth - 12))}px`;
  button.style.top = `${Math.max(top, Math.min((target?.top ?? top) - button.offsetHeight - 10, reader.bottom - button.offsetHeight - 12))}px`;
}
const referenceLayoutObserver = new ResizeObserver(positionReferenceBack);
referenceLayoutObserver.observe($('#reader')); referenceLayoutObserver.observe($('#blocks'));

function jumpToReference(target) {
  const reader = $('#reader'), card = visibleCards()[0];
  const origin = [...(card?.querySelectorAll('.prose') ?? [])].find(node => !node.hidden && node.getBoundingClientRect().bottom > reader.getBoundingClientRect().top) || card;
  const position = { blockId: card?.id, role: origin?.classList.contains('source') ? '.source' : origin?.classList.contains('target') ? '.target' : origin?.classList.contains('figure-media') ? '.figure-media' : null,
    offset: origin ? origin.getBoundingClientRect().top - reader.getBoundingClientRect().top : 0, scrollTop: reader.scrollTop, mode, focus: document.activeElement };
  let element = referenceElement(target);
  if (!element || !element.getClientRects().length) {
    mode = target.kind === 'search' && target.side === 'target' ? 'bilingual' : 'original';
    localStorage.setItem('mode', mode); drawDocument(); element = referenceElement(target); position.restoreMode = true;
  }
  if (!element) { toast('对应内容已改变，请重新选择跳转位置。'); return; }
  const range = target.kind === 'search' ? documentSearchRange(element, target) : null;
  if (target.kind === 'search' && !range) { toast('文档内容已更新，请点击新的搜索结果。'); return; }
  if (range) for (let parent = range.startContainer.parentElement; parent && parent !== reader; parent = parent.parentElement) {
    if (parent.scrollWidth <= parent.clientWidth || !['auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) continue;
    const bounds = parent.getBoundingClientRect(), hit = range.getBoundingClientRect();
    if (hit.right > bounds.right - 8) parent.scrollLeft += hit.right - bounds.right + 8;
    else if (hit.left < bounds.left + 8) parent.scrollLeft += hit.left - bounds.left - 8;
  }
  jumpHistory.push(position); $('#reference-back').hidden = false;
  const header = $('#reading-columns').hidden ? 0 : $('#reading-columns').offsetHeight;
  reader.scrollTop += (range || element).getBoundingClientRect().top - reader.getBoundingClientRect().top - header - $('#reference-back').offsetHeight - 22;
  clearTimeout(referenceHighlightTimer); highlightedReference?.classList.remove('reference-highlight');
  highlightedReference = element; element.classList.add('reference-highlight'); element.tabIndex = -1; element.focus({ preventScroll: true });
  referenceHighlightTimer = setTimeout(() => element.classList.remove('reference-highlight'), 2000);
  referenceReturnTarget = target; positionReferenceBack();
  currentSearchMatch = range ? target : null; highlightDocumentSearch();
  scheduleReading();
}

function chooseReference(reference, force = false) {
  const mapped = referenceIndex.targets.find(target => target.id === referenceMappings[reference.key]);
  const candidates = referenceCandidates(referenceIndex, reference);
  const exact = referenceIndex.byKey.has(reference.key) || referenceIndex.byKey.has(`${reference.kind}:${reference.number.replace(/\([a-z]\)$/, '')}`);
  if (!force && mapped) { jumpToReference(mapped); return; }
  if (!force && exact && candidates.length === 1) { jumpToReference(candidates[0]); return; }
  const choices = force ? referenceIndex.targets.filter(target => target.kind === reference.kind) : candidates;
  if (!choices.length) { toast(`解析结果中未找到${referenceNames[reference.kind]}对象，无法定位 ${reference.text}。`); return; }
  $('#reference-dialog-title').textContent = `选择 ${reference.text} 的对应位置`;
  $('#reference-choices').replaceChildren();
  for (const target of choices) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = target.title;
    button.onclick = () => {
      referenceMappings[reference.key] = target.id;
      localStorage.setItem(`references:${selected}`, JSON.stringify(referenceMappings));
      $('#reference-dialog').close(); jumpToReference(target);
    };
    $('#reference-choices').append(button);
  }
  $('#reference-dialog').showModal();
}

$('#reference-back').onclick = () => {
  const position = jumpHistory.pop(); if (!position) return;
  if (position.restoreMode) { mode = position.mode; localStorage.setItem('mode', mode); drawDocument(); }
  const card = document.getElementById(position.blockId), previous = position.role ? card?.querySelector(position.role) : card;
  const anchor = previous && !previous.hidden ? previous : [...(card?.querySelectorAll('.prose') ?? [])].find(node => !node.hidden) || card;
  if (anchor) $('#reader').scrollTop += anchor.getBoundingClientRect().top - $('#reader').getBoundingClientRect().top - position.offset;
  else $('#reader').scrollTop = position.scrollTop;
  (position.focus?.isConnected && position.focus.getClientRects().length ? position.focus : card)?.focus({ preventScroll: true });
  clearTimeout(referenceHighlightTimer); highlightedReference?.classList.remove('reference-highlight');
  referenceReturnTarget = null; referenceReturnAnchor = anchor; positionReferenceBack(); scheduleReading();
  currentSearchMatch = null; highlightDocumentSearch();
};

function searchableText(root) {
  if (root.searchText) return root.searchText;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
  let text = '', previous;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest('.katex-mathml, annotation')) continue;
    const container = node.parentElement.closest('p,li,td,th,caption,h1,h2,h3,h4,h5,h6,pre') || root;
    if (previous && previous !== container) text += '\n';
    previous = container; nodes.push({ node, start: text.length, end: text.length + node.length }); text += node.data;
  }
  return root.searchText = { text, nodes };
}

function documentSearchRange(root, match) {
  if (!root) return null;
  const { text, nodes } = searchableText(root);
  if (text !== match.text) return null;
  const from = nodes.find(item => item.start <= match.start && item.end > match.start);
  const to = nodes.find(item => item.start < match.end && item.end >= match.end);
  if (!from || !to) return null;
  const range = document.createRange(); range.setStart(from.node, match.start - from.start); range.setEnd(to.node, match.end - to.start);
  return range;
}

function highlightDocumentSearch() {
  const range = currentSearchMatch && documentSearchRange(referenceElement(currentSearchMatch), currentSearchMatch);
  if (range) CSS.highlights.set('document-search-current', new Highlight(range));
  else CSS.highlights.delete('document-search-current');
  for (const button of $('#document-search-results').children) {
    const active = button.searchMatch?.key === currentSearchMatch?.key;
    button.classList.toggle('active', active); button.setAttribute('aria-current', String(active));
  }
}

function drawDocumentSearch() {
  if ($('#document-search').hidden || !current) { highlightDocumentSearch(); return; }
  clearTimeout(documentSearchTimer);
  const query = $('#document-search-input').value.trim();
  const signature = JSON.stringify([current.id, query, current.blocks.map(block => [block.id, block.source, document.getElementById(block.id)?.displayTarget])]);
  if (signature === documentSearchSignature) { highlightDocumentSearch(); return; }
  documentSearchSignature = signature;
  const results = [], pattern = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu') : null;
  if (pattern) for (const block of current.blocks) {
    if (block.hidden) continue;
    const card = document.getElementById(block.id);
    const roots = [['source', card.querySelector('.source')]];
    if (!block.preserved && card.displayTarget != null) {
      let root = card.querySelector('.target');
      if (card.targetText !== card.displayTarget) {
        if (card.searchTarget?.text !== card.displayTarget) {
          const temp = document.createElement('div'); temp.innerHTML = renderMarkdown(card.displayTarget, false);
          card.searchTarget = { text: card.displayTarget, root: temp };
        }
        root = card.searchTarget.root;
      }
      roots.push(['target', root]);
    }
    for (const [side, root] of roots) {
      const { text } = searchableText(root);
      for (const found of text.matchAll(pattern)) results.push({ kind: 'search', blockId: block.id, side, text, start: found.index, end: found.index + found[0].length, key: `${block.id}:${side}:${found.index}` });
    }
  }
  const fragment = document.createDocumentFragment();
  for (const [index, match] of results.entries()) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'document-search-result'; button.searchMatch = match;
    const label = document.createElement('small'); label.textContent = `${index + 1} · ${match.side === 'source' ? '原文' : '译文'}`;
    const snippet = document.createElement('span'), mark = document.createElement('mark'); mark.textContent = match.text.slice(match.start, match.end);
    snippet.append((match.start > 40 ? '…' : '') + match.text.slice(Math.max(0, match.start - 40), match.start), mark, match.text.slice(match.end, match.end + 65) + (match.end + 65 < match.text.length ? '…' : ''));
    button.append(label, snippet);
    button.onclick = () => { if (window.innerWidth <= 1200) showDocumentSearch(false); jumpToReference(match); };
    fragment.append(button);
  }
  const list = $('#document-search-results'), scroll = list.scrollTop; list.replaceChildren(fragment); list.scrollTop = scroll;
  $('#document-search-count').textContent = !query ? '输入关键词搜索当前文档' : results.length ? `共 ${results.length} 处匹配` : '没有找到匹配内容';
  highlightDocumentSearch();
}

function showDocumentSearch(open) {
  const anchor = visibleCards()[0], top = anchor?.getBoundingClientRect().top;
  $('#document-search').hidden = !open; $('#document-find').setAttribute('aria-expanded', String(open));
  if (anchor) $('#reader').scrollTop += anchor.getBoundingClientRect().top - top;
  if (open) { drawDocumentSearch(); $('#document-search-input').focus(); $('#document-search-input').select(); }
  else { currentSearchMatch = null; highlightDocumentSearch(); $('#document-find').focus({ preventScroll: true }); }
  scheduleReading();
}
$('#document-find').onclick = () => showDocumentSearch($('#document-search').hidden);
$('#document-search-close').onclick = () => showDocumentSearch(false);
$('#document-search-input').oninput = () => {
  currentSearchMatch = null; highlightDocumentSearch();
  clearTimeout(documentSearchTimer); documentSearchTimer = setTimeout(drawDocumentSearch, 150);
};
function scheduleReading() {
  clearTimeout(readingTimer);
  readingTimer = setTimeout(async () => {
    if (!readingEnabled || !current || active?.kind !== 'reading' || active.id !== selected || active.pause || mode === 'original' ||
      document.hidden || document.querySelector('dialog[open]')) return;
    const ids = visibleBlockIds(), signature = `${selected}:${ids.join(',')}`;
    if (!ids.length || signature === lastVisible) return;
    lastVisible = signature;
    try { await api('enqueueReading', selected, ids); }
    catch (error) { lastVisible = ''; toast(error.message); }
  }, 350);
}

function setupPaneSplitter(id, property, storageKey, min, max) {
  const root = document.documentElement;
  const initial = parseFloat(getComputedStyle(root).getPropertyValue(property));
  const saved = Number(localStorage.getItem(storageKey));
  const startWidth = Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial;
  root.style.setProperty(property, `${startWidth}px`);
  const splitter = document.getElementById(id);
  let startX = 0, width = startWidth;
  const setWidth = value => {
    if (value <= min) {
      if (id === 'sidebar-splitter') sidebarHidden = true;
      else outlineHidden = true;
      endDrag(); applyReadingPreferences(); return;
    }
    width = Math.max(min, Math.min(max, value));
    root.style.setProperty(property, `${width}px`);
    localStorage.setItem(storageKey, String(width));
    window.dispatchEvent(new Event('resize'));
  };
  splitter.addEventListener('mousedown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); root.dataset.resizingPane = id; startX = event.clientX; width = parseFloat(getComputedStyle(root).getPropertyValue(property)) || initial;
    document.body.classList.add('resizing-panes');
  });
  window.addEventListener('mousemove', event => {
    if (root.dataset.resizingPane !== id || event.buttons !== 1) return;
    setWidth(width + event.clientX - startX); startX = event.clientX;
  });
  const endDrag = () => { if (root.dataset.resizingPane === id) { delete root.dataset.resizingPane; document.body.classList.remove('resizing-panes'); } };
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('blur', endDrag);
  splitter.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); setWidth((parseFloat(getComputedStyle(root).getPropertyValue(property)) || initial) + (event.key === 'ArrowRight' ? 16 : -16));
  });
}
setupPaneSplitter('sidebar-splitter', '--sidebar-width', 'sidebarWidth', 140, 480);
setupPaneSplitter('outline-splitter', '--outline-width', 'outlineWidth', 120, 360);
window.addEventListener('resize', scheduleReading);
document.addEventListener('visibilitychange', scheduleReading);
$('#reader').addEventListener('load', scheduleReading, true);
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', scheduleReading));

function drawDocument() {
  const readerTop = $('#reader').getBoundingClientRect().top;
  const anchorCard = renderedDocument === selected ? visibleCards()[0] : null;
  const anchor = [...(anchorCard?.querySelectorAll('.prose') ?? [])].find(node => !node.hidden && node.getBoundingClientRect().bottom > readerTop) ?? anchorCard;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const doc = current, busy = !!active, thisBusy = active?.id === doc.id;
  let referencesChanged = renderedDocument !== doc.id;
  $('#window-title').textContent = doc.title;
  $('#document-find').hidden = !doc.blocks.length;
  $('#original').hidden = !doc.hasPdf;
  $('#translate-all').hidden = !doc.blocks.length; $('#translate-all').disabled = busy || !translationReady;
  $('#reading-pause').hidden = !thisBusy; $('#reading-pause').disabled = false;
  $('#more').hidden = !doc.blocks.length; $('#more').disabled = busy || !translationReady;
  $('#reading-toggle').disabled = !doc.blocks.length || (busy && (!thisBusy || active.kind !== 'reading'));
  drawReadingToggle();
  $('#clear-translations').disabled = !doc.blocks.length || (busy && !thisBusy);
  $('#export').disabled = !doc.blocks.length;
  $('#status').textContent = doc.status;
  $('#status-dot').classList.toggle('busy', thisBusy);
  $('#progress').textContent = `${doc.progress.done} / ${doc.progress.total} 段已译${doc.progress.failed ? ` · ${doc.progress.failed} 段待处理` : ''}`;
  $('#local-save-state').textContent = `${doc.progress.done} 段已保存`;
  $('#local-save-state').title = '每个翻译片段自动保存，重新打开或继续翻译会复用已有译文。只有主动点击重译才重新请求。';
  $('#usage').textContent = doc.usage?.total_tokens !== undefined ? `${doc.usage.total_tokens.toLocaleString()} tokens · 已报告用量` : 'API 费用由服务商结算';
  $('#notice').textContent = doc.error || ''; $('#error-panel').hidden = !doc.error;
  $('#document-toolbar').hidden = false;
  $('#blocks').dataset.mode = mode;
  $('#reading-columns').hidden = mode !== 'parallel';
  document.querySelectorAll('button[data-mode]').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
  if (renderedDocument !== doc.id) {
    $('#blocks').replaceChildren(); renderedDocument = doc.id; outlineSignature = '';
  }
  const cards = new Map([...$('#blocks').children].map(card => [card.id, card]));
  const visibleIds = new Set(doc.blocks.filter(block => !block.hidden).map(block => block.id));
  for (const card of cards.values()) if (!visibleIds.has(card.id)) { card.remove(); referencesChanged = true; }
  for (const block of doc.blocks) {
    if (block.hidden) continue;
    let card = cards.get(block.id);
    if (!card) {
      card = document.createElement('article'); card.id = block.id; card.className = `block${block.heading ? ' heading-block' : ''}`;
      card.tabIndex = 0; card.setAttribute('aria-expanded', 'false');
      const toggleCard = () => {
        const selected = !card.classList.contains('selected');
        card.classList.toggle('selected', selected); card.setAttribute('aria-expanded', String(selected));
      };
      card.addEventListener('click', event => {
        if (event.target.closest('button, a, summary, input, textarea')) return;
        toggleCard();
      });
      card.addEventListener('keydown', event => {
        if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault(); toggleCard();
      });
      const source = document.createElement('div'); source.className = 'prose source';
      const target = document.createElement('div'); target.className = 'prose target'; target.hidden = true;
      const tools = document.createElement('div'); tools.className = 'block-tools';
      const label = document.createElement('span'); tools.append(label);
      for (const text of ['复制', '编辑', '重译']) {
        const button = document.createElement('button'); button.className = 'text-button'; button.textContent = text;
        button.onclick = perform(async () => {
          const latest = card.block;
          if (text === '复制') { await api('copyText', latest.done ? latest.editable : latest.source); toast('已复制 Markdown'); return; }
          if (active) throw new Error('请先暂停任务。');
          if (text === '编辑') { editBlock = latest.id; $('#edit-text').value = latest.editable; $('#edit-dialog').showModal(); return; }
          await api('translate', selected, latest.id); await refreshLibrary(); drawDocument();
        });
        tools.append(button);
      }
      const media = document.createElement('div'); media.className = 'figure-media prose'; media.hidden = true;
      card.append(source, target, tools, media); $('#blocks').append(card);
    }
    card.block = block;
    const [source, target, tools, media] = card.children;
    // Retain source nodes, images and formulas; partial results are saved but shown once the paragraph finishes.
    const translating = thisBusy && !active.pause;
    if (block.done || !translating || !block.partial) card.displayTarget = block.done || block.partial ? block.target : null;
    const parallel = mode === 'parallel';
    const displayTarget = parallel && block.preserved ? block.source : card.displayTarget;
    const showTarget = mode !== 'original' && (!block.preserved || parallel) && displayTarget != null;
    source.classList.toggle('muted', ['bilingual', 'parallel'].includes(mode) && showTarget);
    if (card.sourceText !== block.source) {
      source.innerHTML = renderMarkdown(block.source); card.sourceText = block.source;
      source.searchText = null;
      source.referenceVersion = -1; referencesChanged = true;
      media.replaceChildren();
      for (const image of source.querySelectorAll('img, .image-placeholder')) {
        const link = image.closest('a');
        if (link) { const sharedLink = link.cloneNode(false); sharedLink.append(image); media.append(sharedLink); }
        else media.append(image);
      }
      for (const empty of [...source.querySelectorAll('p, a, strong, em')].reverse()) if (!empty.textContent.trim() && !empty.children.length) empty.remove();
      media.hidden = !media.childNodes.length;
      card.classList.toggle('has-figures', !media.hidden);
    }
    source.hidden = (!source.textContent.trim() && !source.querySelector('table, pre, .katex, hr')) || (mode === 'translated' && !block.preserved && showTarget);
    target.hidden = !showTarget && !parallel;
    if (showTarget && card.targetText !== displayTarget) { target.innerHTML = renderMarkdown(displayTarget, false); target.searchText = null; card.targetText = displayTarget; target.referenceVersion = -1; }
    if (!showTarget && parallel) { target.replaceChildren(); target.searchText = null; card.targetText = null; target.referenceVersion = -1; }
    if (!media.hidden && !target.textContent.trim() && !target.querySelector('table, pre, .katex, hr')) target.hidden = true;
    tools.hidden = block.preserved;
    const label = tools.firstChild;
    label.className = block.error ? 'block-error' : 'block-label';
    label.hidden = !block.error;
    const status = block.error || '';
    if (label.textContent !== status) label.textContent = status;
  }
  const headings = doc.blocks.filter(block => block.heading && !block.hidden);
  const signature = JSON.stringify([doc.id, headings.map(block => [block.id, block.source])]);
  if (outlineSignature !== signature) {
    outlineSignature = signature; $('#outline').replaceChildren();
    const title = document.createElement('div'); title.className = 'outline-title'; title.textContent = '文档目录'; $('#outline').append(title);
    for (const block of headings) {
      const button = document.createElement('button');
      const temp = document.createElement('div'); temp.innerHTML = renderMarkdown(block.source);
      button.textContent = temp.textContent.trim(); button.title = button.textContent;
      button.onclick = () => document.getElementById(block.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#outline').append(button);
    }
  }
  if (!doc.blocks.length) {
    const empty = document.createElement('div'); empty.className = 'parse-empty';
    const title = document.createElement('h2');
    title.textContent = doc.error ? 'PDF 解析未完成' : doc.kind === 'pdf' ? doc.status : '让论文变得好读';
    const note = document.createElement('p');
    note.textContent = doc.error || (doc.kind === 'pdf'
      ? parserReady ? '正在自动解析 PDF…解析进度会显示在窗口底部。' : '请先完成文档解析配置，配置后重新导入 PDF 即可自动解析。'
      : '文档已导入，原件始终保留在本机。');
    empty.append(title, note); $('#blocks').append(empty);
    if (doc.kind === 'pdf' && doc.status === '已暂停' && parserReady) {
      const resume = document.createElement('button'); resume.className = 'secondary'; resume.textContent = '继续解析';
      resume.onclick = perform(async () => { await api('parse', selected); await refreshLibrary(); await selectDocument(selected, true); });
      empty.append(resume);
    }
    if (doc.kind === 'pdf' && !parserReady) {
      const configure = document.createElement('button'); configure.className = 'secondary'; configure.textContent = '配置文档解析';
      configure.onclick = () => $('#settings-open').click(); empty.append(configure);
    }
    if (doc.error) {
      const restart = document.createElement('button'); restart.className = 'secondary'; restart.textContent = '重新提交 MinerU 任务';
      restart.onclick = perform(async () => {
        if (!parserReady) { $('#settings-open').click(); return; }
        if (!confirm('重新上传并创建新的解析任务，可能再次占用额度。继续？')) return;
        await api('parse', selected, true); await refreshLibrary(); drawDocument();
      }); empty.append(restart);
    }
  }
  if (referencesChanged) rebuildReferenceIndex();
  for (const card of $('#blocks').children) {
    for (const root of card.querySelectorAll('.source, .target')) linkDocumentReferences(root);
  }
  if (anchor?.isConnected && !anchor.hidden) $('#reader').scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  positionReferenceBack();
  drawDocumentSearch();
}

async function importDocument() {
  const id = await api('import'); if (!id) return;
  await refreshLibrary(); await selectDocument(id);
  await startParseIfReady(id);
}

async function startParseIfReady(id) {
  if (!parserReady || active || parseStarting || $('#settings-dialog').open) return;
  parseStarting = true;
  try {
    const doc = id === selected ? current : await api('document', id);
    if (doc?.kind !== 'pdf' || doc.blocks.length || doc.error || ['已暂停', '需要处理'].includes(doc.status)) return;
    await api('parse', id);
    await refreshLibrary();
    if (id === selected) await selectDocument(id, true);
  } finally { parseStarting = false; }
}

$('#import').onclick = perform(importDocument); $('#welcome-import').onclick = perform(importDocument);
$('#sample').onclick = perform(async () => { const id = await api('sample'); await refreshLibrary(); await selectDocument(id); });
$('#welcome-settings').onclick = () => $('#settings-open').click();
$('#search').oninput = drawLibrary;
$('#original').onclick = perform(() => api('original', selected));
function drawReadingToggle() {
  $('#reading-toggle').textContent = `边读边译：${readingEnabled ? '开' : '关'}`;
  $('#reading-toggle').setAttribute('aria-pressed', String(readingEnabled));
  $('#reading-toggle').title = readingEnabled ? '点击关闭自动翻译，已有译文保留' : '点击开启，自动翻译阅读位置的未完成内容';
}
function setReadingEnabled(enabled) {
  readingEnabled = enabled;
  localStorage.setItem('readingEnabled', String(enabled));
  lastVisible = ''; clearTimeout(readingTimer); drawReadingToggle();
}
$('#reading-toggle').onclick = perform(async () => {
  setReadingEnabled(!readingEnabled);
  if (!readingEnabled && active?.kind === 'reading') await api('pause');
  await refreshLibrary();
  if (current) drawDocument();
  if (readingEnabled) await ensureReading(selected, true);
});
$('#clear-translations').onclick = perform(async () => {
  const id = selected, previous = readingEnabled;
  readingEnabled = false; clearTimeout(readingTimer); drawReadingToggle();
  try {
    if (await api('clearTranslations', id)) {
      setReadingEnabled(false);
      await refreshLibrary();
      if (id === selected) await selectDocument(id, true);
      toast('当前文档译文已清空，边读边译已关闭；原文与图片保留。');
    } else { readingEnabled = previous; drawReadingToggle(); scheduleReading(); }
  } catch (error) { readingEnabled = previous; drawReadingToggle(); scheduleReading(); throw error; }
});
$('#translate-all').onclick = perform(async () => { await api('translate', selected); await refreshLibrary(); drawDocument(); });
$('#reading-pause').onclick = perform(async () => { lastVisible = ''; toast(await api('pause') || '当前没有运行任务'); });
$('#more').onclick = perform(async () => {
  await api('translate', selected, null, true); await refreshLibrary(); await selectDocument(selected, true);
});
$('#export').onclick = () => $('#export-dialog').showModal();
document.querySelectorAll('[data-export]').forEach(button => { button.onclick = perform(async () => {
  $('#export-dialog').close(); const result = await api('export', selected, button.dataset.export); if (result) toast('已导出 Markdown 与图片资源包');
}); });
document.querySelectorAll('button[data-mode]').forEach(button => { button.onclick = perform(async () => {
  if (button.dataset.mode === 'original' && active?.kind === 'reading') await api('pause');
  const scroll = $('#reader').scrollTop; mode = button.dataset.mode; localStorage.setItem('mode', mode); drawDocument(); $('#reader').scrollTop = scroll;
  lastVisible = ''; scheduleReading();
}); });
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => document.getElementById(button.dataset.close).close(); });
$('#reader').addEventListener('scroll', () => {
  positionReferenceBack();
  clearTimeout(scrollTimer); const id = selected;
  scrollTimer = setTimeout(() => { if (id && selected === id) localStorage.setItem(`scroll:${id}`, $('#reader').scrollTop); }, 150);
  scheduleReading();
});
$('#blocks').addEventListener('click', perform(async event => {
  const anchor = event.target.closest('a');
  if (anchor) {
    event.preventDefault();
    const reference = linkedReferences.get(anchor);
    if (reference) { chooseReference(reference, event.shiftKey); return; }
    const href = anchor.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) await api('external', href);
    else if (href.startsWith('#')) document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' });
  }
}));

const form = $('#settings-form');
function showTranslationProvider() {
  const provider = form.elements.provider.value;
  for (const [id, visible] of [['cloud-translation-fields', provider === 'chat'], ['local-translation-fields', provider === 'local-api'], ['edge-translation-fields', provider === 'edge']]) {
    const fields = document.getElementById(id); fields.hidden = !visible; fields.disabled = !visible;
  }
  $('#glossary-field').hidden = provider === 'edge';
  form.elements.glossary.disabled = provider === 'edge';
}
form.elements.provider.addEventListener('change', showTranslationProvider);
let settingsSaveTimer = null, settingsSavePending = false, settingsSaving = false, settingsSaveError = null;
let openedSettings, resumeReadingAfterSettings = false;
const translationSettingFields = ['provider', 'baseUrl', 'model', 'translateKey', 'cloudBatchSegments', 'cloudBatchCharacters', 'cloudRequestIntervalSeconds', 'localBaseUrl', 'localModel', 'localTranslateKey', 'localBatchCharacters', 'sourceLang', 'targetLang', 'glossary'];
function settingsData() {
  const data = Object.fromEntries(new FormData(form));
  data.ocr = form.elements.ocr.checked;
  return data;
}
function hideSettingsSecrets() {
  form.querySelectorAll('[data-secret-toggle]').forEach(button => {
    form.elements[button.dataset.secretToggle].type = 'password';
    button.textContent = '显示'; button.setAttribute('aria-pressed', 'true');
  });
}
async function fillSettings() {
  const config = await api('settings');
  openedSettings = config;
  for (const name of ['baseUrl', 'model', 'cloudBatchSegments', 'cloudBatchCharacters', 'cloudRequestIntervalSeconds', 'localBaseUrl', 'localModel', 'localBatchCharacters', 'sourceLang', 'targetLang', 'glossary', 'minerModel', 'ocrLang']) form.elements[name].value = config[name] ?? '';
  form.elements.provider.value = ['chat', 'local-api', 'edge'].includes(config.provider) ? config.provider : 'edge';
  showTranslationProvider();
  form.elements.ocr.checked = config.ocr;
  for (const name of ['minerKey', 'translateKey', 'localTranslateKey']) {
    form.elements[name].value = config[name] ?? '';
    form.elements[name].placeholder = config[name] ? '' : name === 'minerKey' ? '粘贴 MinerU Token' : name === 'localTranslateKey' ? '服务无需密钥时留空' : '粘贴模型服务商 API Key';
  }
  hideSettingsSecrets();
  $('#settings-result').textContent = config.secureStorage ? '更改会自动保存。密钥已在本机加密保存。' : '当前系统不支持安全保存 API 密钥。';
  await refreshLibrary();
}
function scheduleSettingsSave() {
  settingsSaveError = null;
  settingsSavePending = true;
  $('#settings-result').textContent = '有更改待保存…';
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(persistSettingsDraft, 550);
}
async function persistSettingsDraft() {
  clearTimeout(settingsSaveTimer); settingsSaveTimer = null;
  if (!settingsSavePending || settingsSaving) return;
  settingsSavePending = false; settingsSaving = true;
  const data = settingsData(); $('#settings-result').textContent = '正在保存…';
  try {
    const config = await api('saveSettings', data);
    if (openedSettings && translationSettingFields.some(name => config[name] !== openedSettings[name])) resumeReadingAfterSettings = true;
    openedSettings = config;
    settingsSaveError = null;
    parserReady = config.hasMinerKey;
    $('#settings-result').textContent = '已自动保存。';
    await refreshLibrary();
    if (current) { drawDocument(); await startParseIfReady(selected); }
  } catch (error) {
    settingsSaveError = error;
    $('#settings-result').textContent = `保存失败：${error.message}`;
  } finally {
    settingsSaving = false;
    if (settingsSavePending) settingsSaveTimer = setTimeout(persistSettingsDraft, 250);
  }
}
form.querySelectorAll('[data-secret-toggle]').forEach(button => {
  button.onclick = () => {
    const input = form.elements[button.dataset.secretToggle];
    const hide = input.type !== 'password';
    input.type = hide ? 'password' : 'text';
    button.textContent = hide ? '显示' : '隐藏';
    button.setAttribute('aria-pressed', String(hide));
  };
});
async function flushSettingsSave() {
  clearTimeout(settingsSaveTimer); settingsSaveTimer = null;
  if (settingsSaveError && !settingsSaving) settingsSavePending = true;
  while (settingsSavePending || settingsSaving) {
    if (settingsSavePending && !settingsSaving) await persistSettingsDraft();
    else await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (settingsSaveError) throw settingsSaveError;
}
form.addEventListener('input', scheduleSettingsSave);
form.addEventListener('change', scheduleSettingsSave);
form.onsubmit = perform(async event => { event.preventDefault(); scheduleSettingsSave(); await flushSettingsSave(); });
$('#settings-open').onclick = perform(async () => {
  resumeReadingAfterSettings = active?.kind === 'reading' && active.id === selected;
  if (active) await api('pause');
  if (!settingsSaveError) {
    await flushSettingsSave();
    await fillSettings();
  }
  hideSettingsSecrets();
  $('#parser-config').open = false;
  $('#translation-config').open = false;
  $('#settings-dialog').showModal();
});
$('#settings-close').onclick = perform(async () => {
  try { await flushSettingsSave(); }
  catch (error) {
    resumeReadingAfterSettings = false;
    toast(`更改未保存：${error.message}。输入已保留，可重新打开设置修改。`);
  } finally { $('#settings-dialog').close(); }
});
$('#settings-dialog').addEventListener('cancel', event => { event.preventDefault(); $('#settings-close').click(); });
$('#settings-dialog').addEventListener('close', () => {
  const resume = resumeReadingAfterSettings, id = selected;
  resumeReadingAfterSettings = false;
  if (id) startParseIfReady(id).then(() => ensureReading(id, resume)).catch(error => toast(error.message));
});
$('#test-connection').onclick = perform(async () => {
  try { await flushSettingsSave(); $('#settings-result').textContent = '正在测试…'; $('#settings-result').textContent = await api('testConnection'); resumeReadingAfterSettings = true; }
  catch (error) { resumeReadingAfterSettings = false; $('#settings-result').textContent = `测试失败，本次测试已停止：${error.message}`; }
});
$('#data-folder').onclick = perform(() => api('dataFolder'));
$('#parser-api-link').onclick = perform(async event => { event.preventDefault(); await api('external', event.currentTarget.href); });
$('#about-open').onclick = () => $('#about-dialog').showModal();
$('#save-edit').onclick = perform(async () => { await api('edit', selected, editBlock, $('#edit-text').value); $('#edit-dialog').close(); await refreshLibrary(); await selectDocument(selected, true); });
$('#restore-edit').onclick = perform(async () => { await api('edit', selected, editBlock, null); $('#edit-dialog').close(); await refreshLibrary(); await selectDocument(selected, true); });

async function flushUpdates() {
  updateTimer = null; updating = true; updatePending = false;
  try {
    await refreshLibrary();
    if (selected) { await selectDocument(selected, true); await ensureReading(); }
    if (!active && selected) await startParseIfReady(selected);
  }
  catch (error) { toast(error.message); }
  finally { updating = false; if (updatePending) updateTimer = setTimeout(flushUpdates, 80); }
}
bridge.onUpdate(() => {
  updatePending = true;
  // Coalesce UI notifications only; the translation worker continues without waiting for rendering.
  if (!updating && !updateTimer) updateTimer = setTimeout(flushUpdates, 80);
});
refreshLibrary().then(async () => {
  const previous = localStorage.getItem('selected');
  if (items.some(item => item.id === previous)) await selectDocument(previous);
  if (selected) { await startParseIfReady(selected); await ensureReading(); }
}).catch(error => toast(error.message));
