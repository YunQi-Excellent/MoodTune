/**
 * chrome.storage.local 的键名集中在这里，避免 background、仓储、
 * fs-sync 各自硬编码字符串后漂移。
 */
export const SESSIONS_KEY = 'chatSessions';
export const CURRENT_SESSION_KEY = 'currentSessionId';
export const SAVED_PLAYLISTS_KEY = 'savedPlaylists';
export const EQ_PRESETS_KEY = 'eqPresets';
export const LOCAL_LIBRARY_KEY = 'localMusicLibrary';

/** 需要同步到用户文件夹的键。 */
export const FOLDER_SYNC_KEYS = Object.freeze([
  SAVED_PLAYLISTS_KEY,
  EQ_PRESETS_KEY,
  SESSIONS_KEY,
  CURRENT_SESSION_KEY,
]);
