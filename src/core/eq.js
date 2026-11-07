import { EQ_CONFIG } from './constants.js';

/**
 * 把数值限制在闭区间内。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * dB 转线性增益。
 * @param {number} db
 * @returns {number}
 */
export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * 生成平坦 EQ。每次返回新对象，避免调用方共享引用。
 * @returns {{enabled: boolean, preampDb: number, bands: Array<{frequencyHz: number, gainDb: number}>}}
 */
export function defaultEq() {
  return {
    enabled: true,
    preampDb: 0,
    bands: EQ_CONFIG.frequencies.map(frequencyHz => ({ frequencyHz, gainDb: 0 })),
  };
}

/**
 * 把任意来源的 EQ 归一化成固定 10 段、固定范围的结构。
 * 缺失频段补 0，未知频段丢弃，小数四舍五入，超范围截断。
 * @param {unknown} eq
 * @returns {{enabled: boolean, preampDb: number, bands: Array<{frequencyHz: number, gainDb: number}>}}
 */
export function normalizeEq(eq) {
  const source = eq && typeof eq === 'object' ? eq : {};
  const sourceBands = Array.isArray(source.bands) ? source.bands : [];

  const bands = EQ_CONFIG.frequencies.map(frequencyHz => {
    const found = sourceBands.find(band => Number(band?.frequencyHz) === frequencyHz);
    const raw = found ? Number(found.gainDb) : 0;
    const gainDb = Number.isFinite(raw)
      ? clamp(Math.round(raw), EQ_CONFIG.minGainDb, EQ_CONFIG.maxGainDb)
      : 0;
    return { frequencyHz, gainDb };
  });

  const rawPreamp = Number(source.preampDb);
  const preampDb = Number.isFinite(rawPreamp)
    ? clamp(Math.round(rawPreamp), EQ_CONFIG.minPreampDb, EQ_CONFIG.maxPreampDb)
    : 0;

  return {
    enabled: source.enabled !== false,
    preampDb,
    bands,
  };
}

/**
 * 只检查结构是否完整；不检查数值范围（范围由 normalizeEq 负责）。
 * @param {unknown} eq
 * @returns {boolean}
 */
export function isEqValid(eq) {
  return Boolean(
    eq
    && typeof eq === 'object'
    && Array.isArray(eq.bands)
    && eq.bands.length === EQ_CONFIG.frequencies.length,
  );
}
