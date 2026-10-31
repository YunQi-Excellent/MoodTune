import { listUserPlaylists } from './auth.js';
import { createNeteaseClient, defaultSleep } from './client.js';
import { createHttpClient } from './http.js';
import { mapArtist, mapPlaylistSummary, mapTrack } from './mapper.js';
import { NETEASE_DEFAULTS, NETEASE_LABEL, NETEASE_PROVIDER_ID } from './constants.js';

/**
 * 创建网易云 provider。
 * 依赖全部可注入：fetch/http/client/sleep/externalPlayer，方便测试与未来宿主替换。
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   http?: {requestJson: Function},
 *   client?: ReturnType<typeof createNeteaseClient>,
 *   sleep?: (ms: number) => Promise<void>,
 *   externalPlayer?: {pause?: () => Promise<void>},
 * }} [options]
 * @returns {import('../types.js').MusicProvider}
 */
export function createNeteaseProvider({ fetchImpl, http, client, sleep, externalPlayer } = {}) {
  const netease = client || createNeteaseClient({
    http: http || createHttpClient({ fetchImpl }),
    sleep,
  });
  const wait = sleep || defaultSleep;

  async function searchTracks({
    keyword,
    limit = NETEASE_DEFAULTS.searchLimit,
    offset = 0,
    order = 'hot',
  } = {}) {
    const term = String(keyword || '').trim();
    if (!term) throw new Error('搜索词不能为空');

    const result = await netease.searchSongs(term, { limit, offset, order });
    return {
      tracks: result.songs.map(song => mapTrack(song)),
      total: result.songCount || 0,
      via: result.via,
    };
  }

  async function searchPlaylists({ keyword, limit = NETEASE_DEFAULTS.playlistLimit } = {}) {
    const term = String(keyword || '').trim();
    if (!term) throw new Error('搜索词不能为空');

    const playlists = await netease.searchPlaylists(term, { limit });
    return playlists.map(playlist => mapPlaylistSummary(playlist));
  }

  async function getPlaylistTracks(playlistId, { maxTracks = NETEASE_DEFAULTS.playlistTracksMax } = {}) {
    if (playlistId === undefined || playlistId === null || playlistId === '') {
      throw new Error('缺少歌单 ID');
    }

    const songs = await netease.getPlaylistTracks(playlistId, { maxTracks });
    return songs.map(song => mapTrack(song));
  }

  async function getUserPlaylists(options = {}) {
    const { user, playlists } = await listUserPlaylists(netease, options);
    return {
      user,
      playlists: playlists.map(playlist => mapPlaylistSummary(playlist, {
        currentUserId: user.uid,
      })),
    };
  }

  async function getArtistTracks(artistName) {
    const name = String(artistName || '').trim();
    if (!name) throw new Error('歌手名不能为空');

    const artist = await netease.findArtist(name);
    const albums = await netease.getArtistAlbums(artist.id, artist.name);
    const tracks = [];
    const seen = new Set();
    const failedAlbums = [];
    const successPaths = {};

    for (const albumSummary of albums) {
      try {
        const { album, songs, via } = await netease.getAlbum(albumSummary.id);
        successPaths[via] = (successPaths[via] || 0) + 1;

        for (const song of songs) {
          const track = mapTrack(song, {
            album: album.name || albumSummary.name,
            cover: album.picUrl || albumSummary.picUrl,
          });
          if (track.key && seen.has(track.key)) continue;
          if (track.key) seen.add(track.key);
          tracks.push(track);
        }
      } catch (error) {
        failedAlbums.push({
          id: albumSummary.id,
          name: albumSummary.name || '',
          error: error?.message || String(error),
        });
      }
      await wait(NETEASE_DEFAULTS.artistPauseMs);
    }

    return {
      artist: mapArtist(artist),
      tracks,
      albumsFound: albums.length,
      failedAlbums,
      successPaths,
    };
  }

  async function resolveStreamUrl(track) {
    const id = track?.providerId ?? track?.id;
    if (id === undefined || id === null || id === '') throw new Error('缺少歌曲 ID');
    return netease.resolveStreamUrl(id);
  }

  async function pauseExternalPlayback() {
    if (externalPlayer && typeof externalPlayer.pause === 'function') {
      await externalPlayer.pause();
    }
  }

  return {
    id: NETEASE_PROVIDER_ID,
    label: NETEASE_LABEL,
    capabilities: Object.freeze({
      playback: 'direct',
      search: Object.freeze(['tracks', 'playlists', 'artists', 'userPlaylists']),
      auth: 'cookie',
      effects: true,
    }),
    searchTracks,
    searchPlaylists,
    getPlaylistTracks,
    getUserPlaylists,
    getArtistTracks,
    resolveStreamUrl,
    pauseExternalPlayback,
  };
}
