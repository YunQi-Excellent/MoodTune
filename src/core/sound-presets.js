import { EQ_FREQUENCIES } from './constants.js';
import { defaultEffects, normalizeEffects } from './effects.js';

/**
 * 内置音效（预设）。
 *
 * 一个「音效」= 一套 EQ 快照 + 一条效果链。
 * - 基础音色：纯 EQ 就能表达的音色
 * - 空间与动态：需要宽度 / 串音 / 反射 / 混响 / 压缩的听感
 *
 * 命名刻意避开品牌词（DTS、臻享、全景 Sound 等），用通用描述：
 * 听感对得上，法律上干净。
 *
 * 这些对象是只读模板，应用前请用 cloneSoundPreset。
 */

/** 音效库里分组的展示顺序。 */
export const SOUND_PRESET_GROUPS = Object.freeze([
  '基础音色',
  '空间与动态',
]);

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

/** 在默认（全旁路）效果链上只打开需要的块，避免每处都写全字段。 */
function makeEffects({ width, crossfeed, spatial, reverb, dynamics } = {}) {
  const base = defaultEffects();
  return normalizeEffects({
    ...base,
    width: { ...base.width, ...width },
    crossfeed: { ...base.crossfeed, ...crossfeed },
    spatial: { ...base.spatial, ...spatial },
    reverb: { ...base.reverb, ...reverb },
    dynamics: { ...base.dynamics, ...dynamics },
  });
}

/** 频率顺序：31 62 125 250 500 1k 2k 4k 8k 16k */
export const BUILTIN_SOUND_PRESETS = Object.freeze([
  {
    id: 'flat',
    name: '原声',
    tagline: '不添色，回到原始混音',
    accent: 'slate',
    group: '基础音色',
    featured: true,
    eq: makeEq([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    effects: makeEffects(),
  },
  {
    id: 'clean-vocal',
    name: '清澈人声',
    tagline: '人声靠前，齿音收敛',
    accent: 'sky',
    group: '基础音色',
    featured: true,
    eq: makeEq([-4, -3, -2, -3, 0, 2, 3, 2, -2, -3]),
    effects: makeEffects(),
  },
  {
    id: 'bass-boost',
    name: '低频增强',
    tagline: '下潜更深，量感更足',
    accent: 'violet',
    group: '基础音色',
    featured: true,
    // 低频抬得多，前级留余量；再用轻微谐波激励把「量」变成听感上的「下潜」
    eq: makeEq([6, 5, 3, 0, -1, -1, 0, 0, 1, 0], -5),
    effects: makeEffects({
      dynamics: {
        enabled: true, thresholdDb: -18, ratio: 3, makeupDb: 1, drive: 0.25,
      },
    }),
  },
  {
    id: 'warm',
    name: '温暖宽松',
    tagline: '低频柔和，高频不刺',
    accent: 'amber',
    group: '基础音色',
    featured: false,
    eq: makeEq([2, 2, 1, 0, -1, 0, 1, 0, -2, -3], -1),
    effects: makeEffects(),
  },
  {
    id: 'car-audio',
    name: '车载补偿',
    tagline: '补回车厢吃掉的低频与高频',
    accent: 'teal',
    group: '基础音色',
    featured: false,
    eq: makeEq([4, 3, 1, -2, -1, 1, 2, 1, 2, 3], -2),
    effects: makeEffects(),
  },
  {
    id: 'oriental',
    name: '东方韵味',
    tagline: '中频饱满，泛音通透',
    accent: 'rose',
    group: '基础音色',
    featured: false,
    eq: makeEq([-2, -1, 0, 1, 2, 2, 3, 2, 0, -1]),
    effects: makeEffects(),
  },
  {
    id: 'club',
    name: '超嗨 DJ',
    tagline: '低频紧实，声场更宽',
    accent: 'fuchsia',
    group: '空间与动态',
    featured: true,
    // 低频与补偿增益都不小，靠末端限幅兜底
    eq: makeEq([4, 4, 2, 0, -1, -1, 0, 1, 2, 1], -4),
    effects: makeEffects({
      width: { enabled: true, amount: 1.35 },
      dynamics: {
        enabled: true, thresholdDb: -22, ratio: 5, makeupDb: 3, drive: 0.15,
      },
    }),
  },
  {
    id: 'front',
    name: '前置听感',
    tagline: '声像从脑中挪到额前，久听不累',
    accent: 'indigo',
    group: '空间与动态',
    featured: true,
    // 串音把对侧信号低通后混回来，是「在前方」的关键；EQ 只负责提亮
    eq: makeEq([-3, -2, -1, 0, 0, 1, 2, 2, 0, -1], -2),
    effects: makeEffects({
      crossfeed: { enabled: true, amount: 0.55, cutoffHz: 700, delayMs: 0.3 },
      reverb: {
        enabled: true, wet: 0.1, durationMs: 900, decay: 3.2, preDelayMs: 8,
      },
    }),
  },
  {
    id: 'wide',
    name: '宽阔环绕',
    tagline: '声场拉开，两侧有反射',
    accent: 'emerald',
    group: '空间与动态',
    featured: true,
    eq: makeEq([1, 1, 0, 0, 0, 0, 1, 1, 1, 0], -2),
    effects: makeEffects({
      width: { enabled: true, amount: 1.55 },
      spatial: { enabled: true, amount: 0.55 },
      reverb: {
        enabled: true, wet: 0.22, durationMs: 2000, decay: 2.4, preDelayMs: 20,
      },
    }),
  },
  {
    id: 'live',
    name: '现场感',
    tagline: '像在小型现场，尾巴更自然',
    accent: 'orange',
    group: '空间与动态',
    featured: false,
    eq: makeEq([0, 1, 0, -1, 0, 1, 1, 0, 0, 0], -1),
    effects: makeEffects({
      width: { enabled: true, amount: 1.15 },
      spatial: { enabled: true, amount: 0.4 },
      reverb: {
        enabled: true, wet: 0.3, durationMs: 2400, decay: 2.2, preDelayMs: 28,
      },
      dynamics: {
        enabled: true, thresholdDb: -20, ratio: 3, makeupDb: 1.5, drive: 0,
      },
    }),
  },
  {
    id: 'immersive',
    name: '沉浸声场',
    tagline: '包围感强，适合戴耳机听整张专辑',
    accent: 'pink',
    group: '空间与动态',
    featured: false,
    eq: makeEq([1, 1, 0, 0, 0, 0, 0, 1, 1, 0], -3),
    effects: makeEffects({
      width: { enabled: true, amount: 1.3 },
      crossfeed: { enabled: true, amount: 0.35, cutoffHz: 800, delayMs: 0.25 },
      spatial: { enabled: true, amount: 0.7 },
      reverb: {
        enabled: true, wet: 0.18, durationMs: 1400, decay: 2.8, preDelayMs: 15,
      },
      dynamics: {
        enabled: true, thresholdDb: -22, ratio: 2.5, makeupDb: 1, drive: 0,
      },
    }),
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

/** 调音卡片上直接露出一排（其余在音效库里）。 */
export function featuredSoundPresets() {
  return BUILTIN_SOUND_PRESETS.filter(preset => preset.featured === true);
}

/**
 * 按分组切好，给音效库渲染用。空分组会被丢掉。
 * @returns {{ group: string, presets: object[] }[]}
 */
export function groupSoundPresets() {
  return SOUND_PRESET_GROUPS
    .map(group => ({
      group,
      presets: BUILTIN_SOUND_PRESETS.filter(preset => preset.group === group),
    }))
    .filter(section => section.presets.length > 0);
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
