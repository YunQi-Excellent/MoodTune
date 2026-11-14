import { clearHandle, loadHandle, queryPermissionOnly } from '../../../fs-manager.js';
import { LOCAL_MUSIC_HANDLE_KEY } from '../../providers/local/constants.js';
import { scanDirectory } from '../../providers/local/scanner.js';
import { LOCAL_LIBRARY_KEY } from '../storage/keys.js';
import { storageQueue } from '../storage/storage-queue.js';

const EMPTY_INDEX = Object.freeze({ tracks: [], rootName: '', scannedAt: 0 });

function normalizeIndex(value) {
  if (!value || typeof value !== 'object') return { ...EMPTY_INDEX };
  return {
    tracks: Array.isArray(value.tracks) ? value.tracks : [],
    rootName: typeof value.rootName === 'string' ? value.rootName : '',
    scannedAt: Number(value.scannedAt) || 0,
  };
}

/**
 * 本地音乐目录：句柄、扫描索引与 chrome.storage 持久化。
 *
 * 句柄存在 IndexedDB（见 fs-manager.js），索引存在 storage.local；
 * 文件本身不复制、不上传。扫描时可以注入 onProgress 给侧边栏显示进度。
 *
 * @param {object} options
 * @param {{ get: Function, set: Function, remove: Function }} options.area
 * @param {string} [options.key]
 * @param {{ run: Function }} [options.queue]
 * @param {() => Promise<FileSystemDirectoryHandle|null>} [options.loadDirectory]
 * @param {(key?: string) => Promise<void>} [options.clearDirectory]
 * @param {(handle: FileSystemDirectoryHandle, mode: string) => Promise<string>} [options.queryPermission]
 * @param {Function} [options.scan]
 * @param {() => number} [options.now]
 */
export function createLocalLibrary({
  area,
  key = LOCAL_LIBRARY_KEY,
  queue = storageQueue,
  loadDirectory = () => loadHandle(LOCAL_MUSIC_HANDLE_KEY),
  clearDirectory = () => clearHandle(LOCAL_MUSIC_HANDLE_KEY),
  queryPermission = (handle, mode) => queryPermissionOnly(handle, mode),
  scan = scanDirectory,
  now = Date.now,
} = {}) {
  if (!area || typeof area.get !== 'function') {
    throw new Error('createLocalLibrary 需要 storage area');
  }

  const read = async () => {
    const data = await area.get(key);
    return normalizeIndex(data?.[key]);
  };

  const write = index => queue.run(key, () => area.set({ [key]: index }));

  return {
    getIndex: read,

    async list() {
      return read();
    },

    async status() {
      const [index, handle] = await Promise.all([read(), loadDirectory()]);
      const base = {
        trackCount: index.tracks.length,
        rootName: index.rootName,
        scannedAt: index.scannedAt,
      };
      if (!handle) return { state: 'unbound', ...base };

      const permission = await queryPermission(handle, 'read');
      return {
        state: permission === 'granted'
          ? 'bound'
          : permission === 'prompt' ? 'need-permission' : 'denied',
        name: handle.name || '',
        ...base,
      };
    },

    async scan({ onProgress } = {}) {
      const handle = await loadDirectory();
      if (!handle) return { ok: false, reason: 'no-handle' };

      const permission = await queryPermission(handle, 'read');
      if (permission !== 'granted') {
        return {
          ok: false,
          reason: permission === 'prompt' ? 'need-permission' : 'denied',
          name: handle.name || '',
        };
      }

      const result = await scan(handle, { onProgress });
      const index = {
        version: 1,
        rootName: handle.name || '',
        scannedAt: now(),
        tracks: result.tracks,
      };
      await write(index);

      return {
        ok: true,
        rootName: index.rootName,
        scannedAt: index.scannedAt,
        trackCount: result.tracks.length,
        skipped: result.skipped || 0,
        truncated: result.truncated === true,
      };
    },

    async clear() {
      await clearDirectory();
      await queue.run(key, () => area.remove(key));
      return { ok: true };
    },
  };
}
