/**
 * 轻量音频标签读取：只解析本地曲库最常用的 ID3v1 / ID3v2 文本帧与 FLAC Vorbis Comment。
 *
 * 不引第三方依赖，是因为项目保持零构建；解析失败一律返回空对象，
 * 扫描器会用「文件名 → 歌手/歌名」兜底，不会因为一个坏标签中断整次扫描。
 */

const ID3_TEXT_FRAMES = Object.freeze({
  TIT2: 'title',
  TPE1: 'artist',
  TALB: 'album',
  TLEN: 'durationMs',
});

function ascii(bytes, start, length) {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function uint32be(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3];
}

function uint32le(bytes, offset) {
  return (bytes[offset] >>> 0)
    + (bytes[offset + 1] << 8)
    + (bytes[offset + 2] << 16)
    + (bytes[offset + 3] << 24);
}

function uint24be(bytes, offset) {
  return (bytes[offset] << 16) + (bytes[offset + 1] << 8) + bytes[offset + 2];
}

/** ID3v2 的 syncsafe 整数：每字节只使用低 7 位。 */
function syncsafe(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21)
    + ((bytes[offset + 1] & 0x7f) << 14)
    + ((bytes[offset + 2] & 0x7f) << 7)
    + (bytes[offset + 3] & 0x7f);
}

function cleanText(value) {
  const parts = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .split('\u0000')
    .map(part => part.trim());
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.filter(Boolean).join(' / ');
}

function decodeUtf16Be(bytes) {
  const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  return new TextDecoder('utf-16le').decode(swapped);
}

function decodeId3Text(bytes) {
  if (!bytes || bytes.length < 2) return '';
  const encoding = bytes[0];
  const body = bytes.subarray(1);

  if (encoding === 0) return cleanText(new TextDecoder('latin1').decode(body));
  if (encoding === 3) return cleanText(new TextDecoder('utf-8').decode(body));
  if (encoding === 1) {
    if (body[0] === 0xff && body[1] === 0xfe) {
      return cleanText(new TextDecoder('utf-16le').decode(body.subarray(2)));
    }
    if (body[0] === 0xfe && body[1] === 0xff) {
      return cleanText(decodeUtf16Be(body.subarray(2)));
    }
    return cleanText(new TextDecoder('utf-16le').decode(body));
  }
  if (encoding === 2) return cleanText(decodeUtf16Be(body));
  return '';
}

function readId3v1(tail) {
  if (tail.length < 128 || ascii(tail, 0, 3) !== 'TAG') return {};
  const text = (offset, length) => cleanText(
    new TextDecoder('latin1').decode(tail.subarray(offset, offset + length)),
  );
  return {
    title: text(3, 30),
    artist: text(33, 30),
    album: text(63, 30),
  };
}

function parseId3v2(bytes) {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return {};
  const major = bytes[3];
  const flags = bytes[5];
  const tagSize = syncsafe(bytes, 6);
  const tagEnd = Math.min(bytes.length, 10 + tagSize);
  const out = {};

  let offset = 10;
  if ((flags & 0x40) && offset + 4 <= tagEnd) {
    // 扩展头：v2.3 的长度字段不含自身，v2.4 的 syncsafe 长度含自身。
    const extSize = major >= 4 ? syncsafe(bytes, offset) : uint32be(bytes, offset) + 4;
    offset += Math.max(0, extSize);
  }

  // ID3v2.2 用 3 字节帧 ID，结构不同；直接交给 ID3v1 兜底。
  if (major === 2) return out;

  while (offset + 10 <= tagEnd) {
    const id = ascii(bytes, offset, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;

    const frameSize = major >= 4 ? syncsafe(bytes, offset + 4) : uint32be(bytes, offset + 4);
    if (!frameSize) break;
    const bodyStart = offset + 10;
    const bodyEnd = bodyStart + frameSize;
    if (bodyEnd > tagEnd) break;

    const key = ID3_TEXT_FRAMES[id];
    if (key) {
      const value = decodeId3Text(bytes.subarray(bodyStart, bodyEnd));
      if (value && !out[key]) {
        out[key] = key === 'durationMs' ? Number.parseInt(value, 10) || 0 : value;
      }
    }
    offset = bodyEnd;
  }

  return out;
}

function parseVorbisComments(bytes) {
  if (bytes.length < 8) return {};
  let offset = 0;
  const vendorLength = uint32le(bytes, offset);
  offset += 4;
  if (vendorLength > bytes.length - offset) return {};
  offset += vendorLength;
  if (offset + 4 > bytes.length) return {};
  const count = uint32le(bytes, offset);
  offset += 4;

  const out = {};
  const decoder = new TextDecoder('utf-8');
  const keyMap = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album' };

  for (let i = 0; i < count && offset + 4 <= bytes.length; i += 1) {
    const length = uint32le(bytes, offset);
    offset += 4;
    if (length > bytes.length - offset) break;
    const entry = decoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const target = keyMap[key];
    if (target && !out[target]) out[target] = cleanText(entry.slice(eq + 1));
  }

  return out;
}

function parseFlacBlocks(bytes) {
  if (bytes.length < 8 || ascii(bytes, 0, 4) !== 'fLaC') return {};
  const out = {};
  let offset = 4;

  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = uint24be(bytes, offset + 1);
    const bodyStart = offset + 4;
    const bodyEnd = bodyStart + length;
    if (bodyEnd > bytes.length) break;

    if (type === 0 && length >= 18) {
      const p = bodyStart;
      const sampleRate = (bytes[p + 10] << 12) | (bytes[p + 11] << 4) | (bytes[p + 12] >> 4);
      const totalSamples = ((bytes[p + 13] & 0x0f) * 0x100000000)
        + (bytes[p + 14] << 24)
        + (bytes[p + 15] << 16)
        + (bytes[p + 16] << 8)
        + bytes[p + 17];
      if (sampleRate > 0 && totalSamples > 0) {
        out.durationMs = Math.round((totalSamples / sampleRate) * 1000);
      }
    } else if (type === 4) {
      Object.assign(out, parseVorbisComments(bytes.subarray(bodyStart, bodyEnd)));
    }

    offset = bodyEnd;
    if (isLast) break;
  }

  return out;
}

function compact(values) {
  const out = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (key === 'durationMs') {
      if (Number.isFinite(value) && value > 0) out.durationMs = value;
    } else if (value) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 读取一个音频文件开头的标签。失败时返回 {}，不抛错。
 * @param {Blob & {name?: string, size?: number}} file
 * @returns {Promise<{title?: string, artist?: string, album?: string, durationMs?: number}>}
 */
export async function parseAudioMetadata(file) {
  if (!file || typeof file.slice !== 'function') return {};
  const name = String(file.name || '').toLowerCase();
  const size = Number(file.size) || 0;

  try {
    if (name.endsWith('.flac')) {
      const head = new Uint8Array(await file.slice(0, Math.min(size, 262144)).arrayBuffer());
      return compact(parseFlacBlocks(head));
    }

    if (name.endsWith('.mp3') || name.endsWith('.mp2')) {
      const head = new Uint8Array(await file.slice(0, Math.min(size, 1048576)).arrayBuffer());
      const fromV2 = parseId3v2(head);
      if (size >= 128) {
        const tail = new Uint8Array(await file.slice(size - 128).arrayBuffer());
        const fromV1 = readId3v1(tail);
        for (const [key, value] of Object.entries(fromV1)) {
          if (!fromV2[key] && value) fromV2[key] = value;
        }
      }
      return compact(fromV2);
    }
  } catch {
    // 标签损坏、文件被移动、权限失效：都退回文件名解析。
  }

  return {};
}
