export async function withTranslationTimeout(operation, { timeoutMs, message, signal, onTimeout } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('翻译超时时间无效。');
  const timeoutController = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  let timer, onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(requestSignal.reason);
    if (requestSignal.aborted) onAbort();
    else requestSignal.addEventListener('abort', onAbort, { once: true });
  });
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error(message ?? `翻译请求超过 ${Math.ceil(timeoutMs / 1000)} 秒，已强制停止。`), { code: 'TRANSLATION_TIMEOUT' });
      timeoutController.abort(error);
      try { onTimeout?.(); } catch { /* Timeout reporting must not mask the timeout itself. */ }
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => { requestSignal.throwIfAborted(); return operation(requestSignal); }), timedOut, cancelled]); }
  finally { clearTimeout(timer); requestSignal.removeEventListener('abort', onAbort); }
}
