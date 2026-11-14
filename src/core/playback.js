import { PLAYER_DEFAULTS } from './constants.js';

/**
 * 播放模式与「下一首是谁」的纯逻辑。
 *
 * 播放模式不是简单地在 `ended` 里取模：顺序播放要在队尾停下，
 * 单曲循环只影响自动结束（手动上一首/下一首仍要能走），
 * 随机播放要一轮内不重复、跨轮不立刻重复同一首。
 * 这些规则放在 core 里，offscreen 只负责把结果映射成音频动作。
 */

export const PLAYBACK_MODES = Object.freeze({
  SEQUENTIAL: 'sequential',
  REPEAT_ONE: 'repeat-one',
  SHUFFLE: 'shuffle',
});

/** 按钮点击时的切换顺序：顺序 → 单曲 → 随机 → 顺序。 */
export const PLAYBACK_MODE_CYCLE = Object.freeze([
  PLAYBACK_MODES.SEQUENTIAL,
  PLAYBACK_MODES.REPEAT_ONE,
  PLAYBACK_MODES.SHUFFLE,
]);

export const DEFAULT_PLAYBACK_MODE = PLAYER_DEFAULTS.playbackMode;

export const PLAYBACK_MODE_META = Object.freeze({
  [PLAYBACK_MODES.SEQUENTIAL]: Object.freeze({
    label: '顺序播放',
    shortLabel: '顺序',
    icon: '➡',
  }),
  [PLAYBACK_MODES.REPEAT_ONE]: Object.freeze({
    label: '单曲循环',
    shortLabel: '单曲',
    icon: '🔂',
  }),
  [PLAYBACK_MODES.SHUFFLE]: Object.freeze({
    label: '随机播放',
    shortLabel: '随机',
    icon: '🔀',
  }),
});

export const PLAYBACK_ACTIONS = Object.freeze({
  PLAY: 'play',
  REPEAT: 'repeat',
  RESTART: 'restart',
  STOP: 'stop',
});

/** 未知值（旧版本存储、手写消息）一律回到默认模式，避免播放器停在无模式状态。 */
export function normalizePlaybackMode(mode) {
  return PLAYBACK_MODE_META[mode] ? mode : DEFAULT_PLAYBACK_MODE;
}

export function nextPlaybackMode(mode) {
  const current = normalizePlaybackMode(mode);
  const at = PLAYBACK_MODE_CYCLE.indexOf(current);
  return PLAYBACK_MODE_CYCLE[(at + 1) % PLAYBACK_MODE_CYCLE.length];
}

function randomIndex(random, upperBound) {
  const value = Number(random());
  const normalized = Number.isFinite(value)
    ? Math.min(0.999999999, Math.max(0, value))
    : 0;
  return Math.floor(normalized * upperBound);
}

/**
 * 生成一个 [0, length) 的随机排列。
 *
 * @param {number} length
 * @param {object} [options]
 * @param {() => number} [options.random] 注入随机源，测试用
 * @param {number} [options.first] 指定排在第一位的曲目（切换模式时保留当前歌）
 * @param {number} [options.avoidFirst] 避免排在第一位的曲目（跨轮不立刻重复）
 */
