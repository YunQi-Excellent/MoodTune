import { throwIfAborted } from '../../core/abort.js';
import { sanitizeTrack } from '../../core/track.js';
import {
  LOCAL_AUDIO_EXTENSIONS,
  LOCAL_PROVIDER_ID,
  LOCAL_SCAN_MAX_DEPTH,
  LOCAL_SCAN_MAX_TRACKS,
} from './constants.js';
import { parseAudioMetadata } from './metadata.js';

const AUDIO_EXTENSIONS = new Set(LOCAL_AUDIO_EXTENSIONS);

function extensionOf(name) {
  const at = name.lastIndexOf('.');
  return at >= 0 ? name.slice(at).toLowerCase() : '';
}

export function isSupportedAudioFile(name) {
  return AUDIO_EXTENSIONS.has(extensionOf(name));
}

/** 从文件名猜「歌手 - 歌名」，作为标签缺失时的兜底。 */
export function parseFileName(name) {
  const base = String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/^\s*\d{1,3}[\s._-]+/, '')
    .trim();

  const parts = base.split(/\s+[-–—]\s+/).map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { artists: parts[0], name: parts.slice(1).join(' - ') };
  }
  return { artists: '', name: base };
}

function folderName(path) {
  const at = path.lastIndexOf('/');
  return at >= 0 ? path.slice(0, at) : '';
}

async function buildTrack(file, relativePath, parseMetadata) {
  const guessed = parseFileName(file.name);
  let tags;
  try {
    tags = await parseMetadata(file);
  } catch {
    tags = {};
  }
  tags = tags || {};

  const folder = folderName(relativePath);
  const albumFallback = folder ? folder.split('/').pop() : '';
  const artists = tags.artist || guessed.artists || '未知歌手';
  const name = tags.title || guessed.name || file.name;

  const track = sanitizeTrack({
    id: relativePath,
    providerId: relativePath,
    name,
    artists,
    album: tags.album || albumFallback || '未知专辑',
    durationMs: tags.durationMs || 0,
    cover: '',
    link: '',
  }, { provider: LOCAL_PROVIDER_ID });

  return { ...track, folder };
}

/**
 * 递归扫描目录。只读取支持的音频文件，坏文件跳过，不中断整次扫描。
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {object} [options]
 * @param {(file: Blob & {name?: string}) => Promise<object>} [options.parseMetadata]
 * @param {number} [options.maxTracks]
 * @param {number} [options.maxDepth]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: {scanned: number, tracks: number, skipped: number, current: string}) => void} [options.onProgress]
 * @returns {Promise<{tracks: object[], scanned: number, skipped: number, truncated: boolean}>}
 */
export async function scanDirectory(handle, {
  parseMetadata = parseAudioMetadata,
  maxTracks = LOCAL_SCAN_MAX_TRACKS,
  maxDepth = LOCAL_SCAN_MAX_DEPTH,
  signal,
  onProgress,
} = {}) {
  if (!handle || typeof handle.values !== 'function') {
    throw new Error('缺少本地音乐目录');
  }

  const tracks = [];
  let scanned = 0;
  let skipped = 0;
  let truncated = false;

  const progress = current => {
    if (typeof onProgress === 'function') {
      onProgress({ scanned, tracks: tracks.length, skipped, current });
    }
  };

  async function visit(directory, prefix, depth) {
    if (truncated) return;
    throwIfAborted(signal);

    for await (const entry of directory.values()) {
      throwIfAborted(signal);
      if (truncated) return;
      if (!entry || !entry.name || entry.name.startsWith('.')) continue;

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.kind === 'directory') {
        if (depth >= maxDepth) {
          skipped += 1;
          continue;
        }
        await visit(entry, relativePath, depth + 1);
        continue;
      }

      if (entry.kind !== 'file') continue;
      scanned += 1;
      if (scanned % 25 === 0) progress(relativePath);

      if (!isSupportedAudioFile(entry.name)) {
        skipped += 1;
        continue;
      }

      if (tracks.length >= maxTracks) {
        truncated = true;
        return;
      }

      try {
        const file = await entry.getFile();
        tracks.push(await buildTrack(file, relativePath, parseMetadata));
      } catch {
        skipped += 1;
      }
    }
  }

  await visit(handle, '', 0);
  tracks.sort((a, b) => a.providerId.localeCompare(b.providerId, 'zh-CN'));
  progress('');

  return { tracks, scanned, skipped, truncated };
}
