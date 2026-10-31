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

export const INTENT_CONFIG = Object.freeze({
  maxQueries: 8,
  maxTargetCount: 20,
  coarseFilterMultiplier: 8,
  coarseFilterMin: 60,
  coarseFilterMax: 120,
  rerankReasonMaxLen: 60,
});

export const SESSION_CONFIG = Object.freeze({
  maxSessions: 30,
  maxMessagesPerSession: 100,
});

export const PLAYER_DEFAULTS = Object.freeze({
  volume: 0.8,
});

export const DEFAULT_PROVIDER_ID = 'netease';