export function shuffleIndices(length, { random = Math.random, first = -1, avoidFirst = -1 } = {}) {
  const size = Math.max(0, Math.floor(Number(length) || 0));
  const indices = Array.from({ length: size }, (_, i) => i);
  if (size <= 1) return indices;

  for (let i = size - 1; i > 0; i -= 1) {
    const j = randomIndex(random, i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  if (Number.isInteger(first) && first >= 0 && first < size) {
    const at = indices.indexOf(first);
    if (at > 0) [indices[0], indices[at]] = [indices[at], indices[0]];
  } else if (Number.isInteger(avoidFirst) && avoidFirst >= 0 && avoidFirst < size) {
    if (indices[0] === avoidFirst) {
      [indices[0], indices[1]] = [indices[1], indices[0]];
    }
  }

  return indices;
}

/**
 * 有状态的播放顺序导航器。
 *
 * 它只维护「顺序/随机排列」与游标，不碰 audio 元素：
 * `next()/prev()` 返回 `{ action, index }`，由播放器决定是换歌、重播还是停止。
 *
 * @param {object} [options]
 * @param {string} [options.mode]
 * @param {() => number} [options.random]
 */
export function createPlaybackNavigator({ mode = DEFAULT_PLAYBACK_MODE, random = Math.random } = {}) {
  let size = 0;
  let current = -1;
  let playbackMode = normalizePlaybackMode(mode);
  /** 随机模式下的完整一轮顺序；顺序/单曲模式不用。 */
  let order = [];
  /** 当前歌在 order 里的位置。 */
  let cursor = -1;

  const isValid = index => Number.isInteger(index) && index >= 0 && index < size;

  function rebuildOrder({ first = -1, avoidFirst = -1 } = {}) {
    order = shuffleIndices(size, { random, first, avoidFirst });
    cursor = isValid(first) ? order.indexOf(first) : -1;
  }

  function resetOrder() {
    order = [];
    cursor = -1;
  }

  function syncCursor() {
    if (playbackMode !== PLAYBACK_MODES.SHUFFLE) {
      cursor = current;
      return;
    }
    const at = order.indexOf(current);
    if (at >= 0) cursor = at;
    else if (isValid(current)) rebuildOrder({ first: current });
    else cursor = -1;
  }

  /** 新播放列表的起点：顺序从第一首开始，随机整轮洗牌。 */
  function startIndex() {
    if (size === 0) return -1;
    if (playbackMode !== PLAYBACK_MODES.SHUFFLE) return 0;
    if (order.length !== size) rebuildOrder();
    return order[0] ?? 0;
  }

  function setMode(nextMode) {
    const normalized = normalizePlaybackMode(nextMode);
    if (normalized === playbackMode) return playbackMode;

    playbackMode = normalized;
    if (playbackMode === PLAYBACK_MODES.SHUFFLE) {
      // 切到随机时保留当前正在听的歌，再随机剩下的；否则用户会突然被切歌。
      rebuildOrder({ first: current });
    } else {
      resetOrder();
      cursor = current;
    }
    return playbackMode;
  }

  function cycleMode() {
    return setMode(nextPlaybackMode(playbackMode));
  }

  function next({ automatic = false } = {}) {
    if (size === 0) return { action: PLAYBACK_ACTIONS.STOP };
    if (!isValid(current)) {
      const index = startIndex();
      if (index < 0) return { action: PLAYBACK_ACTIONS.STOP };
      current = index;
      syncCursor();
      return { action: PLAYBACK_ACTIONS.PLAY, index };
    }

    // 单曲循环只接管「自然播完」；手动下一首仍要能离开当前歌。
    if (automatic && playbackMode === PLAYBACK_MODES.REPEAT_ONE) {
      return { action: PLAYBACK_ACTIONS.REPEAT, index: current };
    }

    if (playbackMode === PLAYBACK_MODES.SHUFFLE) {
      if (cursor < 0) syncCursor();
      if (cursor + 1 < order.length) {
        cursor += 1;
        current = order[cursor];
        return { action: PLAYBACK_ACTIONS.PLAY, index: current };
      }

      // 一轮播完：重新洗牌，并避免新的一轮又从刚播完的这首开始。
      rebuildOrder({ avoidFirst: current });
      cursor = 0;
      current = order[0];
      return { action: PLAYBACK_ACTIONS.PLAY, index: current };
    }

    if (current + 1 < size) {
      current += 1;
      cursor = current;
      return { action: PLAYBACK_ACTIONS.PLAY, index: current };
    }

    // 单曲循环下手动点「下一首」到队尾时回到第一首；顺序播放则停在队尾。
    if (playbackMode === PLAYBACK_MODES.REPEAT_ONE) {
      current = 0;
      cursor = 0;
      return { action: PLAYBACK_ACTIONS.PLAY, index: current };
    }
    return { action: PLAYBACK_ACTIONS.STOP, index: current };
  }

  function prev() {
    if (size === 0) return { action: PLAYBACK_ACTIONS.STOP };
    if (!isValid(current)) {
      const index = startIndex();
      if (index < 0) return { action: PLAYBACK_ACTIONS.STOP };
      current = index;
      syncCursor();
      return { action: PLAYBACK_ACTIONS.PLAY, index };
    }

    if (playbackMode === PLAYBACK_MODES.SHUFFLE) {
      if (cursor < 0) syncCursor();
      if (cursor > 0) {
        cursor -= 1;
        current = order[cursor];
        return { action: PLAYBACK_ACTIONS.PLAY, index: current };
      }
      return { action: PLAYBACK_ACTIONS.RESTART, index: current };
    }

    if (current > 0) {
      current -= 1;
      cursor = current;
      return { action: PLAYBACK_ACTIONS.PLAY, index: current };
    }
    return { action: PLAYBACK_ACTIONS.RESTART, index: current };
  }

  return {
    get mode() { return playbackMode; },
    get size() { return size; },
    get currentIndex() { return current; },
    get cursor() { return cursor; },
    get order() { return order.slice(); },

    setPlaylist(length, { current: nextCurrent = -1 } = {}) {
      size = Math.max(0, Math.floor(Number(length) || 0));
      current = isValid(nextCurrent) ? nextCurrent : -1;
      if (playbackMode === PLAYBACK_MODES.SHUFFLE) rebuildOrder();
      else resetOrder();
      if (isValid(current)) syncCursor();
      return size;
    },

    setMode,
    cycleMode,
    next,
    prev,
    startIndex,

    /** 直接跳到某首（例如从歌单点播）时，随机模式要把游标同步过去。 */
    setCurrent(index) {
      if (!isValid(index)) {
        current = -1;
        cursor = -1;
        return;
      }
      current = index;
      syncCursor();
    },
  };
}
