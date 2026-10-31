import { EFFECTS_CONFIG } from './constants.js';

/**
 * 效果链的纯数据层。
 *
 * EQ 只改频谱，做不出「前置 / 环绕 / 混响」这类需要时域与双耳线索的效果，
 * 所以播放链上额外的处理块统一放在这里描述：
 *
 *   width     立体声宽度（M/S 矩阵）
 *   crossfeed 对侧串音（耳机上把声像从脑中拉到额前）
 *   spatial   早期反射（去相关，制造包围感）
 *   reverb    混响（合成 IR 的卷积）
 *   dynamics  压缩 + 谐波激励
 *
 * 每个块都带 `enabled`，默认全关。全部关闭时整条链的行为与只有 EQ 时完全一致，
 * 这是「加功能但不改变既有听感」的硬约束。
 *
 * 这个文件不碰 Web Audio，可以被测试、DSH 插件和未来其他平台的播放器复用。
 */

/** 效果块名称，顺序即播放链中的顺序。 */
export const EFFECT_BLOCKS = Object.freeze([
  'width',
  'crossfeed',
  'spatial',
  'reverb',
  'dynamics',
]);

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampRound(value, min, max, fallback, digits = 2) {
  const n = toNumber(value, fallback);
  const factor = 10 ** digits;
  return Math.min(max, Math.max(min, Math.round(n * factor) / factor));
}

const C = EFFECTS_CONFIG;

/**
 * 全旁路的默认效果链。每次返回新对象，避免调用方共享引用。
 * @returns {{
 *   enabled: boolean,
 *   width: { enabled: boolean, amount: number },
 *   crossfeed: { enabled: boolean, amount: number, cutoffHz: number, delayMs: number },
 *   spatial: { enabled: boolean, amount: number },
 *   reverb: { enabled: boolean, wet: number, durationMs: number, decay: number, preDelayMs: number },
 *   dynamics: { enabled: boolean, thresholdDb: number, ratio: number, makeupDb: number, drive: number },
 * }}
 */
export function defaultEffects() {
  return {
    enabled: true,
    width: { enabled: false, amount: C.width.default },
    crossfeed: {
      enabled: false,
      amount: C.crossfeed.amountDefault,
      cutoffHz: C.crossfeed.cutoffDefault,
      delayMs: C.crossfeed.delayDefault,
    },
    spatial: { enabled: false, amount: C.spatial.amountDefault },
    reverb: {
      enabled: false,
      wet: C.reverb.wetDefault,
      durationMs: C.reverb.durationDefault,
      decay: C.reverb.decayDefault,
      preDelayMs: C.reverb.preDelayDefault,
    },
    dynamics: {
      enabled: false,
      thresholdDb: C.dynamics.thresholdDefault,
      ratio: C.dynamics.ratioDefault,
      makeupDb: C.dynamics.makeupDefault,
      drive: C.dynamics.driveDefault,
    },
  };
}

/**
 * 把任意来源（存储、大模型、用户预设）的效果链归一化。
 * 缺失字段补默认值，超范围截断，未知字段丢弃。
 * @param {unknown} effects
 * @returns {ReturnType<typeof defaultEffects>}
 */
export function normalizeEffects(effects) {
  const source = effects && typeof effects === 'object' ? effects : {};
  const base = defaultEffects();

  const width = source.width && typeof source.width === 'object' ? source.width : {};
  const crossfeed = source.crossfeed && typeof source.crossfeed === 'object' ? source.crossfeed : {};
  const spatial = source.spatial && typeof source.spatial === 'object' ? source.spatial : {};
  const reverb = source.reverb && typeof source.reverb === 'object' ? source.reverb : {};
  const dynamics = source.dynamics && typeof source.dynamics === 'object' ? source.dynamics : {};

  return {
    enabled: source.enabled !== false,
    width: {
      enabled: width.enabled === true,
      amount: clampRound(width.amount, C.width.min, C.width.max, base.width.amount),
    },
    crossfeed: {
      enabled: crossfeed.enabled === true,
      amount: clampRound(crossfeed.amount, C.crossfeed.amountMin, C.crossfeed.amountMax, base.crossfeed.amount),
      cutoffHz: clampRound(
        crossfeed.cutoffHz,
        C.crossfeed.cutoffMin,
        C.crossfeed.cutoffMax,
        base.crossfeed.cutoffHz,
        0,
      ),
      delayMs: clampRound(
        crossfeed.delayMs,
        C.crossfeed.delayMin,
        C.crossfeed.delayMax,
        base.crossfeed.delayMs,
      ),
    },
    spatial: {
      enabled: spatial.enabled === true,
      amount: clampRound(spatial.amount, C.spatial.amountMin, C.spatial.amountMax, base.spatial.amount),
    },
    reverb: {
      enabled: reverb.enabled === true,
      wet: clampRound(reverb.wet, C.reverb.wetMin, C.reverb.wetMax, base.reverb.wet),
      durationMs: clampRound(
        reverb.durationMs,
        C.reverb.durationMin,
        C.reverb.durationMax,
        base.reverb.durationMs,
        0,
      ),
      decay: clampRound(reverb.decay, C.reverb.decayMin, C.reverb.decayMax, base.reverb.decay),
      preDelayMs: clampRound(
        reverb.preDelayMs,
        C.reverb.preDelayMin,
        C.reverb.preDelayMax,
        base.reverb.preDelayMs,
      ),
    },
    dynamics: {
      enabled: dynamics.enabled === true,
      thresholdDb: clampRound(
        dynamics.thresholdDb,
        C.dynamics.thresholdMin,
        C.dynamics.thresholdMax,
        base.dynamics.thresholdDb,
        0,
      ),
      ratio: clampRound(dynamics.ratio, C.dynamics.ratioMin, C.dynamics.ratioMax, base.dynamics.ratio),
      makeupDb: clampRound(
        dynamics.makeupDb,
        C.dynamics.makeupMin,
        C.dynamics.makeupMax,
        base.dynamics.makeupDb,
      ),
      drive: clampRound(dynamics.drive, C.dynamics.driveMin, C.dynamics.driveMax, base.dynamics.drive),
    },
  };
}

/**
 * 只检查结构是否完整；数值范围交给 normalizeEffects。
 * @param {unknown} effects
 * @returns {boolean}
 */
export function isEffectsValid(effects) {
  return Boolean(
    effects
    && typeof effects === 'object'
    && EFFECT_BLOCKS.every(block => effects[block] && typeof effects[block] === 'object'),
  );
}

/**
 * 是否真的会改变声音。总开关关闭或所有块都关着时，链等价于直通。
 * @param {unknown} effects
 * @returns {boolean}
 */
export function hasActiveEffects(effects) {
  if (!effects || typeof effects !== 'object' || effects.enabled === false) return false;
  return EFFECT_BLOCKS.some(block => effects[block]?.enabled === true);
}

/**
 * 列出当前启用的块，用于 UI 上「基于 XX · 已调整」这类提示。
 * @param {unknown} effects
 * @returns {string[]}
 */
export function activeEffectBlocks(effects) {
  if (!effects || typeof effects !== 'object' || effects.enabled === false) return [];
  return EFFECT_BLOCKS.filter(block => effects[block]?.enabled === true);
}
