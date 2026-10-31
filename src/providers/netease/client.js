import { NETEASE_DEFAULTS } from './constants.js';

/** @param {number} ms */
export function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 网易云接口客户端。只负责 HTTP 与原始字段，返回 Track 的映射在 mapper/provider 完成。
 * @param {{http: {requestJson: Function}, sleep?: (ms: number) => Promise<void>}} options
 */
export function createNeteaseClient({ http, sleep = defaultSleep } = {}) {
  if (!http || typeof http.requestJson !== 'function') {
    throw new Error('createNeteaseClient 需要 http 客户端');
  }

  async function getAccount() {
    return http.requestJson('/api/nuser/account/get');
  }

  async function getUserPlaylists(uid, { limit = 1000, offset = 0 } = {}) {
    const data = await http.requestJson('/api/user/playlist', {
      params: { uid, limit, offset },
    });
    return Array.isArray(data?.playlist) ? data.playlist : [];
  }

  async function searchCloud(keyword, {
    limit = NETEASE_DEFAULTS.searchLimit,
    offset = 0,
    order = 'hot',
  } = {}) {
    const params = { s: keyword, type: 1, limit, offset };
    if (order) params.order = order;
    return http.requestJson('/api/cloudsearch/get/web', { params });
  }

  async function searchLegacy(keyword, {
    limit = NETEASE_DEFAULTS.searchLimit,
    offset = 0,
  } = {}) {
    return http.requestJson('/api/search/get/web', {
      params: { s: keyword, type: 1, limit, offset },
    });
  }

  async function searchSongs(keyword, options = {}) {
    try {
      const data = await searchCloud(keyword, options);
      return {
        songs: Array.isArray(data?.result?.songs) ? data.result.songs : [],
        songCount: Number(data?.result?.songCount) || 0,
        via: 'cloudsearch',
      };
    } catch (cloudError) {
      try {
        const data = await searchLegacy(keyword, options);
        return {
          songs: Array.isArray(data?.result?.songs) ? data.result.songs : [],
          songCount: Number(data?.result?.songCount) || 0,
          via: 'search/get',
        };
      } catch (legacyError) {
        throw new Error(
          `[netease] 搜索失败：${cloudError?.message || cloudError}；回退也失败：${legacyError?.message || legacyError}`,
          { cause: legacyError },
        );
      }
    }
  }

  async function searchPlaylists(keyword, { limit = NETEASE_DEFAULTS.playlistLimit } = {}) {
    const data = await http.requestJson('/api/search/get/web', {
      params: { s: keyword, type: 1000, limit, offset: 0 },
    });
    return Array.isArray(data?.result?.playlists) ? data.result.playlists : [];
  }

  async function getPlaylistDetail(playlistId) {
    const data = await http.requestJson('/api/v6/playlist/detail', {
      params: { id: playlistId, n: 1000, s: 8 },
    });
    return data?.playlist || null;
  }

  async function getSongDetails(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const data = await http.requestJson('/api/v3/song/detail', {
      params: { c: JSON.stringify(ids.map(id => ({ id }))) },
    });
    return Array.isArray(data?.songs) ? data.songs : [];
  }

  async function getPlaylistTracks(playlistId, {
    maxTracks = NETEASE_DEFAULTS.playlistTracksMax,
    batchSize = NETEASE_DEFAULTS.batchSize,
    pauseMs = NETEASE_DEFAULTS.batchPauseMs,
  } = {}) {
    const playlist = await getPlaylistDetail(playlistId);
    const trackIds = Array.isArray(playlist?.trackIds) ? playlist.trackIds : [];
    if (trackIds.length === 0) throw new Error('歌单 trackIds 为空');

    const limit = Math.max(1, Number(maxTracks) || NETEASE_DEFAULTS.playlistTracksMax);
    const size = Math.max(1, Number(batchSize) || NETEASE_DEFAULTS.batchSize);
    const ids = trackIds
      .map(item => item?.id)
      .filter(id => id !== undefined && id !== null)
      .slice(0, limit);

    const songs = [];
    for (let index = 0; index < ids.length; index += size) {
      const batch = await getSongDetails(ids.slice(index, index + size));
      songs.push(...batch);
      if (index + size < ids.length) await sleep(pauseMs);
    }
    return songs;
  }

  async function findArtist(name) {
    const data = await http.requestJson('/api/search/get/web', {
      params: { s: name, type: 100, limit: 10, offset: 0 },
    });
    const artists = Array.isArray(data?.result?.artists) ? data.result.artists : [];
    if (artists.length === 0) throw new Error(`没有找到歌手「${name}」`);
    return artists.find(artist => artist.name === name) || artists[0];
  }

  async function getArtistAlbumsViaApi(artistId, {
    maxPages = NETEASE_DEFAULTS.artistMaxPages,
    limit = NETEASE_DEFAULTS.artistPageSize,
    pauseMs = NETEASE_DEFAULTS.artistPauseMs,
  } = {}) {
    const albums = [];
    const seen = new Set();
    let offset = 0;

    for (let page = 0; page < maxPages; page++) {
      const data = await http.requestJson(`/api/artist/albums/${artistId}`, {
        params: { offset, limit },
      });
      const batch = data?.hotAlbums || data?.albums || (Array.isArray(data) ? data : []);
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const album of batch) {
        if (album?.id === undefined || seen.has(album.id)) continue;
        seen.add(album.id);
        albums.push(album);
      }

      if (batch.length < limit) break;
      offset += limit;
      await sleep(pauseMs);
    }
    return albums;
  }

  async function getArtistAlbumsViaSearch(artistName, artistId, {
    maxPages = NETEASE_DEFAULTS.artistMaxPages,
    limit = NETEASE_DEFAULTS.artistPageSize,
    pauseMs = NETEASE_DEFAULTS.artistPauseMs,
  } = {}) {
    const albums = [];
    const seen = new Set();
    let offset = 0;

    for (let page = 0; page < maxPages; page++) {
      const data = await http.requestJson('/api/search/get/web', {
        params: { s: artistName, type: 10, limit, offset },
      });
      const batch = Array.isArray(data?.result?.albums) ? data.result.albums : [];
      if (batch.length === 0) break;

      let added = 0;
      for (const album of batch) {
        if (album?.id === undefined || seen.has(album.id)) continue;
        if (album.artist
          && album.artist.id !== undefined
          && String(album.artist.id) !== String(artistId)) continue;
        seen.add(album.id);
        albums.push(album);
        added++;
      }

      if (batch.length < limit) break;
      if (added === 0) break;
      offset += limit;
      await sleep(pauseMs);
    }
    return albums;
  }

  async function getArtistAlbums(artistId, artistName, options = {}) {
    let albums = [];
    try {
      albums = await getArtistAlbumsViaApi(artistId, options);
    } catch {}
    if (albums.length === 0 && artistName) {
      try {
        albums = await getArtistAlbumsViaSearch(artistName, artistId, options);
      } catch {}
    }
    return albums;
  }

  async function getAlbum(albumId) {
    const paths = [
      `/api/v1/album/${albumId}`,
      `/api/album/${albumId}`,
      `/api/v1/album/${albumId}?ext=true`,
    ];
    let lastError = null;

    for (const path of paths) {
      try {
        const data = await http.requestJson(path);
        const songs = data?.songs || data?.album?.songs || [];
        if (!Array.isArray(songs) || songs.length === 0) {
          lastError = new Error('0 songs');
          continue;
        }
        return { album: data.album || {}, songs, via: path };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`专辑接口失败：${lastError?.message || 'unknown'}`);
  }

  async function resolveStreamUrl(trackId) {
    const tries = [
      {
        path: '/api/song/enhance/player/url/v1',
        params: { ids: `[${trackId}]`, level: 'exhigh', encodeType: 'aac' },
      },
      {
        path: '/api/song/enhance/player/url',
        params: { ids: `[${trackId}]`, br: 320000 },
      },
      {
        path: '/api/song/enhance/player/url',
        params: { ids: `[${trackId}]`, br: 128000 },
      },
    ];

    for (const { path, params } of tries) {
      try {
        const data = await http.requestJson(path, { params });
        const url = data?.data?.[0]?.url;
        if (url) return normalizeStreamUrl(url);
      } catch {}
    }
    throw new Error('无法获取播放地址（可能是 VIP 或版权限制）');
  }

  return {
    getAccount,
    getUserPlaylists,
    searchCloud,
    searchLegacy,
    searchSongs,
    searchPlaylists,
    getPlaylistDetail,
    getSongDetails,
    getPlaylistTracks,
    findArtist,
    getArtistAlbumsViaApi,
    getArtistAlbumsViaSearch,
    getArtistAlbums,
    getAlbum,
    resolveStreamUrl,
  };
}

/** @param {string} url */
export function normalizeStreamUrl(url) {
  return String(url).replace(/^http:\/\//i, 'https://');
}
