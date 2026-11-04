/**
 * 原文直搜的命中判定。
 *
 * 提取检索词交给模型（自由输入没法用正则穷举），这里只做最后一步
 * 「平台返回的第一屏里，有没有和检索词对得上的结果」。
 * 判定统一在归一化文本上做：小写、去标点空白，再剥掉 op/ed/ost 这类格式后缀。
 */

const FORMAT_SUFFIXES = Object.freeze([
  'opening', 'ending',
  'op', 'ed', 'ost', 'bgm',
  '主题曲', '片头曲', '片尾曲', '插曲', '原声带', '原声',
]);

const PUNCTUATION = /[\s\-_·・.,，。！？!?'"“”‘’()（）[\]【】]/g;

/** @param {unknown} value */
export function normalizeForMatch(value) {
  return String(value ?? '').toLowerCase().replace(PUNCTUATION, '');
}

/**
 * 去掉「op / ed / 主题曲」这类版本限定词，只留作品名本身。
 * 只剥一个后缀，避免把歌名本身剥没了。
 * @param {string} query
 */
export function coreQuery(query) {
  let core = normalizeForMatch(query);
  for (const suffix of FORMAT_SUFFIXES) {
    const text = normalizeForMatch(suffix);
    if (core.length > text.length && core.endsWith(text)) {
      core = core.slice(0, -text.length);
      break;
    }
  }
  // 剥掉后缀后残留的连接词也要去掉：
  // "p4d的op" → "p4d的" → "p4d"，否则平台返回的歌名里永远找不到这个串。
  return core.replace(/[的之]+$/, '');
}

/**
 * 判断平台返回的某首歌是不是检索词指向的结果。
 * 两个方向任一成立即命中：
 * 1. 检索核心词出现在 歌名/专辑/歌手 里（"酒神" ⊂ "霓虹下的酒神"）
 * 2. 检索词按"的/空格"拆开后，每个片段都能在结果里找到
 *    （"周杰伦的晴天" → 歌手"周杰伦" + 歌名"晴天"）
 *
 * 故意不做「短歌名被长检索词包含」的判定：
 * "深夜写代码" 里包含"深夜"不代表用户要找《深夜》，
 * 这类氛围需求应该交给规划器，而不是被直搜短路。
 *
 * @param {string} query
 * @param {object} track
 */
export function isLiteralHit(query, track) {
  const core = coreQuery(query);
  if (core.length < 2 || !track) return false;
  // 纯英文/数字的 2 字符词（op、ed）太容易误命中，要求至少 3 个字符。
  if (/^[a-z0-9]+$/.test(core) && core.length < 3) return false;

  const haystack = normalizeForMatch(`${track.name || ''} ${track.album || ''} ${track.artists || ''}`);
  if (haystack.includes(core)) return true;

  const tokens = String(query)
    .toLowerCase()
    .split(/[\s的之/]+/)
    .map(coreQuery)
    .filter(token => token.length >= 2);
  return tokens.length > 1 && tokens.every(token => haystack.includes(token));
}
