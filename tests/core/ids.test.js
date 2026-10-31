import { describe, expect, it } from 'vitest';
import { createId } from '../../src/core/ids.js';

describe('createId', () => {
  it('带前缀且可注入时间与随机源', () => {
    const id = createId('msg', 1700000000000, () => 0.5);

    expect(id.startsWith('msg-')).toBe(true);
    expect(id).toBe(createId('msg', 1700000000000, () => 0.5));
  });

  it('不同时间生成不同 ID', () => {
    expect(createId('msg', 1, () => 0.5)).not.toBe(createId('msg', 2, () => 0.5));
  });

  it('不同前缀互不混淆', () => {
    expect(createId('eq', 1, () => 0.5).startsWith('eq-')).toBe(true);
    expect(createId('sess', 1, () => 0.5).startsWith('sess-')).toBe(true);
  });
});
