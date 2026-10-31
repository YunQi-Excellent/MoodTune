export const NETEASE_PROVIDER_ID = 'netease';
export const NETEASE_LABEL = '网易云音乐';
export const NETEASE_BASE_URL = 'https://music.163.com';

export const NETEASE_DEFAULTS = Object.freeze({
  searchLimit: 30,
  playlistLimit: 10,
  playlistTracksMax: 2000,
  batchSize: 100,
  batchPauseMs: 200,
  artistMaxPages: 20,
  artistPageSize: 100,
  artistPauseMs: 200,
});

/** @param {number|string} id */
export function songLink(id) {
  return `https://music.163.com/#/song?id=${id}`;
}

/** @param {number|string} id */
export function playlistLink(id) {
  return `https://music.163.com/#/playlist?id=${id}`;
}
