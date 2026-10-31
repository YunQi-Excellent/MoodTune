import { PLAYER_DEFAULTS } from '../../core/constants.js';

/**
 * 播放器偏好的持久化（音量 / 上次的 EQ / 上次的效果链）。
 *
 * 写操作是「发出去就不管」的：侧边栏拖音量时不该等一次 storage 往返，
 * 失败也不影响播放，所以这里吞掉写入错误。
 *
 * @param {object} options
 * @param {{ get: Function, set: Function }} options.area
 * @param {{ volume: number }} [options.defaults]
 */
export function createPlayerPreferences({ area, defaults = PLAYER_DEFAULTS } = {}) {
  if (!area || typeof area.get !== 'function') {
    throw new Error('createPlayerPreferences 需要 storage area');
  }

  const save = (items) => {
    Promise.resolve().then(() => area.set(items)).catch(() => {});
  };

  return {
    saveEq(eq) {
      if (eq) save({ currentEq: eq });
    },

    saveEffects(effects) {
      if (effects) save({ currentEffects: effects });
    },

    saveVolume(volume) {
      if (typeof volume === 'number' && Number.isFinite(volume)) save({ playerVolume: volume });
    },

    async load() {
      const data = await area.get(['playerVolume', 'currentEq', 'currentEffects']);
      return {
        volume: typeof data?.playerVolume === 'number' ? data.playerVolume : defaults.volume,
        eq: data?.currentEq || null,
        effects: data?.currentEffects || null,
      };
    },
  };
}
