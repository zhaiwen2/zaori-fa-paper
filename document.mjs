import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { parseFragment } from 'parse5';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true });

function htmlTableNode(node) {
  if (node.type !== 'html' || node.children || !/<table(?:\s|>)/i.test(node.value)) return node;
  const children = [];
  const protectedTags = new Set(['script', 'style', 'code', 'pre', 'math', 'svg']);
  function collect(element, inTable = false, inCell = false) {
    if (protectedTags.has(element.tagName)) return;
    inTable ||= element.tagName === 'table';
    inCell ||= inTable && ['td', 'th', 'caption'].includes(element.tagName);
    const location = element.sourceCodeLocation;
    if (inCell && element.nodeName === '#text' && element.value.trim() && location) {
      const text = element.value, fragments = []; let start = 0;
      const add = (type, end) => {
        if (end > start) fragments.push({ type, value: text.slice(start, end), position: { start: { offset: start }, end: { offset: end } } });
        start = end;
      };
      // Keep both Markdown and LaTeX bracket delimiters outside translation requests.
      for (const match of text.matchAll(/(?<!\\)\$\$[\s\S]+?(?<!\\)\$\$|(?<!\\)\$[^$\n]+?(?<!\\)\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g)) {
        add('text', match.index); add('inlineMath', match.index + match[0].length);
      }
      add('text', text.length);
      children.push({ type: 'htmlText', value: text, htmlRange: { start: location.startOffset, end: location.endOffset }, children: fragments });
    }
    for (const child of element.childNodes ?? []) collect(child, inTable, inCell);
  }
  collect(parseFragment(node.value, { sourceCodeLocationInfo: true }));
  return children.length ? { ...node, children } : node;
}

function translatedHtml(node) {
  let html = node.value;
  for (const segment of [...node.children].reverse()) {
    let text = segment.value;
    for (const child of [...segment.children].reverse()) {
      if (child.type === 'text') text = text.slice(0, child.position.start.offset) + child.value + text.slice(child.position.end.offset);
    }
    const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    html = html.slice(0, segment.htmlRange.start) + escaped + html.slice(segment.htmlRange.end);
  }
  return html;
}

export const stringify = nodes => processor.stringify({ type: 'root', children: nodes });

export function walk(node, visit, path = []) {
  visit(node, path);
  node.children?.forEach((child, i) => walk(child, visit, [...path, i]));
}

