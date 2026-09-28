// =====================================================
// 文件系统管理器
// 职责：
//   1. 把 FileSystemDirectoryHandle 存到 IndexedDB（因为 handle 不能被 chrome.storage 序列化）
//   2. 封装文件读写、权限检查
// =====================================================

const DB_NAME = 'moodtune-fs';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'dataFolder';

/* ============ IndexedDB：存取 handle ============ */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHandle(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadHandle() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function clearHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ============ 权限检查 ============ */
export async function queryPermissionOnly(handle, mode = 'readwrite') {
  if (!handle) return 'denied';
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return 'denied';
  }
}

// 注意：requestPermission 必须在用户手势里调用，否则必然失败
export async function verifyPermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

/* ============ 文件读写 ============ */
export async function ensureSubdir(parentHandle, name) {
  return await parentHandle.getDirectoryHandle(name, { create: true });
}

export async function fileExists(dirHandle, filename) {
  try {
    await dirHandle.getFileHandle(filename);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(dirHandle, filename) {
  try {
    const fh = await dirHandle.getFileHandle(filename);
    const file = await fh.getFile();
    const text = await file.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function writeJson(dirHandle, filename, data) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}

export async function removeFile(dirHandle, filename) {
  try {
    await dirHandle.removeEntry(filename);
    return true;
  } catch {
    return false;
  }
}