import { setTimeout as delay } from 'node:timers/promises';

export const TRANSLATION_REQUEST_INTERVAL_MS = 3100;

// The app has one worker. Its shared gate also covers connection tests and retries.
export function createTranslationLimiter({ now = Date.now, sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  let lastRequestAt = now();
  return async (send, { signal, intervalMs = TRANSLATION_REQUEST_INTERVAL_MS, onWait = async () => {}, onReady = async () => {} } = {}) => {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('无效请求间隔。');
    const until = lastRequestAt + intervalMs;
    signal?.throwIfAborted();
    const wait = Math.max(0, until - now());
    if (wait) {
      await onWait(wait, until);
      signal?.throwIfAborted();
      const remaining = Math.max(0, until - now());
      if (remaining) await sleep(remaining, signal);
    }
    signal?.throwIfAborted();
    await onReady();
    signal?.throwIfAborted();
    lastRequestAt = now();
    return send();
  };
}
