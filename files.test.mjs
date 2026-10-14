import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { atomic, readZipEntry, documentDirectory } from './files.mjs';

test('MinerU ZIP entries decode with legacy streams and enforce extraction limits', async () => {
  const zip = new JSZip();
  const markdown = '# 中文论文\n\nFormula $x = 2$.\n';
  zip.file('full.md', markdown);
  zip.file('images/figure.png', Buffer.from([0, 1, 255, 12]));
  const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  assert.equal((await readZipEntry(loaded.file('full.md'), 1024)).toString('utf8'), markdown);
  assert.deepEqual(await readZipEntry(loaded.file('images/figure.png'), 4), Buffer.from([0, 1, 255, 12]));
  await assert.rejects(readZipEntry(loaded.file('full.md'), 5), /大小超限/);
});

test('Atomic saves survive locks, serialize overlapping writes and preserve old data on failure', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paperbridge-save-test-'));
  const file = path.join(dir, 'document.json');
  try {
    await atomic(file, 'old');
    const rename = fs.rename.bind(fs);
    let attempts = 0;
    const mock = t.mock.method(fs, 'rename', async (...args) => {
      if (++attempts <= 2) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
      return rename(...args);
    });
    await atomic(file, 'recovered');
    assert.equal(attempts, 3);
    assert.equal(await fs.readFile(file, 'utf8'), 'recovered');
    mock.mock.restore();
    await Promise.all(Array.from({ length: 30 }, (_, i) => atomic(file, JSON.stringify({ i }))));
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { i: 29 });
    const denied = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); });
    await assert.rejects(atomic(file, 'must not replace old data'), { code: 'EPERM' });
    assert.equal(denied.mock.callCount(), 8);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { i: 29 });
    denied.mock.restore();
    await atomic(file, 'saved after failure');
    assert.equal(await fs.readFile(file, 'utf8'), 'saved after failure');
    assert.deepEqual(await fs.readdir(dir), ['document.json']);
  } finally {
    t.mock.restoreAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Permanent removal validates the document folder and never follows nested junctions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paperbridge-permanent-delete-test-'));
  const id = '00000000-0000-0000-0000-000000000001', docs = path.join(dir, 'documents'), copy = path.join(docs, id), outside = path.join(dir, 'source');
  try {
    await fs.mkdir(copy, { recursive: true }); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'original.pdf'), 'source remains');
    await fs.writeFile(path.join(copy, 'translated.md'), 'translation');
    await fs.symlink(outside, path.join(copy, 'linked-assets'), 'junction');
    await assert.rejects(documentDirectory(docs, '../source'), /无效文档/);
    const target = await documentDirectory(docs, id);
    assert.equal(target.toLowerCase(), path.join(await fs.realpath(docs), id).toLowerCase());
    await fs.rm(target, { recursive: true });
    assert.equal(await fs.readFile(path.join(outside, 'original.pdf'), 'utf8'), 'source remains');
    await fs.symlink(outside, copy, 'junction');
    await assert.rejects(documentDirectory(docs, id), /路径异常/);
    await fs.unlink(copy);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Document folders support OS-redirection while explicit directory links remain rejected', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paperbridge-redirect-test-'));
  const id = '00000000-0000-0000-0000-000000000001', docs = path.join(dir, 'documents'), target = path.join(docs, id);
  try {
    await fs.mkdir(target, { recursive: true });
    const realpath = fs.realpath.bind(fs);
    t.mock.method(fs, 'realpath', file => file === target ? Promise.resolve(path.join(dir, 'OS-cache', id)) : realpath(file));
    assert.equal(await documentDirectory(docs, id), target);
    await assert.rejects(documentDirectory(docs, '../OS-cache'), /无效文档/);
  } finally { t.mock.restoreAll(); await fs.rm(dir, { recursive: true, force: true }); }
});
