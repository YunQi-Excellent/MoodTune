/**
 * 中止语义：跨层取消统一用 AbortError。
 *
 * 各层都有「单条失败不影响整体」的兜底 catch（歌单挖取、专辑拉取、
 * cloudsearch 回退……）。用户点中断时，这些兜底不能把取消当成普通失败
 * 吞掉继续跑，所以统一用 `isAbortError` 判定并重新抛出。
 */

/** @param {string} [message] @returns {Error & {name: 'AbortError'}} */
export function abortError(message = '已中止') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** @param {unknown} error */
export function isAbortError(error) {
  return error?.name === 'AbortError';
}

/** 已中止就抛 AbortError；没有 signal 时是空操作。 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/**
 * 把多个 signal 合成一个：任意一个中止就中止。
 * 用于「用户手动中断」+「本次检索预算超时」同时约束下游请求。
 */
export function combineSignals(...signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);

  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) { controller.abort(); break; }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * 给 signal 叠加一个可取消的超时。
 * 返回的 `cancel()` 必须调用，否则定时器会一直挂到超时（浏览器里无害，
 * 但测试/批处理会被拖住）。
 */
export function createTimeoutSignal(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: combineSignals(signal, controller.signal),
    cancel: () => clearTimeout(timer),
  };
}
