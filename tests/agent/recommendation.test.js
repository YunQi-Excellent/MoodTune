import { describe, expect, it, vi } from 'vitest';
import {
  coarseFilter,
  dedupByWeight,
  executeMyPlaylistsQuery,
  executeQuery,
  normalizePlan,
  normalizeToolName,
  selectPicks,
} from '../../src/agent/recommendation.js';
import { INTENT_CONFIG } from '../../src/core/constants.js';

const noSleep = async () => {};

describe('normalizeToolName', () => {
  it('把旧工具名映射到新名字', () => {
    expect(normalizeToolName('searchSongs')).toBe('searchTracks');
    expect(normalizeToolName('fetchArtistAllSongs')).toBe('getArtistTracks');
  });

  it('新工具名原样返回', () => {
    expect(normalizeToolName('myPlaylists')).toBe('myPlaylists');
    expect(normalizeToolName(undefined)).toBeUndefined();
  });
});

describe('normalizePlan', () => {
  it('缺少计划对象时抛错', () => {
    expect(() => normalizePlan(null)).toThrow('模型没有给出有效的检索计划');
  });

  it('没有检索动作时抛错', () => {
    expect(() => normalizePlan({ queries: [] })).toThrow('模型没有给出任何检索动作');
    expect(() => normalizePlan({})).toThrow('模型没有给出任何检索动作');
  });

  it('裁剪 query 数量并补默认 targetCount', () => {
    const queries = Array.from({ length: INTENT_CONFIG.maxQueries + 3 }, (_, i) => ({
      tool: 'searchTracks',
      keyword: `k${i}`,
    }));

    const plan = normalizePlan({ queries, targetCount: Number.NaN });

    expect(plan.queries).toHaveLength(INTENT_CONFIG.maxQueries);
    expect(plan.targetCount).toBe(10);
  });

  it('targetCount 夹在合法区间内', () => {
    expect(normalizePlan({ queries: [{}], targetCount: -5 }).targetCount).toBe(10);
    expect(normalizePlan({ queries: [{}], targetCount: 999 }).targetCount)
      .toBe(INTENT_CONFIG.maxTargetCount);
    expect(normalizePlan({ queries: [{}], targetCount: 4 }).targetCount).toBe(4);
  });
});

describe('dedupByWeight', () => {
  it('同一个 key 保留权重更高的那条', () => {
    const list = [
      { id: 1, provider: 'p', name: '低', sourceWeight: 1 },
      { id: 1, provider: 'p', name: '高', sourceWeight: 4 },
      { id: 2, provider: 'p', name: '别的', sourceWeight: 2 },
    ];

    const out = dedupByWeight(list);

    expect(out).toHaveLength(2);
    expect(out.find(song => song.id === 1).name).toBe('高');
  });

  it('没有 key 时退回 id', () => {
    const out = dedupByWeight([{ id: 7, name: 'a' }, { id: 7, name: 'b' }]);
    expect(out).toHaveLength(1);
  });
});

describe('coarseFilter', () => {
  const songs = [
    { id: 1, name: '雨天', album: 'A', artists: 'X', durationMs: 200_000, sourceWeight: 1 },
    { id: 2, name: '晴天', album: 'B', artists: 'Y', durationMs: 400_000, sourceWeight: 3, cover: 'c' },
    { id: 3, name: '夜曲', album: 'C', artists: 'Z', durationMs: 100_000, sourceWeight: 2 },
  ];

  it('按时长区间过滤', () => {
    const out = coarseFilter(songs, { durationMs: { min: 150_000, max: 300_000 } }, 10);
    expect(out.map(song => song.id)).toEqual([1]);
  });

  it('按排除关键词过滤标题/专辑/歌手', () => {
    expect(coarseFilter(songs, { excludeKeywords: ['雨天'] }, 10).map(s => s.id)).toEqual([2, 3]);
    expect(coarseFilter(songs, { excludeKeywords: ['z'] }, 10).map(s => s.id)).toEqual([2, 1]);
  });

  it('按权重降序，权重相同则有封面优先', () => {
    const out = coarseFilter([
      { id: 'a', sourceWeight: 1 },
      { id: 'b', sourceWeight: 1, cover: 'x' },
      { id: 'c', sourceWeight: 3 },
    ], {}, 10);

    expect(out.map(song => song.id)).toEqual(['c', 'b', 'a']);
  });

  it('截断到配置上限', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: i, sourceWeight: 1 }));
    const out = coarseFilter(many, {}, 2);

    expect(out).toHaveLength(INTENT_CONFIG.coarseFilterMin);
    expect(coarseFilter(many, {}, 100).length).toBeLessThanOrEqual(INTENT_CONFIG.coarseFilterMax);
  });

  it('过滤条件为空时原样返回（只排序）', () => {
    expect(coarseFilter(songs, undefined, 10)).toHaveLength(3);
  });
});

