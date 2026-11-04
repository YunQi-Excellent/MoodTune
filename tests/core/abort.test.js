import { describe, expect, it } from 'vitest';
import {
  abortError,
  combineSignals,
  createTimeoutSignal,
  isAbortError,
  throwIfAborted,
} from '../../src/core/abort.js';

describe('abort 工具', () => {
  it('没有 signal 或未中止时是空操作', () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('已中止时抛 AbortError', () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => throwIfAborted(controller.signal)).toThrow('已中止');
    try {
      throwIfAborted(controller.signal);
    } catch (error) {
      expect(error.name).toBe('AbortError');
      expect(isAbortError(error)).toBe(true);
    }
  });

  it('abortError 可带自定义信息', () => {
    expect(abortError('换个说法').message).toBe('换个说法');
  });

  it('isAbortError 只认 name', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    expect(isAbortError(new Error('已中止'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe('combineSignals', () => {
  it('任意一个 signal 中止就中止', () => {
    const user = new AbortController();
    const budget = new AbortController();
    const combined = combineSignals(user.signal, budget.signal);

    expect(combined.aborted).toBe(false);
    budget.abort();
    expect(combined.aborted).toBe(true);
  });

  it('已经中止的 signal 会立刻传染', () => {
    const user = new AbortController();
    user.abort();

    const combined = combineSignals(user.signal, new AbortController().signal);
    expect(combined.aborted).toBe(true);
  });

  it('没有 signal 时返回 undefined，单个 signal 原样返回', () => {
    expect(combineSignals()).toBeUndefined();
    const controller = new AbortController();
    expect(combineSignals(controller.signal)).toBe(controller.signal);
  });
});

describe('createTimeoutSignal', () => {
  it('超时后 signal 中止', async () => {
    const timeout = createTimeoutSignal(undefined, 10);
    expect(timeout.signal.aborted).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(timeout.signal.aborted).toBe(true);
    timeout.cancel();
  });

  it('cancel 之后不再触发，也不拖住事件循环', async () => {
    const timeout = createTimeoutSignal(undefined, 10);
    timeout.cancel();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(timeout.signal.aborted).toBe(false);
  });

  it('用户先中止时立刻传染', () => {
    const user = new AbortController();
    const timeout = createTimeoutSignal(user.signal, 60_000);
    user.abort();
    expect(timeout.signal.aborted).toBe(true);
    timeout.cancel();
  });
});
