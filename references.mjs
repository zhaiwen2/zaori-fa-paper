const numberPattern = '[A-Z]?\\d+(?:[.\\-]\\d+)*(?:[（(][a-z][）)])?|[一二三四五六七八九十百]+';
const referencePattern = new RegExp(`(\\b(?:fig(?:ure)?s?\\.?|tables?|tab\\.?|eq(?:uation)?s?\\.?)|公式|图|表|式)[ \\t]*[（(]?[ \\t]*(${numberPattern})[）)]?`, 'gi');
export const referenceNames = { figure: '图', table: '表', equation: '公式' };

export function referenceNumber(value) {
  let number = String(value ?? '').trim().replaceAll('（', '(').replaceAll('）', ')');
  if (/^[一二三四五六七八九十百]+$/.test(number)) {
    let total = 0, digit = 0;
    for (const char of number) {
      const unit = { 十: 10, 百: 100 }[char];
      if (unit) { total += (digit || 1) * unit; digit = 0; }
      else digit = '零一二三四五六七八九'.indexOf(char);
    }
    number = String(total + digit);
  }
  if (!/^[A-Z]?\d+(?:[.\-]\d+)*(?:\([a-z]\))?$/i.test(number)) return null;
  return number.replace(/^([a-z])/, prefix => prefix.toUpperCase()).replace(/\d+/g, digits => String(Number(digits))).replace(/\([A-Z]\)/g, suffix => suffix.toLowerCase());
}

export function findReferences(text) {
  return [...String(text).matchAll(referencePattern)].map(match => {
    const prefix = match[1].toLowerCase();
    const kind = /^(?:fig|图)/.test(prefix) ? 'figure' : /^(?:tab|表)/.test(prefix) ? 'table' : 'equation';
    const number = referenceNumber(match[2]);
    return { kind, number, key: `${kind}:${number}`, text: match[0], start: match.index, end: match.index + match[0].length };
  });
}

function captionNumber(text, kind) {
  const trimmed = String(text ?? '').trim();
  const reference = findReferences(trimmed)[0];
  if (reference?.kind === kind && reference.start === 0) return reference.number;
  if (kind === 'equation') {
    const match = trimmed.match(/^[(（]([^()（）]+)[)）]$/);
    if (match) return referenceNumber(match[1]);
  }
  return null;
}

export function buildReferenceIndex(blocks) {
  const targets = [], byKey = new Map();
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    for (const object of block.objects ?? []) {
      const neighbors = object.kind === 'table' ? [blocks[blockIndex - 1], blocks[blockIndex + 1]] : [blocks[blockIndex + 1], blocks[blockIndex - 1]];
      let number = referenceNumber(object.number) ?? captionNumber(object.label, object.kind) ?? captionNumber(block.text, object.kind);
      let description = object.label || block.text;
      if (!number) {
        for (const neighbor of neighbors) {
          // Don't borrow a label across another object of the same kind.
          if (!neighbor || neighbor.objects?.some(item => item.kind === object.kind)) continue;
          number = captionNumber(neighbor.text, object.kind);
          if (number) { description = neighbor.text; break; }
        }
      }
      const target = { ...object, id: `${block.id}:${object.kind}:${object.index}`, blockId: block.id, number,
        title: `${referenceNames[object.kind]} ${number ?? '（未编号）'} · ${String(description || '无标题').replace(/\s+/g, ' ').slice(0, 100)}` };
      targets.push(target);
      if (number) {
        const key = `${object.kind}:${number}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(target);
      }
    }
  }
  return { targets, byKey };
}

export function referenceCandidates(index, reference) {
  const exact = index.byKey.get(reference.key);
  if (exact?.length) return exact;
  const parent = index.byKey.get(`${reference.kind}:${reference.number.replace(/\([a-z]\)$/, '')}`);
  return parent?.length ? parent : index.targets.filter(target => target.kind === reference.kind);
}
