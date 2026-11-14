/**
 * 把本地目录里的相对路径解析成 <audio> 能用的 blob URL。
 *
 * offscreen 与侧边栏/后台共享同一个扩展 origin，所以能读取 IndexedDB 里保存的
 * FileSystemDirectoryHandle。路径来自扫描索引，这里仍然做一次校验，避免
 * 消息里传入 `../` 之类的越界路径。
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {string} relativePath
 * @returns {Promise<File>}
 */
export async function getLocalFile(handle, relativePath) {
  if (!handle || typeof handle.getDirectoryHandle !== 'function') {
    throw new Error('本地音乐目录不可用');
  }

  const path = String(relativePath || '').trim();
  const parts = path.split('/');
  if (!path || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error('本地文件路径非法');
  }

  let directory = handle;
  for (let i = 0; i < parts.length - 1; i += 1) {
    directory = await directory.getDirectoryHandle(parts[i]);
  }
  const fileHandle = await directory.getFileHandle(parts[parts.length - 1]);
  return fileHandle.getFile();
}

/**
 * @param {FileSystemDirectoryHandle} handle
 * @param {string} relativePath
 * @param {{ createObjectURL?: (file: File) => string }} [options]
 * @returns {Promise<string>}
 */
export async function createLocalObjectUrl(handle, relativePath, {
  createObjectURL = file => URL.createObjectURL(file),
} = {}) {
  const file = await getLocalFile(handle, relativePath);
  return createObjectURL(file);
}
