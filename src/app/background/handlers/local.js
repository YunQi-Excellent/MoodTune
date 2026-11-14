import { LOCAL_PROVIDER_ID } from '../../../providers/local/constants.js';

const MAX_PLAY_TRACKS = 1000;

/**
 * 本地音乐目录相关消息。目录选择发生在侧边栏（需要用户手势），
 * 后台只负责扫描、读索引和把本地歌单交给播放器。
 *
 * @param {object} deps
 * @param {object} deps.localLibrary
 * @param {object} deps.player
 * @param {(type: string, payload?: object) => void} deps.forwardToSidepanel
 */
export function createLocalHandlers({ localLibrary, player, forwardToSidepanel }) {
  if (!localLibrary || !player) {
    throw new Error('createLocalHandlers 需要 localLibrary / player');
  }
  if (typeof forwardToSidepanel !== 'function') {
    throw new Error('createLocalHandlers 需要 forwardToSidepanel');
  }

  return {
    localStatus: async () => ({ ok: true, ...(await localLibrary.status()) }),

    localList: async () => {
      const index = await localLibrary.list();
      return {
        ok: true,
        tracks: index.tracks,
        rootName: index.rootName,
        scannedAt: index.scannedAt,
      };
    },

    localScan: async () => localLibrary.scan({
      onProgress: progress => forwardToSidepanel('LOCAL_SCAN_PROGRESS', progress),
    }),

    localClear: async () => localLibrary.clear(),

    localPlay: async (req) => {
      const status = await localLibrary.status();
      if (status.state !== 'bound') {
        return {
          ok: false,
          error: status.state === 'need-permission'
            ? '本地音乐目录权限已失效，请重新授权'
            : '还没有绑定本地音乐目录',
        };
      }

      const tracks = (Array.isArray(req.tracks) ? req.tracks : [])
        .filter(track => track?.provider === LOCAL_PROVIDER_ID && track?.providerId)
        .slice(0, MAX_PLAY_TRACKS);
      if (tracks.length === 0) return { ok: false, error: '没有可播放的本地歌曲' };

      const startIndex = Number.isInteger(req.startIndex)
        ? Math.max(0, Math.min(tracks.length - 1, req.startIndex))
        : 0;

      await player.pauseExternal();
      await player.setPlaylist(tracks, true, startIndex);
      return { ok: true, count: tracks.length, startIndex };
    },
  };
}
