import { blockDone } from './document.mjs';

export function prioritizeQueue(doc, ids, currentBlock = null) {
  const eligible = new Set(doc.blocks.filter(b => !b.preserve && !blockDone(b)).map(b => b.id));
  const queue = [...new Set([currentBlock, ...ids, ...(doc.readingQueue ?? [])])].filter(id => eligible.has(id));
  const changed = JSON.stringify(queue) !== JSON.stringify(doc.readingQueue ?? []);
  doc.readingQueue = queue;
  return changed;
}

export async function drainReadingQueue(doc, current, translate, persist, update, maxBatch = 1) {
  while (!current.pause) {
    prioritizeQueue(doc, []);
    const ids = doc.readingQueue.slice(0, Math.max(1, maxBatch));
    if (!ids.length) {
      if (doc.blocks.every(block => block.preserve || blockDone(block))) {
        doc.status = doc.blocks.some(block => !block.preserve) ? '翻译完成' : '无需翻译，已保留原文';
        return;
      }
      doc.status = '等待阅读新段落';
      // Install the wake-up before awaiting disk I/O, so scrolling cannot lose a notification.
      const awakened = new Promise(resolve => { current.wake = resolve; });
      await persist(); update();
      await awakened;
      current.wake = null;
      continue;
    }
    current.currentBlock = ids[0];
    await translate(ids.length === 1 ? ids[0] : ids);
    const completed = new Set(ids.filter(id => blockDone(doc.blocks.find(b => b.id === id))));
    if (completed.size) doc.readingQueue = doc.readingQueue.filter(item => !completed.has(item));
    current.currentBlock = null;
    await persist(); update();
  }
  doc.status = '已暂停';
}

