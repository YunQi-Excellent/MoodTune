/**
 * 音乐平台检索的老接口。
 *
 * 这些 action 名（fetchPlaylists / searchSongs / deepSearch / artistAllSongs）
 * 是历史对外契约，改由 provider 实现后仍然保留，返回统一的 Track。
 */
export function createMusicHandlers(music) {
  if (!music) throw new Error('createMusicHandlers 需要 music 依赖');

  return {
    fetchPlaylists: async () => ({ ok: true, data: await music.fetchPlaylists() }),

    searchSongs: async (req) => {
      const keyword = String(req.keyword || '').trim();
      if (!keyword) return { ok: false, error: '搜索词不能为空' };
      const limit = Number.isFinite(req.limit) ? req.limit : 30;
      const offset = Number.isFinite(req.offset) ? req.offset : 0;
      const order = req.order === 'time' ? 'time' : 'hot';
      const result = await music.searchSongs(keyword, limit, offset, order);
      return { ok: true, data: result.songs, songCount: result.songCount, keyword, order };
    },

    deepSearch: async (req) => {
      const keyword = String(req.keyword || '').trim();
      if (!keyword) return { ok: false, error: '搜索词不能为空' };
      const maxPlaylists = Number.isFinite(req.maxPlaylists) ? req.maxPlaylists : 10;
      return { ok: true, data: await music.deepSearch(keyword, { maxPlaylists }) };
    },

    artistAllSongs: async (req) => {
      const artistName = String(req.artistName || '').trim();
      if (!artistName) return { ok: false, error: '歌手名不能为空' };
      return { ok: true, data: await music.artistAllSongs(artistName) };
    },

    pausePageAudio: async () => {
      await music.pause();
      return { ok: true };
    },
  };
}
