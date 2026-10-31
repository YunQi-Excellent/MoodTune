/**
 * 保存的播放列表。
 *
 * saveCurrentPlaylist 的取值顺序保持历史行为：
 * 会话购物车 → 结算快照 → 播放器当前歌单。
 */
export function createPlaylistHandlers({ playlists, sessions, player }) {
  if (!playlists || !sessions || !player) {
    throw new Error('createPlaylistHandlers 需要 playlists / sessions / player');
  }

  return {
    listSavedPlaylists: async () => ({ ok: true, playlists: await playlists.list() }),

    saveCurrentPlaylist: async (req) => {
      const session = await sessions.current();
      let songs = (session?.cart?.length)
        ? session.cart
        : (session?.result?.playlist || []);

      if (!songs.length) {
        const state = await player.getState();
        if (!state?.ok || !state.state?.playlist?.length) {
          return { ok: false, error: '没有可保存的歌曲' };
        }
        songs = state.state.playlist;
      }

      const saved = await playlists.save({
        name: req.name || '未命名',
        songs,
        source: 'manual',
      });
      return { ok: true, playlist: saved };
    },

    deleteSavedPlaylist: async (req) => ({
      ok: true,
      playlists: await playlists.remove(req.id),
    }),

    renameSavedPlaylist: async (req) => ({
      ok: true,
      playlists: await playlists.rename(req.id, req.name),
    }),

    playSavedPlaylist: async (req) => ({
      ok: true,
      playlist: await playlists.play(req.id),
    }),
  };
}
