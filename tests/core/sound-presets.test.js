import { describe, expect, it } from 'vitest';
import { EQ_FREQUENCIES } from '../../src/core/constants.js';
import { defaultEffects, hasActiveEffects } from '../../src/core/effects.js';
import {
  BUILTIN_SOUND_PRESETS,
  SOUND_PRESET_GROUPS,
  cloneSoundPreset,
  featuredSoundPresets,
  findBuiltinSoundPreset,
  groupSoundPresets,
  soundSignature,
} from '../../src/core/sound-presets.js';
import { normalizeEffects } from '../../src/core/effects.js';

describe('BUILTIN_SOUND_PRESETS', () => {
  it('id 唯一且字段完整', () => {
    const ids = BUILTIN_SOUND_PRESETS.map(preset => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('flat');

    for (const preset of BUILTIN_SOUND_PRESETS) {
      expect(preset.name.length, preset.id).toBeGreaterThan(0);
      expect(preset.tagline.length, preset.id).toBeGreaterThan(0);
      expect(preset.accent.length, preset.id).toBeGreaterThan(0);
    }
  });

  it('每个预设的 EQ 都是完整的 10 段', () => {
    for (const preset of BUILTIN_SOUND_PRESETS) {
      expect(preset.eq.bands.map(band => band.frequencyHz), preset.id).toEqual([...EQ_FREQUENCIES]);
      expect(preset.eq.bands.every(band => Number.isFinite(band.gainDb)), preset.id).toBe(true);
      expect(preset.eq.enabled, preset.id).toBe(true);
      expect(Math.abs(preset.eq.preampDb), preset.id).toBeLessThanOrEqual(12);
    }
  });

  it('增益都在 10 段滑杆的可调范围内', () => {
    for (const preset of BUILTIN_SOUND_PRESETS) {
      for (const band of preset.eq.bands) {
        expect(band.gainDb, `${preset.id}@${band.frequencyHz}`).toBeGreaterThanOrEqual(-12);
        expect(band.gainDb, `${preset.id}@${band.frequencyHz}`).toBeLessThanOrEqual(12);
      }
    }
  });

  it('flat 是平坦的，且不挂任何效果', () => {
    const flat = BUILTIN_SOUND_PRESETS.find(preset => preset.id === 'flat');
    expect(flat.eq.bands.every(band => band.gainDb === 0)).toBe(true);
    expect(flat.eq.preampDb).toBe(0);
    expect(hasActiveEffects(flat.effects)).toBe(false);
    expect(flat.effects).toEqual(defaultEffects());
  });

  it('每条效果链都是归一化过的合法结构', () => {
    for (const preset of BUILTIN_SOUND_PRESETS) {
      expect(preset.effects, preset.id).toEqual(normalizeEffects(preset.effects));
    }
  });

  it('空间与动态类预设真的打开了对应的效果块', () => {
    const club = BUILTIN_SOUND_PRESETS.find(preset => preset.id === 'club');
    expect(club.effects.width.enabled).toBe(true);
    expect(club.effects.width.amount).toBeGreaterThan(1);
    expect(club.effects.dynamics.enabled).toBe(true);
    expect(hasActiveEffects(club.effects)).toBe(true);

    const bass = BUILTIN_SOUND_PRESETS.find(preset => preset.id === 'bass-boost');
    expect(bass.effects.dynamics.enabled).toBe(true);
    expect(bass.effects.dynamics.drive).toBeGreaterThan(0);
  });

  it('开效果的预设都留了前级余量', () => {
    for (const preset of BUILTIN_SOUND_PRESETS) {
      if (!hasActiveEffects(preset.effects)) continue;
      expect(preset.eq.preampDb, preset.id).toBeLessThan(0);
    }
  });

  it('低频增强预留了前级余量，避免削波', () => {
    const bass = BUILTIN_SOUND_PRESETS.find(preset => preset.id === 'bass-boost');
    expect(bass.eq.preampDb).toBeLessThan(0);
    expect(bass.eq.bands[0].gainDb).toBeGreaterThan(0);
  });
});

describe('分组与卡片露出', () => {
  it('每个预设都落在已声明的分组里，分组覆盖全部预设', () => {
    for (const preset of BUILTIN_SOUND_PRESETS) {
      expect(SOUND_PRESET_GROUPS, preset.id).toContain(preset.group);
    }

    const grouped = groupSoundPresets().flatMap(section => section.presets);
    expect(grouped).toHaveLength(BUILTIN_SOUND_PRESETS.length);
  });

  it('卡片露出的是 featured 子集，且包含原声', () => {
    const featured = featuredSoundPresets();
    expect(featured.length).toBeGreaterThan(0);
    expect(featured.length).toBeLessThan(BUILTIN_SOUND_PRESETS.length);
    expect(featured.map(preset => preset.id)).toContain('flat');
    expect(featured.every(preset => preset.featured === true)).toBe(true);
  });
});

describe('findBuiltinSoundPreset', () => {
  it('按 id 找到，找不到返回 null', () => {
    expect(findBuiltinSoundPreset('clean-vocal')?.name).toBe('清澈人声');
    expect(findBuiltinSoundPreset('nope')).toBeNull();
    expect(findBuiltinSoundPreset('')).toBeNull();
  });
});

describe('cloneSoundPreset', () => {
  it('深拷贝，改副本不影响模板', () => {
    const source = findBuiltinSoundPreset('warm');
    const copy = cloneSoundPreset(source);

    copy.eq.bands[0].gainDb = 12;
    copy.effects.reverb.enabled = true;

    expect(source.eq.bands[0].gainDb).not.toBe(12);
    expect(source.effects.reverb.enabled).toBe(false);
    expect(cloneSoundPreset(null)).toBeNull();
  });
});

describe('soundSignature', () => {
  it('同一套状态指纹相同', () => {
    const preset = findBuiltinSoundPreset('car-audio');
    expect(soundSignature(preset)).toBe(soundSignature(cloneSoundPreset(preset)));
  });

  it('EQ 或效果链一变，指纹就变（用于「已调整」判定）', () => {
    const preset = findBuiltinSoundPreset('oriental');
    const base = soundSignature(preset);

    const tweaked = cloneSoundPreset(preset);
    tweaked.eq.bands[0].gainDb = 5;
    expect(soundSignature(tweaked)).not.toBe(base);

    const withEffects = cloneSoundPreset(preset);
    withEffects.effects.width.enabled = true;
    expect(soundSignature(withEffects)).not.toBe(base);
  });

  it('空状态不会误判成某个预设', () => {
    const empty = soundSignature(null);
    for (const preset of BUILTIN_SOUND_PRESETS) {
      expect(soundSignature(preset)).not.toBe(empty);
    }
  });
});
