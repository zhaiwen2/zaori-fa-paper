import { blockDone, pendingUnits, progress, validateTranslations } from './document.mjs';

export const MAX_TRANSLATION_SEGMENTS = 200;
const MAX_CHARACTERS = 22500;
export const CLOUD_TRANSLATION_DEFAULTS = { cloudBatchSegments: 20, cloudBatchCharacters: 4000, cloudRequestIntervalSeconds: 3.1 };

export function edgeLanguageCode(value, target = false) {
  const name = String(value ?? '').trim().toLowerCase();
  const code = ({ english: 'en', '英语': 'en', '英文': 'en', chinese: 'zh-Hans', '中文': 'zh-Hans', '简体中文': 'zh-Hans', zh: 'zh-Hans', 'zh-cn': 'zh-Hans', 'zh-chs': 'zh-Hans', 'zh-hans': 'zh-Hans', '繁体中文': 'zh-Hant', 'zh-tw': 'zh-Hant', 'zh-cht': 'zh-Hant', 'zh-hant': 'zh-Hant', japanese: 'ja', '日语': 'ja', korean: 'ko', '韩语': 'ko', french: 'fr', '法语': 'fr', german: 'de', '德语': 'de', spanish: 'es', '西班牙语': 'es', '自动': 'auto' })[name] ?? name;
  if (code === 'auto' && !target) return '';
  if (!/^[a-z]{2,3}(?:-[a-zA-Z]{2,8})?$/.test(code) || code === 'auto') throw new Error('Edge 语言请填写语言代码（如 en、zh-Hans、ja）或英语、简体中文；原文语言可填写 auto。');
  return code;
}

export function edgeTranslationValues(segments, result) {
  if (!Array.isArray(result) || result.length !== segments.length) throw new Error('Edge 返回的译文数量与请求不一致，本次结果未保存。');
  return validateTranslations(segments, result.map((item, index) => ({ id: segments[index].id, text: item?.translations?.[0]?.text })));
}

export function translationEndpoint(config) {
  if (config.provider === 'edge') {
    const url = new URL('https://edge.microsoft.com/translate/translatetext');
    url.searchParams.set('from', edgeLanguageCode(config.sourceLang));
    url.searchParams.set('to', edgeLanguageCode(config.targetLang, true));
    return url.href;
  }
  const url = new URL(config.baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (config.provider === 'local-api' && !loopback) throw new Error('本地服务地址必须使用 localhost、127.0.0.1 或 [::1]。');
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('服务地址必须使用 HTTPS；本机服务允许 HTTP。地址不能包含密码或查询参数。');
  }
  return url.href.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
}

export function translationSnapshot(settings) {
  const { provider = 'edge', sourceLang, targetLang, glossary } = settings;
  return { provider, sourceLang, targetLang, glossary: provider === 'edge' ? '' : glossary,
    baseUrl: provider === 'edge' ? 'https://edge.microsoft.com/translate/translatetext' : provider === 'local-api' ? settings.localBaseUrl : settings.baseUrl,
    model: provider === 'edge' ? '' : provider === 'local-api' ? settings.localModel : settings.model,
    ...(provider === 'local-api' ? { batchCharacters: settings.localBatchCharacters ?? 3000 } : {}),
    ...(provider === 'chat' ? { batchSegments: settings.cloudBatchSegments ?? CLOUD_TRANSLATION_DEFAULTS.cloudBatchSegments,
      batchCharacters: settings.cloudBatchCharacters ?? CLOUD_TRANSLATION_DEFAULTS.cloudBatchCharacters,
      requestIntervalMs: (settings.cloudRequestIntervalSeconds ?? CLOUD_TRANSLATION_DEFAULTS.cloudRequestIntervalSeconds) * 1000 } : {}),
  };
}

