import { describe, expect, it } from 'vitest';
import { EQ_CONFIG, EQ_FREQUENCIES } from '../../src/core/constants.js';
import { clamp, dbToGain, defaultEq, isEqValid, normalizeEq } from '../../src/core/eq.js';

describe('EQ 常量', () => {
  it('固定 10 个有序频段', () => {
    expect(EQ_FREQUENCIES).toHaveLength(10);
    expect(EQ_FREQUENCIES[0]).toBe(31);
    expect(EQ_FREQUENCIES.at(-1)).toBe(16000);
    expect(EQ_CONFIG.frequencies).toBe(EQ_FREQUENCIES);
  });
});

describe('normalizeEq', () => {
  it('缺失频段补 0，未知频段丢弃', () => {
    const eq = normalizeEq({
      bands: [
        { frequencyHz: 31, gainDb: 6 },
        { frequencyHz: 999, gainDb: 12 },
      ],
    });

    expect(eq.bands).toHaveLength(10);
    expect(eq.bands[0]).toEqual({ frequencyHz: 31, gainDb: 6 });
    expect(eq.bands[1]).toEqual({ frequencyHz: 62, gainDb: 0 });
    expect(eq.bands.some(band => band.frequencyHz === 999)).toBe(false);
  });

  it('截断超范围、四舍五入小数', () => {
    const eq = normalizeEq({
      preampDb: 99,
      bands: [
        { frequencyHz: 31, gainDb: 100 },
        { frequencyHz: 62, gainDb: -100 },
        { frequencyHz: 125, gainDb: 3.6 },
      ],
    });

    expect(eq.preampDb).toBe(3);
    expect(eq.bands[0].gainDb).toBe(12);
    expect(eq.bands[1].gainDb).toBe(-12);
    expect(eq.bands[2].gainDb).toBe(4);
  });

  it('null 输入返回平坦 EQ，且默认启用', () => {
    const eq = normalizeEq(null);

    expect(eq.enabled).toBe(true);
    expect(eq.preampDb).toBe(0);
    expect(eq.bands.every(band => band.gainDb === 0)).toBe(true);
  });

  it('显式 disabled 会保留', () => {
    expect(normalizeEq({ enabled: false }).enabled).toBe(false);
  });
});

describe('defaultEq', () => {
  it('返回平坦配置', () => {
    const eq = defaultEq();

    expect(eq.enabled).toBe(true);
    expect(eq.preampDb).toBe(0);
    expect(eq.bands).toHaveLength(10);
    expect(eq.bands.every(band => band.gainDb === 0)).toBe(true);
  });

  it('每次返回新对象', () => {
    expect(defaultEq()).not.toBe(defaultEq());
  });
});

describe('isEqValid', () => {
  it('只接受完整 10 段结构', () => {
    expect(isEqValid(defaultEq())).toBe(true);
    expect(isEqValid(null)).toBe(false);
    expect(isEqValid({ bands: [] })).toBe(false);
    expect(isEqValid({ bands: [{ frequencyHz: 31, gainDb: 0 }] })).toBe(false);
  });
});

describe('数值工具', () => {
  it('clamp 限制闭区间', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('dbToGain 换算正确', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6)).toBeCloseTo(1.9953, 4);
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 4);
  });
});
