import { trackKey } from '../../core/track.js';

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 音乐平台检索服务：把 provider 的能力包成背景页/侧边栏可以直接调用的接口。
 *
 * 这里只做「调 provider + 整理返回结构」，不碰 chrome API，
 * 方便在没有扩展环境时单测。
 *
 * @param {object} options
 * @param {{ primary: object, get: (id: string) => object }} options.providers
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export function createMusicService({ providers, sleep = defaultSleep } = {}) {
  if (!providers) throw new Error('createMusicService 需要 providers');

  const requireProvider = () => {
    const provider = providers.primary;
    if (!provider) throw new Error('未注册音乐平台');
    return provider;
  };

  return {
    requireProvider,

    async fetchPlaylists() {
      return requireProvider().getUserPlaylists({ limit: 1000 });
    },

    async searchSongs(keyword, limit = 30, offset = 0, order = 'hot') {
      const result = await requireProvider().searchTracks({ keyword, limit, offset, order });
      return { songs: result.tracks, songCount: result.total };
    },

    /** 搜歌单再逐个挖歌，用于「歌单深挖」这类旧接口。 */
    async deepSearch(keyword, opts = {}) {
      const maxPlaylists = opts.maxPlaylists ?? 10;
      const maxTracksPerPlaylist = opts.maxTracksPerPlaylist ?? 1000;
      const provider = requireProvider();

      const playlists = await provider.searchPlaylists({ keyword, limit: maxPlaylists });
      if (playlists.length === 0) throw new Error(`没有找到与「${keyword}」相关的歌单`);

      const seen = new Set();
      const songs = [];
      const playlistStats = [];

      for (const playlist of playlists) {
        try {
          const tracks = await provider.getPlaylistTracks(playlist.id, {
            maxTracks: maxTracksPerPlaylist,
          });

          let added = 0;
          for (const track of tracks) {
            const key = trackKey(track) || track.id;
            if (seen.has(key)) continue;
            seen.add(key);
            songs.push({ ...track, sourceWeight: 2 });
            added += 1;
          }

          playlistStats.push({
            id: playlist.id,
            name: playlist.name,
            trackCount: tracks.length,
            added,
          });
        } catch (error) {
          playlistStats.push({
            id: playlist.id,
            name: playlist.name,
            error: error?.message || String(error),
          });
        }
        await sleep(300);
      }

      return { playlistsFound: playlists.length, playlistStats, songs };
    },

    async artistAllSongs(artistName) {
      const result = await requireProvider().getArtistTracks(artistName);
      return {
        artist: result.artist,
        albumsFound: result.albumsFound,
        failedAlbums: result.failedAlbums,
        successPaths: result.successPaths,
        songs: result.tracks,
      };
    },
  };
}
