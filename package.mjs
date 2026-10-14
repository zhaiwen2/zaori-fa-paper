import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { packager } from '@electron/packager';
import { build } from 'esbuild';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import assert from 'node:assert/strict';
import { listPackage, extractFile } from '@electron/asar';

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 环境打包此桌面版本。');
const { version } = JSON.parse(await fs.readFile(path.join(here, 'node_modules/electron/package.json'), 'utf8'));
const cache = path.join(os.tmpdir(), 'paperbridge-electron-cache');
const archive = path.join(cache, `electron-v${version}-win32-x64.zip`);
try { await fs.access(archive); }
catch {
  const zip = new JSZip(), runtime = path.join(here, 'node_modules/electron/dist');
  async function addFiles(relative = '') {
    for (const item of await fs.readdir(path.join(runtime, relative), { withFileTypes: true })) {
      const next = path.join(relative, item.name);
      if (item.isDirectory()) await addFiles(next);
      else if (item.isFile()) zip.file(next.split(path.sep).join('/'), await fs.readFile(path.join(runtime, next)));
    }
  }
  await addFiles();
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
}
// Package an explicit staging directory so user data and unused dependencies never ship.
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'paperbridge-package-'));
try {
  const common = { absWorkingDir: here, bundle: true, minify: true, metafile: true, legalComments: 'inline' };
  const main = await build({ ...common, entryPoints: ['main.mjs'], outfile: path.join(stage, 'main.mjs'),
    platform: 'node', format: 'esm', external: ['electron'],
    banner: { js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);" } });
  const renderer = await build({ ...common, entryPoints: ['renderer.js'], outfile: path.join(stage, 'dist/renderer.js'), platform: 'browser' });
  for (const name of ['preload.cjs', 'index.html', 'style.css', 'sample.md', 'LICENSE']) await fs.copyFile(path.join(here, name), path.join(stage, name));
  const katex = path.join(stage, 'node_modules/katex/dist');
  await fs.mkdir(katex, { recursive: true });
  await fs.copyFile(path.join(here, 'node_modules/katex/dist/katex.min.css'), path.join(katex, 'katex.min.css'));
  await fs.cp(path.join(here, 'node_modules/katex/dist/fonts'), path.join(katex, 'fonts'), { recursive: true });
  const packages = new Set([path.join(here, 'node_modules/katex')]);
  for (const input of [...Object.keys(main.metafile.inputs), ...Object.keys(renderer.metafile.inputs)]) {
    if (!input.replaceAll('\\', '/').startsWith('node_modules/')) continue;
    let directory = path.dirname(path.resolve(here, input));
    while (directory !== here) {
      try { await fs.access(path.join(directory, 'package.json')); packages.add(directory); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; directory = path.dirname(directory); }
    }
  }
  const notices = [];
  for (const directory of [...packages].sort()) {
    const info = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    for (const name of await fs.readdir(directory)) {
      if (!/^(licen[sc]e|copying|notice)(\.|$)/i.test(name) || !(await fs.stat(path.join(directory, name))).isFile()) continue;
      notices.push(`${info.name} ${info.version} — ${name}\n${await fs.readFile(path.join(directory, name), 'utf8')}`);
    }
  }
  assert.ok(notices.length > 0);
  await fs.writeFile(path.join(stage, 'THIRD-PARTY-LICENSES.txt'), notices.join('\n\n--------------------\n\n'));
  const metadata = JSON.parse(await fs.readFile(path.join(here, 'package.json'), 'utf8'));
  for (const name of ['scripts', 'dependencies', 'devDependencies']) delete metadata[name];
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(metadata, null, 2));
  const [output] = await packager({ dir: stage, name: metadata.productName, platform: 'win32', arch: 'x64',
    out: path.join(here, 'release', metadata.version), overwrite: true, electronVersion: version, electronZipDir: cache, prune: false });
  for (const name of await fs.readdir(path.join(output, 'locales'))) {
    if (['zh-CN.pak', 'en-US.pak'].includes(name)) continue;
    const target = path.resolve(output, 'locales', name);
    assert.equal(path.dirname(target), path.resolve(output, 'locales'));
    await fs.unlink(target);
  }
  const appArchive = path.join(output, 'resources/app.asar');
  const entries = listPackage(appArchive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
  const expected = new Set(['main.mjs', 'preload.cjs', 'index.html', 'style.css', 'sample.md', 'LICENSE', 'package.json', 'THIRD-PARTY-LICENSES.txt', 'dist', 'node_modules']);
  assert.ok(entries.every(name => expected.has(name.split('/')[0])), 'Unexpected application file');
  assert.ok(entries.filter(name => name.startsWith('node_modules/')).every(name => /^node_modules\/(katex(?:\/dist(?:\/fonts(?:\/[^/]+)?|\/katex\.min\.css)?)?)?$/.test(name)), 'Unexpected dependency file');
  for (const name of ['main.mjs', 'dist/renderer.js', 'preload.cjs', 'package.json']) {
    assert.equal(/\bsk-[A-Za-z0-9_-]{20,}|\b[a-f0-9]{32}\.[A-Za-z0-9]{8,}\b/.test(extractFile(appArchive, path.normalize(name)).toString()), false, 'Credential-like value in ' + name);
  }
  await fs.copyFile(path.join(stage, 'LICENSE'), path.join(output, 'PaperBridge-LICENSE.txt'));
  await fs.copyFile(path.join(stage, 'THIRD-PARTY-LICENSES.txt'), path.join(output, 'THIRD-PARTY-LICENSES.txt'));
  await fs.writeFile(path.join(output, '使用说明.txt'), '\uFEFF' + [
    '早日发Paper · Windows 64 位便携版', '',
    '完整解压整个压缩包，双击早日发Paper.exe 启动；不要只复制 EXE。',
    '默认 Edge 在线翻译，需要联网。解析 PDF 需要在“API 与偏好设置”填写自己的 MinerU 密钥。',
    '也可配置自己的大模型 API 或已运行的本地模型服务，无需安装 Node.js 或 Python。',
    '本包不含任何个人文档、已保存密钥、缓存译文或本地模型。',
    '个人数据保存在各自的 Windows 用户数据目录，请勿将该目录分享给他人。',
    '软件未进行代码签名，Windows 可能显示发布者提示。',
  ].join('\r\n'));
  const zip = new JSZip();
  async function add(relative = '') {
    for (const item of await fs.readdir(path.join(output, relative), { withFileTypes: true })) {
      const next = path.join(relative, item.name);
      if (item.isDirectory()) await add(next);
      else { assert.ok(item.isFile()); zip.file(metadata.productName + '/' + next.replaceAll('\\', '/'), await fs.readFile(path.join(output, next))); }
    }
  }
  await add();
  const shareArchive = path.join(here, 'release', `${metadata.productName}-${metadata.version}-Windows-x64-slim.zip`);
  console.log('正在压缩精简发行版…');
  await pipeline(zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 9 } }), createWriteStream(shareArchive));
  const checked = await JSZip.loadAsync(await fs.readFile(shareArchive), { checkCRC32: true });
  assert.ok((await checked.file(metadata.productName + '/resources/app.asar').async('nodebuffer')).equals(await fs.readFile(appArchive)));
  console.log(JSON.stringify({ output, archive: shareArchive, bytes: (await fs.stat(shareArchive)).size, appBytes: (await fs.stat(appArchive)).size, appEntries: entries.length }));
} finally {
  assert.equal(path.dirname(stage), path.resolve(os.tmpdir()));
  await fs.rm(stage, { recursive: true, force: true });
}
