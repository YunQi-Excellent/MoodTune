import { sanitizeTrack } from '../../core/track.js';
import { NETEASE_PROVIDER_ID, playlistLink, songLink } from './constants.js';

/**
 * 网易云歌曲（cloudsearch 或旧 search 两套字段）→ Track。
 * @param {object} song
 * @param {{album?: string, cover?: string, link?: string}} [overrides]
 * @returns {import('../../core/track.js').Track}
 */
export function mapTrack(song, { album, cover, link } = {}) {
  const source = song && typeof song === 'object' ? song : {};
  const rawArtists = Array.isArray(source.ar) && source.ar.length > 0
    ? source.ar
    : (Array.isArray(source.artists) ? source.artists : []);
  const artistList = rawArtists
    .map(artist => (typeof artist === 'string' ? artist : artist?.name))
    .filter(Boolean);
  const rawAlbum = source.al && (source.al.name || source.al.picUrl)
    ? source.al
    : (source.album || source.al || {});
  const id = source.id;
  const durationMs = source.dt ?? source.duration ?? 0;

  return sanitizeTrack({
    id,
    provider: NETEASE_PROVIDER_ID,
    providerId: id,
    name: source.name || '',
    artists: artistList.join(' / '),
    artistList,
    album: album || rawAlbum?.name || '',
    durationMs,
    cover: cover || rawAlbum?.picUrl || '',
    link: link || (id === undefined || id === null ? '' : songLink(id)),
  }, { provider: NETEASE_PROVIDER_ID });
}

/**
 * @param {object} playlist
 * @param {{currentUserId?: number|string}} [options]
 * @returns {import('../types.js').PlaylistSummary}
 */
export function mapPlaylistSummary(playlist, { currentUserId } = {}) {
  const source = playlist && typeof playlist === 'object' ? playlist : {};
  const creatorId = source.creator?.userId;
  const id = source.id;

  return {
    id,
    name: source.name || '',
    trackCount: Number.isFinite(Number(source.trackCount)) ? Number(source.trackCount) : 0,
    privacy: Number.isFinite(Number(source.privacy)) ? Number(source.privacy) : 0,
    creator: source.creator?.nickname || '',
    creatorId,
    isOwn: currentUserId !== undefined
      && creatorId !== undefined
      && String(creatorId) === String(currentUserId),
    link: id === undefined || id === null ? '' : playlistLink(id),
  };
}

/**
 * @param {object} artist
 * @returns {import('../types.js').ArtistSummary}
 */
export function mapArtist(artist) {
  const source = artist && typeof artist === 'object' ? artist : {};
  const albumCount = source.albumSize ?? source.albumCount;

  return {
    id: source.id,
    name: source.name || '',
    picUrl: source.picUrl || source.img1v1Url || '',
    albumCount: Number.isFinite(Number(albumCount)) ? Number(albumCount) : 0,
  };
}
