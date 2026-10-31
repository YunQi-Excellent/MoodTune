import { describe, expect, it } from 'vitest';
import {
  EFFECT_BLOCKS,
  activeEffectBlocks,
  defaultEffects,
  hasActiveEffects,
  isEffectsValid,
  normalizeEffects,
} from '../../src/core/effects.js';

describe('defaultEffects', () => {
  it('默认全旁路，且每次返回新对象', () => {
    const a = defaultEffects();
    const b = defaultEffects();

    expect(a.enabled).toBe(true);
    for (const block of EFFECT_BLOCKS) {
      expect(a[block].enabled, block).toBe(false);
    }
    expect(a).not.toBe(b);
    expect(a.width).not.toBe(b.width);
  });
});

describe('normalizeEffects', () => {
  it('空值回落到默认值', () => {
    expect(normalizeEffects(undefined)).toEqual(defaultEffects());
    expect(normalizeEffects(null)).toEqual(defaultEffects());
    expect(normalizeEffects('nope')).toEqual(defaultEffects());
  });

  it('超范围的值被截断', () => {
    const fx = normalizeEffects({
      width: { enabled: true, amount: 9 },
      crossfeed: { amount: -5, cutoffHz: 99999, delayMs: 99 },
      spatial: { amount: 3 },
      reverb: { wet: 4, durationMs: 999999, decay: 0, preDelayMs: 999 },
      dynamics: { thresholdDb: -999, ratio: 0, makeupDb: 99, drive: 8 },
    });

    expect(fx.width.amount).toBe(2);
    expect(fx.crossfeed.amount).toBe(0);
    expect(fx.crossfeed.cutoffHz).toBe(1500);
    expect(fx.crossfeed.delayMs).toBe(1.2);
    expect(fx.spatial.amount).toBe(1);
    expect(fx.reverb.wet).toBe(1);
    expect(fx.reverb.durationMs).toBe(4000);
    expect(fx.reverb.decay).toBe(0.6);
    expect(fx.reverb.preDelayMs).toBe(100);
    expect(fx.dynamics.thresholdDb).toBe(-60);
    expect(fx.dynamics.ratio).toBe(1);
    expect(fx.dynamics.makeupDb).toBe(12);
    expect(fx.dynamics.drive).toBe(1);
  });

  it('非数字回落成默认值', () => {
    const fx = normalizeEffects({
      width: { enabled: true, amount: 'abc' },
      reverb: { wet: Number.NaN },
    });

    expect(fx.width.amount).toBe(defaultEffects().width.amount);
    expect(fx.reverb.wet).toBe(defaultEffects().reverb.wet);
    expect(fx.width.enabled).toBe(true);
  });

  it('只认同 true 的开关，字符串不会被当成开启', () => {
    const fx = normalizeEffects({ width: { enabled: 'yes' }, reverb: { enabled: 1 } });
    expect(fx.width.enabled).toBe(false);
    expect(fx.reverb.enabled).toBe(false);
  });

  it('丢弃未知字段，保持结构稳定', () => {
    const fx = normalizeEffects({ width: { enabled: true, amount: 1, weird: 1 }, extra: 'x' });
    expect(Object.keys(fx).sort()).toEqual(['crossfeed', 'dynamics', 'enabled', 'reverb', 'spatial', 'width'].sort());
    expect(fx.width).not.toHaveProperty('weird');
    expect(fx).not.toHaveProperty('extra');
  });

  it('总开关缺省为开', () => {
    expect(normalizeEffects({}).enabled).toBe(true);
    expect(normalizeEffects({ enabled: false }).enabled).toBe(false);
  });
});

describe('isEffectsValid', () => {
  it('结构完整才算有效', () => {
    expect(isEffectsValid(defaultEffects())).toBe(true);
    expect(isEffectsValid(undefined)).toBe(false);
    expect(isEffectsValid({ width: {} })).toBe(false);
  });
});

describe('hasActiveEffects / activeEffectBlocks', () => {
  it('默认没有生效的块', () => {
    expect(hasActiveEffects(defaultEffects())).toBe(false);
    expect(activeEffectBlocks(defaultEffects())).toEqual([]);
  });

  it('启用任意块后开始生效', () => {
    const fx = defaultEffects();
    fx.reverb.enabled = true;
    expect(hasActiveEffects(fx)).toBe(true);
    expect(activeEffectBlocks(fx)).toEqual(['reverb']);
  });

  it('总开关关闭时一律视为未生效', () => {
    const fx = defaultEffects();
    fx.width.enabled = true;
    fx.enabled = false;
    expect(hasActiveEffects(fx)).toBe(false);
    expect(activeEffectBlocks(fx)).toEqual([]);
  });
});