describe('selectPicks', () => {
  const candidates = [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'c' },
  ];

  it('过滤不存在的 id 与重复项，并带上理由', () => {
    const picks = selectPicks([
      { id: 2, reason: '合适' },
      { id: 99, reason: '不存在' },
      { id: '2', reason: '重复' },
      { id: 1, reason: 'x'.repeat(200) },
    ], candidates, 10);

    expect(picks.map(p => p.id)).toEqual([2, 1]);
    expect(picks[0].reason).toBe('合适');
    expect(picks[1].reason).toHaveLength(INTENT_CONFIG.rerankReasonMaxLen);
    expect(picks[1].name).toBe('a');
  });

  it('按 targetCount 截断', () => {
    const picks = selectPicks([{ id: 1 }, { id: 2 }, { id: 3 }], candidates, 2);
    expect(picks).toHaveLength(2);
  });

  it('picks 不是数组时抛错', () => {
    expect(() => selectPicks(null, candidates, 3)).toThrow('模型没有给出有效的 picks');
  });
});

describe('executeQuery', () => {
  function provider(overrides = {}) {
    return {
      searchTracks: vi.fn(async () => ({ tracks: [{ id: 1 }], total: 1 })),
      searchPlaylists: vi.fn(async () => [{ id: 'pl1', name: '歌单' }]),
      getPlaylistTracks: vi.fn(async () => [{ id: 2 }, { id: 3 }]),
      getArtistTracks: vi.fn(async () => ({ tracks: [{ id: 4 }] })),
      ...overrides,
    };
  }

  it('searchTracks 限制条数并打权重 3', async () => {
    const p = provider();
    const out = await executeQuery({ tool: 'searchSongs', keyword: '雨天', limit: 500 }, p, { sleep: noSleep });

    expect(p.searchTracks).toHaveBeenCalledWith({ keyword: '雨天', limit: 100, offset: 0, order: 'hot' });
    expect(out).toEqual([{ id: 1, sourceWeight: 3 }]);
  });

  it('searchPlaylists 逐个挖歌并打权重 2', async () => {
    const p = provider();
    const out = await executeQuery({ tool: 'searchPlaylists', keyword: '夜晚' }, p, { sleep: noSleep });

    expect(p.searchPlaylists).toHaveBeenCalledWith({ keyword: '夜晚', limit: 5 });
    expect(out).toEqual([{ id: 2, sourceWeight: 2 }, { id: 3, sourceWeight: 2 }]);
  });

  it('歌单挖取失败不影响整体', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = provider({
      searchPlaylists: vi.fn(async () => [{ id: 'a' }, { id: 'b' }]),
      getPlaylistTracks: vi.fn()
        .mockRejectedValueOnce(new Error('挂了'))
        .mockResolvedValueOnce([{ id: 5 }]),
    });

    const out = await executeQuery({ tool: 'searchPlaylists', keyword: 'x' }, p, { sleep: noSleep });
    expect(out).toEqual([{ id: 5, sourceWeight: 2 }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('getArtistTracks 打权重 1，空歌手名直接返回空', async () => {
    const p = provider();
    expect(await executeQuery({ tool: 'getArtistTracks', artistName: '  ' }, p, { sleep: noSleep }))
      .toEqual([]);

    const out = await executeQuery({ tool: 'fetchArtistAllSongs', artistName: '周杰伦' }, p, { sleep: noSleep });
    expect(p.getArtistTracks).toHaveBeenCalledWith('周杰伦');
    expect(out).toEqual([{ id: 4, sourceWeight: 1 }]);
  });

  it('未知工具抛错', async () => {
    await expect(executeQuery({ tool: 'rm-rf' }, provider())).rejects.toThrow('未知工具：rm-rf');
  });
});

describe('executeMyPlaylistsQuery', () => {
  function provider(playlists) {
    return {
      getUserPlaylists: vi.fn(async () => ({ playlists })),
      getPlaylistTracks: vi.fn(async id => [{ id: `${id}-1` }, { id: `${id}-1` }]),
    };
  }

  it('没有歌单时报错', async () => {
    await expect(executeMyPlaylistsQuery({}, provider([]))).rejects.toThrow('你的音乐账号下没有任何歌单');
  });

  it('按名字过滤，取前 N 个歌单并去重', async () => {
    const p = provider([
      { id: 'a', name: '深夜写代码', trackCount: 10 },
      { id: 'b', name: '通勤', trackCount: 5 },
    ]);

    const out = await executeMyPlaylistsQuery({ playlistName: '深夜', limit: 1 }, p, { sleep: noSleep });

    expect(p.getPlaylistTracks).toHaveBeenCalledTimes(1);
    expect(out).toEqual([{ id: 'a-1', sourceWeight: 4, fromPlaylist: '深夜写代码' }]);
  });

  it('多词匹配失败时给出候选歌单名', async () => {
    const p = provider([{ id: 'a', name: '深夜写代码' }]);

    await expect(executeMyPlaylistsQuery({ playlistName: '完全不 存在' }, p, { sleep: noSleep }))
      .rejects.toThrow('没有找到名字包含「完全不 存在」的歌单');
  });

  it('过滤掉空歌单', async () => {
    const p = provider([
      { id: 'a', name: '空', trackCount: 0 },
      { id: 'b', name: '有歌', trackCount: 3 },
    ]);

    const out = await executeMyPlaylistsQuery({}, p, { sleep: noSleep });
    expect(p.getPlaylistTracks).toHaveBeenCalledWith('b', { maxTracks: 400 });
    expect(out).toHaveLength(1);
  });
});