const inlineTypes = new Set(['text', 'emphasis', 'strong', 'delete', 'link']);
function inlineLength(node) {
  return typeof node.value === 'string' ? node.value.length : (node.children ?? []).reduce((sum, child) => sum + inlineLength(child), 0);
}
function sliceInline(node, start, end) {
  if (node.type === 'text') return { ...node, value: node.value.slice(start, end) };
  const length = inlineLength(node);
  if (!inlineTypes.has(node.type)) return start === 0 && end >= length ? structuredClone(node) : null;
  let offset = 0;
  const children = [];
  for (const child of node.children ?? []) {
    const length = inlineLength(child), from = Math.max(0, start - offset), to = Math.min(length, end - offset);
    if (to > from) {
      const sliced = sliceInline(child, from, to);
      if (sliced) children.push(sliced);
    }
    offset += length;
  }
  return { ...node, children };
}
function splitLongParagraph(node, limit = 360) {
  if (!node.children?.length) return [node];
  if (node.children.some((child, index) => child.type === 'text' && node.children[index - 1]?.type === 'text')) {
    const children = structuredClone(node.children);
    for (let index = children.length - 1; index > 0; index--) {
      if (children[index].type === 'text' && children[index - 1].type === 'text') {
        children[index - 1].value += children[index].value; children.splice(index, 1);
      }
    }
    node = { ...node, children };
  }
  const text = node.children.map(flattenInline).join('');
  if (text.length <= limit) return [node];
  const atomic = [];
  function collectAtomic(child, offset) {
    const length = inlineLength(child);
    if (child.type === 'text') return offset + length;
    if (!inlineTypes.has(child.type)) {
      if (!length) atomic.push({ start: offset, end: offset });
      else atomic.push({ start: offset, end: offset + length });
      return offset + length;
    }
    for (const nested of child.children ?? []) offset = collectAtomic(nested, offset);
    return offset;
  }
  let offset = 0;
  for (const child of node.children) offset = collectAtomic(child, offset);
  if (atomic.some(item => item.start === item.end)) return [node];
  const boundaries = [];
  for (let i = 0; i < text.length; i++) {
    if (!'。！？.!?'.includes(text[i])) continue;
    let end = i + 1;
    while (/[”’"'）)\]]/.test(text[end] ?? '')) end++;
    let next = end;
    while (/\s/.test(text[next] ?? '')) next++;
    if ('。！？'.includes(text[i]) || (next > end && /[A-Z0-9“"'(]/.test(text[next] ?? ''))) boundaries.push(end);
  }
  const chunks = [];
  let boundaryCursor = 0;
  for (let start = 0; start < text.length;) {
    const max = Math.min(text.length, start + limit);
    while (boundaries[boundaryCursor] <= start) boundaryCursor++;
    let end = 0;
    for (let index = boundaryCursor; boundaries[index] && boundaries[index] <= max; index++) {
      if (boundaries[index] - start >= limit / 3) end = boundaries[index];
    }
    if (max === text.length) end = max;
    if (!end) {
      const whitespace = text.lastIndexOf(' ', max);
      end = whitespace > start + Math.floor(limit / 2) ? whitespace : max;
    }
    // Balance a short tail instead of translating its final word on its own.
    if (end < text.length && text.slice(end).trim().length < 72) {
      const middle = start + Math.floor((text.length - start) / 2);
      const whitespace = text.lastIndexOf(' ', middle);
      end = whitespace > start && text.length - whitespace <= limit ? whitespace : middle;
    }
    while (end < text.length && /[A-Za-z0-9]/.test(text[end - 1]) && /[A-Za-z0-9]/.test(text[end])) end++;
    const indivisible = atomic.find(item => item.start < end && item.end > end);
    if (indivisible) end = indivisible.end;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    const children = [];
    let offset = 0;
    for (const child of node.children) {
      const length = inlineLength(child), from = Math.max(0, start - offset), to = Math.min(length, end - offset);
      if (to > from) {
        const sliced = sliceInline(child, from, to);
        if (sliced) children.push(sliced);
      }
      offset += length;
    }
    chunks.push({ ...node, children });
    start = end;
  }
  return chunks;
}
function flattenInline(node) {
  return typeof node.value === 'string' ? node.value : (node.children ?? []).map(flattenInline).join('');
}

function parts(text) {
  // ponytail: conservative character budget; add model tokenizers if large-document usage warrants it.
  const result = [];
  let rest = text;
  while (rest.length > 1800) {
    let end = Math.max(rest.lastIndexOf(' ', 1800), rest.lastIndexOf('\n', 1800));
    if (end < 900) end = 1800;
    else end++;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    result.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) result.push(rest);
  return result;
}

export function units(block) {
  if (block.preserve) return [];
  const result = [];
  walk(block.node, (node, path) => {
    if (node.type !== 'text' || !node.value.trim()) return;
    parts(node.value).forEach((text, i) => {
      if (text.trim()) result.push({ id: `${path.join('.')}:${i}`, text, path, part: i });
    });
  });
  return result;
}

export function createBlocks(markdown) {
  let references = false;
  return processor.parse(markdown).children.flatMap((node, i) => {
    node = htmlTableNode(node);
    if (node.type === 'heading') {
      let label = '';
      walk(node, child => { if (child.type === 'text') label += child.value; });
      references = /^(?:references|bibliography|参考文献)\s*$/i.test(label.trim());
    }
    const chunks = !references && node.type === 'paragraph' ? splitLongParagraph(node) : [node];
    return chunks.map((chunk, part) => {
      const block = { id: chunks.length > 1 ? `b${i}-${part + 1}` : `b${i}`, node: chunk, values: {}, edit: null, error: '', preserve: references };
      if (!units(block).length) block.preserve = true;
      return block;
    });
  });
}

export function rechunkPendingBlocks(blocks) {
  const joined = [];
  let references = false;
  for (let block of blocks) {
    if (block.node.type === 'heading') references = /^(?:references|bibliography|参考文献)\s*$/i.test(flattenInline(block.node).trim());
    const prepared = htmlTableNode(block.node);
    if (prepared !== block.node) block = { ...block, node: prepared, preserve: references || !units({ node: prepared, preserve: false }).length };
    const previous = joined.at(-1), suffix = block.id.match(/^(b\d+(?:-\d+)*)-(\d+)$/), preceding = previous?.id.match(/^(b\d+(?:-\d+)*)-(\d+)$/);
    if (!suffix || suffix[1] !== preceding?.[1] || Number(suffix[2]) !== Number(preceding[2]) + 1 ||
      block.node.type !== 'paragraph' || previous.node.type !== 'paragraph' || block.preserve || previous.preserve ||
      block.edit !== null || previous.edit !== null || flattenInline(block.node).trim().length >= 72) {
      joined.push(block); continue;
    }
    const offset = previous.node.children.length;
    const rebase = entries => Object.fromEntries(Object.entries(entries ?? {}).map(([id, value]) => [id.replace(/^\d+/, index => String(Number(index) + offset)), value]));
    const values = { ...previous.values, ...rebase(block.values) };
    const children = structuredClone([...previous.node.children, ...block.node.children]);
    joined[joined.length - 1] = { ...previous, node: { ...previous.node, children }, values, error: previous.error || block.error };
  }
  return joined.flatMap(block => {
    if (block.node.type !== 'paragraph' || block.preserve || block.edit != null || Object.keys(block.values ?? {}).length) return [block];
    const chunks = splitLongParagraph(block.node);
    if (chunks.length < 2) return [chunks[0] === block.node ? block : { ...block, node: chunks[0] }];
    return chunks.map((node, index) => ({ ...block, id: `${block.id}-${index + 1}`, node }));
  });
}

export function checkBlockIds(ids) {
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^b\d+(?:-\d+)*$/.test(id))) {
    throw new Error('无效的阅读段落。');
  }
}

export function blockDone(block) {
  return block.edit !== null || units(block).every(unit => typeof block.values[unit.id] === 'string');
}

export function pendingUnits(block) {
  if (block.edit !== null) return [];
  return units(block).filter(unit => typeof block.values[unit.id] !== 'string');
}

export function translatedNode(block) {
  if (block.edit !== null) return processor.parse(block.edit).children;
  const node = structuredClone(block.node);
  walk(node, (child, path) => {
    if (child.type !== 'text' || !child.value.trim()) return;
    child.value = parts(child.value).map((text, i) => block.values[`${path.join('.')}:${i}`] ?? text).join('');
  });
  if (node.type === 'html' && node.children) node.value = translatedHtml(node);
  return [node];
}

export function progress(doc) {
  const blocks = doc.blocks ?? [];
  const translatable = blocks.filter(block => !block.preserve);
  return {
    total: translatable.length,
    done: translatable.filter(blockDone).length,
    failed: translatable.filter(block => block.error).length,
    preserved: blocks.filter(block => block.preserve).length,
  };
}

export function view(doc) {
  const definitions = (doc.blocks ?? []).filter(block => block.node.type === 'definition').map(block => block.node);
  return {
    id: doc.id, title: doc.title, kind: doc.kind, status: doc.status, error: doc.error,
    created: doc.created, progress: progress(doc), usage: doc.usage, run: doc.run, readingQueue: doc.readingQueue ?? [],
    hasPdf: doc.kind === 'pdf', warnings: doc.warnings ?? [],
    blocks: (doc.blocks ?? []).map(block => ({
      id: block.id,
      source: stringify([block.node, ...definitions]),
      target: stringify([...translatedNode(block), ...definitions]),
      editable: stringify(translatedNode(block)),
      heading: block.node.type === 'heading',
      preserved: block.preserve, edited: block.edit !== null, done: blockDone(block), error: block.error,
      partial: Object.keys(block.values).length > 0,
      hidden: block.node.type === 'definition',
    })),
  };
}

export function exportMarkdown(doc, mode, assetPrefix = '') {
  let out = [];
  for (const block of doc.blocks) {
    if (mode === 'original' || block.preserve) out.push(block.node);
    else {
      if (mode === 'bilingual') out.push(block.node);
      if (!blockDone(block)) out.push({ type: 'paragraph', children: [{ type: 'text', value: '【本段尚未完整翻译，以下可能含原文】' }] });
      out.push(...translatedNode(block));
    }
  }
  if (assetPrefix) {
    out = structuredClone(out);
    const root = { children: out }, imageReferences = new Set();
    const relocate = url => url && !/^(?:[a-z][a-z\d+.-]*:|[/\\#])/i.test(url) ? assetPrefix + url : url;
    walk(root, node => { if (node.type === 'imageReference') imageReferences.add(node.identifier); });
    walk(root, node => {
      if (node.type === 'image' || (node.type === 'definition' && imageReferences.has(node.identifier))) node.url = relocate(node.url);
      if (node.type !== 'html') return;
      const replacements = [];
      function collect(element) {
        if (element.tagName === 'img') {
          const src = element.attrs.find(attr => attr.name === 'src')?.value, location = element.sourceCodeLocation?.attrs?.src;
          if (location && src && relocate(src) !== src) replacements.push({ ...location, value: `src="${relocate(src).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"` });
        }
        for (const child of element.childNodes ?? []) collect(child);
      }
      collect(parseFragment(node.value, { sourceCodeLocationInfo: true }));
      for (const item of replacements.sort((a, b) => b.startOffset - a.startOffset)) node.value = node.value.slice(0, item.startOffset) + item.value + node.value.slice(item.endOffset);
    });
  }
  return stringify(out);
}

export function validateTranslations(input, output) {
  if (!Array.isArray(output) || output.length !== input.length) throw new Error('译文段数不匹配，请重试当前段落。');
  const map = new Map();
  for (const item of output) {
    if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim() || map.has(item.id)) {
      throw new Error('翻译返回了空文本、重复标识或无效格式。');
    }
    map.set(item.id, item.text);
  }
  return Object.fromEntries(input.map(unit => {
    if (!map.has(unit.id)) throw new Error('翻译返回的段落标识不匹配。');
    const value = map.get(unit.id).trim();
    return [unit.id, (unit.text.match(/^\s*/)?.[0] ?? '') + value + (unit.text.match(/\s*$/)?.[0] ?? '')];
  }));
}
