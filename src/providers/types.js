/**
 * Provider 契约（JSDoc 版）。
 * 这里只描述形状与能力，不注册任何实现。
 */

/** @typedef {import('../core/track.js').Track} Track */

export const PLAYBACK_MODES = Object.freeze(['direct', 'sdk', 'external', 'none']);
export const AUTH_KINDS = Object.freeze(['cookie', 'oauth', 'qr', 'none']);
export const SEARCH_KINDS = Object.freeze(['tracks', 'playlists', 'artists', 'userPlaylists']);

/**
 * 平台能力。playback 决定音频能不能进 Web Audio，effects 为 false 时 UI 应隐藏 EQ/音效。
 * @typedef {Object} ProviderCapabilities
 * @property {'direct'|'sdk'|'external'|'none'} playback
 * @property {Array<'tracks'|'playlists'|'artists'|'userPlaylists'>} search
 * @property {'cookie'|'oauth'|'qr'|'none'} auth
 * @property {boolean} effects
 */

/**
 * @typedef {Object} PlaylistSummary
 * @property {number|string|undefined} id
 * @property {string} name
 * @property {number} trackCount
 * @property {number} privacy
 * @property {string} creator
 * @property {number|string|undefined} creatorId
 * @property {boolean} isOwn
 * @property {string} link
 */

/**
 * @typedef {Object} UserSummary
 * @property {number|string} uid
 * @property {string} nickname
 */

/**
 * @typedef {Object} ArtistSummary
 * @property {number|string|undefined} id
 * @property {string} name
 * @property {string} picUrl
 * @property {number} albumCount
 */

/**
 * @typedef {Object} SearchTracksOptions
 * @property {string} keyword
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {string} [order]
 */

/**
 * @typedef {Object} SearchTracksResult
 * @property {Track[]} tracks
 * @property {number} total
 * @property {string} [via]
 */

/**
 * @typedef {Object} ArtistTracksResult
 * @property {ArtistSummary} artist
 * @property {Track[]} tracks
 * @property {number} albumsFound
 * @property {Array<{id: number|string|undefined, name: string, error: string}>} failedAlbums
 * @property {Record<string, number>} successPaths
 */

/**
 * 音乐平台适配器。新增平台只需实现这些方法，并在 registry 注册。
 * @typedef {Object} MusicProvider
 * @property {string} id
 * @property {string} label
 * @property {ProviderCapabilities} capabilities
 * @property {(options: SearchTracksOptions) => Promise<SearchTracksResult>} searchTracks
 * @property {(options: {keyword: string, limit?: number}) => Promise<PlaylistSummary[]>} searchPlaylists
 * @property {(playlistId: number|string, options?: {maxTracks?: number}) => Promise<Track[]>} getPlaylistTracks
 * @property {(options?: {limit?: number, offset?: number}) => Promise<{user: UserSummary, playlists: PlaylistSummary[]}>} getUserPlaylists
 * @property {(artistName: string) => Promise<ArtistTracksResult>} getArtistTracks
 * @property {(track: Track) => Promise<string>} resolveStreamUrl
 * @property {(() => Promise<void>)} [pauseExternalPlayback]
 */