function batchLimits(config) {
  return { segments: config.provider === 'chat' ? config.batchSegments ?? CLOUD_TRANSLATION_DEFAULTS.cloudBatchSegments : config.provider === 'local-api' ? 80 : MAX_TRANSLATION_SEGMENTS,
    characters: config.provider === 'chat' ? config.batchCharacters ?? CLOUD_TRANSLATION_DEFAULTS.cloudBatchCharacters : config.provider === 'local-api' ? config.batchCharacters ?? 3000 : MAX_CHARACTERS };
}

export function adoptTranslationRun(doc, config, fresh = false) {
  if (doc.run && !fresh) {
    const language = value => { try { return edgeLanguageCode(value); } catch { return String(value).trim().toLowerCase(); } };
    const switched = ['local', 'baidu'].includes(doc.run.provider) || doc.run.provider !== config.provider;
    const fields = switched ? ['sourceLang', 'targetLang'] : ['sourceLang', 'targetLang', 'glossary'];
    if (fields.some(key => key === 'glossary' ? (doc.run[key] ?? '') !== (config[key] ?? '') : language(doc.run[key]) !== language(config[key]))) {
      throw new Error('翻译设置已改变。请恢复旧语言与设置，或选择“重译”创建新结果。');
    }
    if (switched || doc.run.baseUrl !== config.baseUrl || doc.run.model !== config.model) {
      doc.runHistory ??= [];
      doc.runHistory.push(doc.run);
    }
  }
  doc.run = config;
}

// Estimates and all translation entry points use the same request boundaries.
export function createTranslationBatches(blocks, config = {}) {
  const limits = batchLimits(config);
  const batches = [];
  let batch = [], characters = 0;
  for (const block of blocks) {
    if (block.preserve || blockDone(block)) continue;
    for (const unit of pendingUnits(block)) {
      if (unit.text.length > limits.characters) throw new Error('文本片段超过单次字数上限，请调高上限或拆分 Markdown 后重试。');
      if (batch.length && (batch.length >= limits.segments || characters + unit.text.length > limits.characters)) {
        batches.push(batch); batch = []; characters = 0;
      }
      batch.push({ block, unit, id: `${block.id}::${unit.id}` });
      characters += unit.text.length;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function readingBatchIds(doc, visibleIds, config = {}) {
  const limits = batchLimits(config);
  const visible = doc.blocks.filter(block => visibleIds.includes(block.id) && !block.preserve && !blockDone(block));
  if (!visible.length) return [];
  const following = doc.blocks.slice(doc.blocks.indexOf(visible.at(-1)) + 1);
  const ids = []; let segments = 0, characters = 0;
  for (const block of [...visible, ...following]) {
    if (block.preserve || blockDone(block)) continue;
    const pending = pendingUnits(block), size = pending.reduce((sum, unit) => sum + unit.text.length, 0);
    // Prefetch complete neighboring blocks, so a tiny remainder doesn't create another request.
    if (ids.length && (segments + pending.length > limits.segments || characters + size > limits.characters)) break;
    ids.push(block.id); segments += pending.length; characters += size;
  }
  return ids;
}

export async function translateBlocks(doc, current, blocks, send, persist, update, describeError = error => error.message, maxRequests = Infinity, config = {}) {
  for (const records of createTranslationBatches(blocks, config).slice(0, maxRequests)) {
    if (current.pause) break;
    const changed = new Set(records.map(record => record.block));
    for (const block of changed) block.error = '';
    const p = progress(doc);
    doc.status = `正在批量翻译 ${p.done}/${p.total} 段`;
    await persist(); update();
    try {
      const result = await send(records.map(record => ({ id: record.id, text: record.unit.text })));
      for (const { block, unit, id } of records) {
        block.values[unit.id] = result.values[id];
      }
      doc.usage ??= {};
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        if (Number.isFinite(result.usage?.[key])) doc.usage[key] = (doc.usage[key] ?? 0) + result.usage[key];
      }
      await persist(); update();
    } catch (error) {
      if (current.pause && error?.name === 'AbortError') break;
      for (const block of changed) block.error = describeError(error);
      throw error;
    }
  }
}
