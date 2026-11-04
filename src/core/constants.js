/**
 * 全局常量：只放不依赖运行环境的纯数据。
 * 扩展、测试、未来 DSH 插件都可以复用。
 */

export const EQ_FREQUENCIES = Object.freeze([
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
]);

export const EQ_CONFIG = Object.freeze({
  frequencies: EQ_FREQUENCIES,
  minGainDb: -12,
  maxGainDb: 12,
  minPreampDb: -12,
  maxPreampDb: 3,
  presetsLimit: 50,
});

/**
 * 效果链参数范围。EQ 之外的效果块都以「0 = 不做事」为基准，
 * 这样默认状态下整条链等价于只有 EQ，不改变既有听感。
 *
 * 每一项的 `default` 是该参数被打开时的建议值。
 */
export const EFFECTS_CONFIG = Object.freeze({
  width: Object.freeze({
    min: 0, max: 2, default: 1,
  }),
  crossfeed: Object.freeze({
    amountMin: 0, amountMax: 1, amountDefault: 0.45,
    cutoffMin: 300, cutoffMax: 1500, cutoffDefault: 700,
    delayMin: 0, delayMax: 1.2, delayDefault: 0.3,
  }),
  spatial: Object.freeze({
    amountMin: 0, amountMax: 1, amountDefault: 0.4,
  }),
  reverb: Object.freeze({
    wetMin: 0, wetMax: 1, wetDefault: 0.3,
    durationMin: 200, durationMax: 4000, durationDefault: 1600,
    decayMin: 0.6, decayMax: 8, decayDefault: 2.6,
    preDelayMin: 0, preDelayMax: 100, preDelayDefault: 12,
  }),
  dynamics: Object.freeze({
    thresholdMin: -60, thresholdMax: 0, thresholdDefault: -18,
    ratioMin: 1, ratioMax: 20, ratioDefault: 4,
    makeupMin: 0, makeupMax: 12, makeupDefault: 0,
    driveMin: 0, driveMax: 1, driveDefault: 0,
  }),
});

export const INTENT_CONFIG = Object.freeze({
  // 一次决策最多 5 条检索动作：并发执行 + 单条挖歌上限，防止规划出 8 条把预算吃光。
  maxQueries: 5,
  maxTargetCount: 20,
  // 单条 searchPlaylists 最多挖几个歌单、每个歌单最多取多少首。
  playlistQueriesLimit: 4,
  playlistTracksLimit: 150,
  coarseFilterMultiplier: 8,
  coarseFilterMin: 60,
  coarseFilterMax: 120,
  rerankReasonMaxLen: 60,
  // 原文直搜的召回条数：只取平台相关性最高的前 N 首。
  literalSearchLimit: 10,
  // 一次检索的硬预算。超过就直接中止，不允许再出现跑十分钟的情况。
  searchBudgetMs: 30000,
});

export const SESSION_CONFIG = Object.freeze({
  maxSessions: 30,
  maxMessagesPerSession: 100,
});

export const PLAYER_DEFAULTS = Object.freeze({
  volume: 0.8,
});

export const DEFAULT_PROVIDER_ID = 'netease';
