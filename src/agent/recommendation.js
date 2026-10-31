import { INTENT_CONFIG } from '../core/constants.js';
import { trackKey } from '../core/track.js';

const TOOL_ALIASES = Object.freeze({
  searchSongs: 'searchTracks',
  fetchArtistAllSongs: 'getArtistTracks',
});

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 兼容旧工具名（模型历史输出 / 旧提示词）。 */
export function normalizeToolName(tool) {
  return TOOL_ALIASES[tool] || tool;
}

/**
 * 校验并规范化模型给出的检索计划。
 * 抛错信息直接面向用户（会进入错误卡片），所以保持中文短句。
 */
export function normalizePlan(plan) {
  if (!plan) throw new Error('模型没有给出有效的检索计划');

  const queries = Array.isArray(plan.queries)
    ? plan.queries.slice(0, INTENT_CONFIG.maxQueries)
    : [];

  let targetCount = Number(plan.targetCount);
  if (!Number.isFinite(targetCount) || targetCount < 0) targetCount = 10;
  if (targetCount > INTENT_CONFIG.maxTargetCount) targetCount = INTENT_CONFIG.maxTargetCount;

  if (queries.length === 0) throw new Error('模型没有给出任何检索动作');

  return { ...plan, queries, targetCount };
}

/** 同一个 key 只保留 sourceWeight 更高的一条。 */
export function dedupByWeight(candidates) {
  const byKey = new Map();
  for (const song of candidates) {
    const key = trackKey(song) || song.id;
    const existing = byKey.get(key);
    if (!existing || (song.sourceWeight || 0) > (existing.sourceWeight || 0)) {
      byKey.set(key, song);
    }
  }
  return [...byKey.values()];
}

/** 时长/关键词粗筛 + 权重排序 + 截断到给模型看的候选量。 */
export function coarseFilter(candidates, filters, targetCount) {
  let out = candidates;

  if (filters?.durationMs) {
    const { min, max } = filters.durationMs;
    out = out.filter((song) => {
      if (Number.isFinite(min) && song.durationMs && song.durationMs < min) return false;
      if (Number.isFinite(max) && song.durationMs && song.durationMs > max) return false;
      return true;
    });
  }

  if (Array.isArray(filters?.excludeKeywords)) {
    const keywords = filters.excludeKeywords
      .filter(word => typeof word === 'string' && word.trim())
      .map(word => word.toLowerCase());

    if (keywords.length) {
      out = out.filter((song) => {
        const text = `${song.name || ''} ${song.album || ''} ${song.artists || ''}`.toLowerCase();
        return !keywords.some(word => text.includes(word));
      });
    }
  }

  out.sort((a, b) => {
    const diff = (b.sourceWeight || 0) - (a.sourceWeight || 0);
    if (diff !== 0) return diff;
    return (b.cover ? 1 : 0) - (a.cover ? 1 : 0);
  });

  const cap = Math.min(
    Math.max((targetCount || 10) * INTENT_CONFIG.coarseFilterMultiplier, INTENT_CONFIG.coarseFilterMin),
    INTENT_CONFIG.coarseFilterMax,
  );
  return out.slice(0, cap);
}

/**
 * 把模型给的 picks 还原成候选对象：丢掉不存在的 id、去重、截断理由并限制数量。
 */
export function selectPicks(rawPicks, candidates, targetCount) {
  if (!Array.isArray(rawPicks)) throw new Error('模型没有给出有效的 picks');

  const byId = new Map(candidates.map(song => [String(song.id), song]));
  const seen = new Set();
  const picked = [];

  for (const raw of rawPicks) {
    const id = String(raw?.id ?? '');
    if (!id || !byId.has(id) || seen.has(id)) continue;

    seen.add(id);
    picked.push({
      ...byId.get(id),
      reason: String(raw.reason || '').slice(0, INTENT_CONFIG.rerankReasonMaxLen),
    });
    if (picked.length >= targetCount) break;
  }

  return picked;
}

