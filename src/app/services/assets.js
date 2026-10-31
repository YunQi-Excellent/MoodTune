/**
 * 列表型资产的业务层：保存的播放列表与 EQ 预设。
 *
 * 仓储负责存，这里补上「播放/应用」这类要跟播放器交互的动作，
 * 以及「保存前必须有什么」的校验。
 *
 * @param {object} options
 * @param {object} options.store
 * @param {object} options.player
 * @param {(song: object) => object} options.normalizeSong
 */
export function createPlaylistService({ store, player, normalizeSong } = {}) {
  if (!store) throw new Error('createPlaylistService 需要 store');
  if (!player) throw new Error('createPlaylistService 需要 player');
  if (typeof normalizeSong !== 'function') throw new Error('createPlaylistService 需要 normalizeSong');

  return {
    list: () => store.list(),

    async save({ name, songs, source } = {}) {
      if (!Array.isArray(songs) || songs.length === 0) throw new Error('播放列表为空');
      return store.add({ name, songs: songs.map(normalizeSong), source });
    },

    remove: id => store.remove(id),
    rename: (id, name) => store.rename(id, name),

    async play(id) {
      const playlist = await store.get(id);
      if (!playlist) throw new Error('找不到这个播放列表');
      await player.setPlaylist(playlist.songs, true);
      return playlist;
    },
  };
}

/**
 * @param {object} options
 * @param {object} options.store
 * @param {object} options.player
 * @param {(eq: object) => object} options.normalizeEq
 */
export function createEqPresetService({ store, player, normalizeEq } = {}) {
  if (!store) throw new Error('createEqPresetService 需要 store');
  if (!player) throw new Error('createEqPresetService 需要 player');
  if (typeof normalizeEq !== 'function') throw new Error('createEqPresetService 需要 normalizeEq');

  return {
    list: () => store.list(),

    async save({ name, eq, source } = {}) {
      if (!eq) throw new Error('没有可保存的调音');
      return store.add({ name, eq: normalizeEq(eq), source });
    },

    remove: id => store.remove(id),
    rename: (id, name) => store.rename(id, name),

    async apply(id) {
      const preset = await store.get(id);
      if (!preset) throw new Error('找不到这个调音');
      const response = await player.setEq(preset.eq);
      return { preset, eq: response?.eq };
    },
  };
}
