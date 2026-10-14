import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';

const writes = new Map();

export function atomic(file, data) {
  const key = path.resolve(file);
  const previous = writes.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(key), { recursive: true });
    const temp = `${key}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' });
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temp, key); break; }
        catch (error) {
          // Windows readers/indexers may briefly prevent replacement; never delete the old file.
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 7) throw error;
          await delay(Math.min(50 * 2 ** attempt, 500));
        }
      }
    } finally { await fs.unlink(temp).catch(() => {}); }
  });
  writes.set(key, pending);
  return pending.finally(() => { if (writes.get(key) === pending) writes.delete(key); });
}

export async function readZipEntry(entry, limit) {
  const chunks = []; let size = 0;
  // JSZip uses a legacy readable-stream without async iteration. Wrap it with Node's Readable.
  for await (const chunk of Readable.wrap(entry.nodeStream())) {
    size += chunk.length;
    if (size > limit) throw new Error('解析包实际解压大小超限。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function documentDirectory(documentsRoot, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('无效文档标识。');
  const base = await fs.realpath(documentsRoot), target = path.join(base, id);
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('文档目录路径异常，未删除任何文件。');
  // Windows can redirect ordinary AppData children; use the validated direct child, not a canonical-parent comparison.
  return target;
}

