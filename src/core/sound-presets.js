import { EQ_FREQUENCIES } from './constants.js';
import { defaultEffects, normalizeEffects } from './effects.js';

/**
 * 内置音效（预设）。
 *
 * 一个「音效」= 一套 EQ 快照 + 一条效果链。当前这一批是**纯 EQ**能表达的音色，
 * 所以 effects 全是默认（全旁路）；环绕 / 前置 / 混响类会在效果块落地后补进来。
 *
 * 命名刻意避开品牌词（DTS、臻享、全景 Sound 等），用通用描述：
 * 音色对得上，法律上干净。
 *
 * 这些对象是只读模板，应用前请用 cloneSoundPreset。
 */

function makeEq(gains, preampDb = 0) {
  return {
    enabled: true,
    preampDb,
    bands: EQ_FREQUENCIES.map((frequencyHz, index) => ({
      frequencyHz,
      gainDb: gains[index] ?? 0,
    })),
  };
}

/** 频率顺序：31 62 125 250 500 1k 2k 4k 8k 16k */
export const BUILTIN_SOUND_PRESETS = Object.freeze([
  {
    id: 'flat',
    name: '原声',
    tagline: '不添色，回到原始混音',
    accent: 'slate',
    eq: makeEq([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    effects: defaultEffects(),
  },
  {
    id: 'clean-vocal',
    name: '清澈人声',
    tagline: '人声靠前，齿音收敛',
    accent: 'sky',
    eq: makeEq([-4, -3, -2, -3, 0, 2, 3, 2, -2, -3]),
    effects: defaultEffects(),
  },
  {
    id: 'bass-boost',
    name: '低频增强',
    tagline: '下潜更深，量感更足',
    accent: 'violet',
    // 低频抬得多，前级留出余量，避免削波
    eq: makeEq([6, 5, 3, 0, -1, -1, 0, 0, 1, 0], -4),
    effects: defaultEffects(),
  },
  {
    id: 'warm',
    name: '温暖宽松',
    tagline: '低频柔和，高频不刺',
    accent: 'amber',
    eq: makeEq([2, 2, 1, 0, -1, 0, 1, 0, -2, -3], -1),
    effects: defaultEffects(),
  },
  {
    id: 'car-audio',
    name: '车载补偿',
    tagline: '补回车厢吃掉的低频与高频',
    accent: 'teal',
    eq: makeEq([4, 3, 1, -2, -1, 1, 2, 1, 2, 3], -2),
    effects: defaultEffects(),
  },
  {
    id: 'oriental',
    name: '东方韵味',
    tagline: '中频饱满，泛音通透',
    accent: 'rose',
    eq: makeEq([-2, -1, 0, 1, 2, 2, 3, 2, 0, -1]),
    effects: defaultEffects(),
  },
]);

/**
 * @param {string} id
 * @returns {object | null}
 */
export function findBuiltinSoundPreset(id) {
  if (!id) return null;
  return BUILTIN_SOUND_PRESETS.find(preset => preset.id === id) || null;
}

/** 深拷贝一份预设，避免把共享模板直接交给播放器或存储。 */
export function cloneSoundPreset(preset) {
  if (!preset) return null;
  return {
    ...preset,
    eq: {
      enabled: preset.eq?.enabled !== false,
      preampDb: preset.eq?.preampDb || 0,
      bands: (preset.eq?.bands || []).map(band => ({ ...band })),
    },
    effects: normalizeEffects(preset.effects),
  };
}

/**
 * 用「当前状态」的指纹判断某个音效是否正在生效。
 * 这样用户手动拧过滑块后，UI 能自动从「使用中」变成「已调整」。
 *
 * @param {{ eq?: object, effects?: object } | null} state
 * @returns {string}
 */
export function soundSignature(state) {
  const eq = state?.eq || {};
  const bands = (eq.bands || [])
    .map(band => `${Number(band.frequencyHz)}:${Number(band.gainDb) || 0}`)
    .join(',');
  const preamp = Number(eq.preampDb) || 0;
  const enabled = eq.enabled !== false ? 1 : 0;
  return `${enabled}|${preamp}|${bands}|${JSON.stringify(normalizeEffects(state?.effects))}`;
}