/** 执行单个检索动作，返回带 sourceWeight 的候选。 */
export async function executeQuery(query, provider, { sleep = defaultSleep } = {}) {
  if (!provider) throw new Error('executeQuery 需要 provider');

  const tool = normalizeToolName(query.tool);

  if (tool === 'searchTracks') {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const result = await provider.searchTracks({
      keyword: String(query.keyword || ''),
      limit,
      offset: 0,
      order: 'hot',
    });
    return result.tracks.map(track => ({ ...track, sourceWeight: 3 }));
  }

  if (tool === 'searchPlaylists') {
    const limit = Math.min(Math.max(Number(query.limit) || 5, 1), 20);
    const maxTracks = Math.min(Math.max(Number(query.maxTracksPerPlaylist) || 200, 1), 500);
    const playlists = await provider.searchPlaylists({
      keyword: String(query.keyword || ''),
      limit,
    });

    const collected = [];
    for (const playlist of playlists) {
      try {
        const tracks = await provider.getPlaylistTracks(playlist.id, { maxTracks });
        for (const track of tracks) collected.push({ ...track, sourceWeight: 2 });
      } catch (e) {
        console.warn(`[意图搜索] 挖歌单 ${playlist.id} 失败：${e?.message || e}`);
      }
      await sleep(200);
    }
    return collected;
  }

  if (tool === 'getArtistTracks') {
    const artistName = String(query.artistName || '').trim();
    if (!artistName) return [];
    const result = await provider.getArtistTracks(artistName);
    return result.tracks.map(track => ({ ...track, sourceWeight: 1 }));
  }

  if (tool === 'myPlaylists') return executeMyPlaylistsQuery(query, provider, { sleep });

  throw new Error(`未知工具：${query.tool}`);
}

/** 从用户自己的歌单里挖歌：按名字匹配、排除空歌单、限制数量。 */
export async function executeMyPlaylistsQuery(query, provider, { sleep = defaultSleep } = {}) {
  if (!provider) throw new Error('executeMyPlaylistsQuery 需要 provider');

  const data = await provider.getUserPlaylists({ limit: 1000 });
  const allPlaylists = data.playlists || [];
  if (allPlaylists.length === 0) throw new Error('你的音乐账号下没有任何歌单');

  const keyword = String(query.playlistName || '').trim();
  let targets;

  if (!keyword) {
    targets = allPlaylists;
  } else {
    const kwLower = keyword.toLowerCase();
    targets = allPlaylists.filter(p => String(p.name).toLowerCase().includes(kwLower));

    if (targets.length === 0) {
      const words = kwLower.split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        targets = allPlaylists.filter((p) => {
          const name = String(p.name).toLowerCase();
          return words.every(word => name.includes(word));
        });
      }
    }

    if (targets.length === 0) {
      const names = allPlaylists.slice(0, 8).map(p => `「${p.name}」`).join('、');
      throw new Error(`没有找到名字包含「${keyword}」的歌单。你的歌单里有：${names}${allPlaylists.length > 8 ? ' 等' : ''}`);
    }
  }

  targets = targets.filter(p => (
    p.trackCount === null || p.trackCount === undefined || p.trackCount > 0
  ));

  const limit = Math.min(Math.max(Number(query.limit) || 5, 1), 20);
  const picked = targets.slice(0, limit);
  if (picked.length === 0) throw new Error('匹配到的歌单都是空的');

  const maxTracks = Math.min(Math.max(Number(query.maxTracksPerPlaylist) || 400, 1), 1000);
  const seen = new Set();
  const collected = [];

  for (const playlist of picked) {
    try {
      const tracks = await provider.getPlaylistTracks(playlist.id, { maxTracks });
      for (const track of tracks) {
        const key = trackKey(track) || track.id;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push({ ...track, sourceWeight: 4, fromPlaylist: playlist.name });
      }
    } catch (e) {
      console.warn(`[意图搜索] 挖用户歌单 ${playlist.id} 失败：${e?.message || e}`);
    }
    await sleep(200);
  }

  return collected;
}
