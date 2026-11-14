import { throwIfAborted } from '../../core/abort.js';
import { LOCAL_LABEL, LOCAL_PROVIDER_ID } from './constants.js';

const EMPTY_INDEX = Object.freeze({ tracks: [], rootName: '', scannedAt: 0 });

function asList(index) {
  return Array.isArray(index?.tracks) ? index.tracks : [];
}

function normalizeKeyword(keyword) {
  return String(keyword || '').trim().toLowerCase();
}

function matches(track, tokens) {
  if (tokens.length === 0) return true;
  const haystack = [
    track.name,
    track.artists,
    track.album,
    track.providerId,
  ].join(' ').toLowerCase();
  return tokens.every(token => haystack.includes(token));
}

function playlistSummary(folder, count) {
  const name = folder
    ? folder.split('/').pop()
    : '全部本地音乐';
  return {
    id: folder,
    name,
    trackCount: count,
    privacy: 0,
    creator: '本地目录',
    creatorId: LOCAL_PROVIDER_ID,
    isOwn: true,
    link: '',
  };
}

/** 统计根目录与每一级子目录的歌曲数（父目录包含子目录）。 */
function folderCounts(tracks) {
  const counts = new Map();
  counts.set('', tracks.length);

  for (const track of tracks) {
    const path = String(track?.providerId ?? track?.id ?? '');
    const at = path.lastIndexOf('/');
    const folder = String(track?.folder ?? (at >= 0 ? path.slice(0, at) : ''));
    if (!folder) continue;
    const parts = folder.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      counts.set(current, (counts.get(current) || 0) + 1);
    }
  }

  return counts;
}

function inFolder(track, folder) {
  if (!folder) return true;
  const path = String(track?.providerId || '');
  return path.startsWith(`${folder}/`);
}

/**
 * 本地目录 provider。文件访问与扫描在宿主侧完成，这里只查已建好的索引，
 * 这样 provider 本身仍然是纯逻辑，可以直接单测。
 *
 * @param {object} options
 * @param {() => Promise<object>|object} options.getIndex 返回 `{ tracks, rootName, scannedAt }`
 */
export function createLocalProvider({ getIndex } = {}) {
  if (typeof getIndex !== 'function') throw new Error('createLocalProvider 需要 getIndex');

  async function index() {
    try {
      return (await getIndex()) || EMPTY_INDEX;
    } catch {
      return EMPTY_INDEX;
    }
  }

  async function searchTracks({ keyword, limit = 30, offset = 0, signal } = {}) {
    throwIfAborted(signal);
    const tokens = normalizeKeyword(keyword).split(/\s+/).filter(Boolean);
    const tracks = asList(await index()).filter(track => matches(track, tokens));
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(1, Math.min(200, Number(limit) || 30));
    return {
      tracks: tracks.slice(start, start + size).map(track => ({ ...track })),
      total: tracks.length,
      via: 'local-index',
    };
  }

  async function searchPlaylists({ keyword, limit = 20, signal } = {}) {
    throwIfAborted(signal);
    const tracks = asList(await index());
    const term = normalizeKeyword(keyword);
    const list = [...folderCounts(tracks).entries()]
      .filter(([folder]) => folder)
      .map(([folder, count]) => playlistSummary(folder, count))
      .filter(item => !term || item.name.toLowerCase().includes(term))
      .slice(0, Math.max(1, Number(limit) || 20));
    return list;
  }

  async function getPlaylistTracks(playlistId, { maxTracks = 1000, signal } = {}) {
    throwIfAborted(signal);
    const folder = String(playlistId || '').trim();
    const tracks = asList(await index()).filter(track => inFolder(track, folder));
    const limit = Math.max(1, Math.min(10000, Number(maxTracks) || 1000));
    return tracks.slice(0, limit).map(track => ({ ...track }));
  }

  async function getUserPlaylists({ limit = 1000, offset = 0, signal } = {}) {
    throwIfAborted(signal);
    const tracks = asList(await index());
    const all = [...folderCounts(tracks).entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
      .map(([folder, count]) => playlistSummary(folder, count));
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(1, Number(limit) || 1000);
    return {
      user: { uid: 'local', nickname: '本地音乐' },
      playlists: all.slice(start, start + size),
    };
  }

  async function getArtistTracks(artistName, { signal } = {}) {
    throwIfAborted(signal);
    const name = String(artistName || '').trim();
    if (!name) throw new Error('歌手名不能为空');

    const term = name.toLowerCase();
    const tracks = asList(await index()).filter((track) => {
      const artists = Array.isArray(track.artistList) && track.artistList.length
        ? track.artistList
        : String(track.artists || '').split(/\s*\/\s*/);
      return artists.some(artist => String(artist || '').toLowerCase().includes(term));
    });
    const albums = new Set(tracks.map(track => track.album).filter(Boolean));

    return {
      artist: {
        id: name,
        name,
        picUrl: '',
        albumCount: albums.size,
      },
      tracks: tracks.map(track => ({ ...track })),
      albumsFound: albums.size,
      failedAlbums: [],
      successPaths: { 'local-index': tracks.length },
    };
  }

  async function resolvePlayback(track) {
    const path = track?.providerId ?? track?.id;
    if (!path) throw new Error('缺少本地文件路径');
    return { kind: 'local', path: String(path) };
  }

  async function resolveStreamUrl(track) {
    const source = await resolvePlayback(track);
    // 兼容旧的字符串契约；真正播放由 resolvePlayback 走本地文件分支。
    return `local://${encodeURIComponent(source.path)}`;
  }

  return {
    id: LOCAL_PROVIDER_ID,
    label: LOCAL_LABEL,
    capabilities: Object.freeze({
      playback: 'direct',
      search: Object.freeze(['tracks', 'playlists', 'artists', 'userPlaylists']),
      auth: 'none',
      effects: true,
    }),
    searchTracks,
    searchPlaylists,
    getPlaylistTracks,
    getUserPlaylists,
    getArtistTracks,
    resolveStreamUrl,
    resolvePlayback,
  };
}
