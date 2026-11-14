/** 本地音乐 provider 的稳定标识与限制。 */
export const LOCAL_PROVIDER_ID = 'local';
export const LOCAL_LABEL = '本地音乐';

/** FileSystemDirectoryHandle 存在 IndexedDB 的键（与数据文件夹的 dataFolder 区分）。 */
export const LOCAL_MUSIC_HANDLE_KEY = 'musicLibrary';

/** 浏览器能直接交给 <audio> 的常见格式。 */
export const LOCAL_AUDIO_EXTENSIONS = Object.freeze([
  '.mp3',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.webm',
]);

/** 一次扫描最多收录多少首，避免把整个磁盘塞进 storage。 */
export const LOCAL_SCAN_MAX_TRACKS = 10000;
export const LOCAL_SCAN_MAX_DEPTH = 12;
