import { DEFAULT_PROVIDER_ID } from './constants.js';

/**
 * 把任意值转成限长字符串。
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function text(value, maxLength) {
  return String(value ?? '').slice(0, maxLength);
}

/**
 * 把字符串或数组形式的艺人信息统一成展示文本。
 * @param {unknown} value
 * @returns {string}
 */
export function artistsText(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => (typeof item === 'string' ? item : item?.name))
      .filter(Boolean)
      .join(' / ');
  }
  return String(value ?? '');
}

/**
 * 跨平台唯一键。旧数据没有 provider 时按网易云处理。
 * @param {{key?: string, provider?: string, providerId?: string|number, id?: string|number}|null|undefined} track
 * @returns {string}
 */
export function trackKey(track) {
  if (!track) return '';
  if (track.key) return String(track.key);

  const provider = track.provider || DEFAULT_PROVIDER_ID;
  const providerId = track.providerId === undefined || track.providerId === null || track.providerId === ''
    ? track.id
    : track.providerId;
  if (providerId === undefined || providerId === null || providerId === '') return '';
  return `${provider}:${providerId}`;
}

/**
 * 跨平台歌曲模型。
 * @typedef {Object} Track
 * @property {number|string|undefined} id
 * @property {string} provider
 * @property {string} providerId
 * @property {string} key
 * @property {string} name
 * @property {string} artists
 * @property {string[]} artistList
 * @property {string} album
 * @property {number} durationMs
 * @property {string} cover
 * @property {string} link
 */

/**
 * 归一化歌曲对象。保留旧字段（id/name/artists/...），追加 provider 维度。
 * @param {object} track
 * @param {{provider?: string}} [options]
 * @returns {Track}
 */
export function sanitizeTrack(track, { provider = DEFAULT_PROVIDER_ID } = {}) {
  const source = track && typeof track === 'object' ? track : {};
  const normalizedProvider = String(source.provider || provider);
  const id = source.id ?? source.providerId;
  const providerId = source.providerId ?? id;
  const artists = artistsText(source.artists ?? source.artistList);
  const artistList = Array.isArray(source.artistList)
    ? source.artistList
      .map(item => (typeof item === 'string' ? item : item?.name))
      .filter(Boolean)
    : artists.split(/\s*\/\s*/).filter(Boolean);

  const normalized = {
    id,
    provider: normalizedProvider,
    providerId: providerId === undefined || providerId === null ? '' : String(providerId),
    name: text(source.name, 300),
    artists: text(artists, 200),
    artistList,
    album: text(source.album, 300),
    durationMs: Number.isFinite(Number(source.durationMs)) ? Number(source.durationMs) : 0,
    cover: text(source.cover, 500),
    link: text(source.link, 500),
  };

  normalized.key = trackKey(normalized);
  return normalized;
}

/**
 * 判断两个歌曲对象是否指向同一平台上的同一首歌。
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
export function sameTrack(a, b) {
  const keyA = trackKey(a);
  const keyB = trackKey(b);
  return keyA !== '' && keyA === keyB;
}
