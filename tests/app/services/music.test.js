import { describe, expect, it, vi } from 'vitest';
import { createMusicService } from '../../../src/app/services/music.js';

function provider(overrides = {}) {
  return {
    getUserPlaylists: vi.fn(async () => ({
      user: { uid: 1, nickname: '我' },
      playlists: [{ id: 9001, name: '我喜欢的音乐', trackCount: 2 }],
    })),
    searchTracks: vi.fn(async () => ({
      tracks: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
      total: 42,
    })),
    searchPlaylists: vi.fn(async () => [
      { id: 'p1', name: '夜晚' },
      { id: 'p2', name: '雨天' },
    ]),
    getPlaylistTracks: vi.fn(async id => (id === 'p1'
      ? [{ id: 1 }, { id: 2 }]
      : [{ id: 2 }, { id: 3 }])),
    getArtistTracks: vi.fn(async () => ({
      artist: { id: 7, name: '某歌手' },
      albumsFound: 3,
      failedAlbums: ['x'],
      successPaths: ['album'],
      tracks: [{ id: 4 }],
    })),
    ...overrides,
  };
}

function setup(overrides) {
  const primary = provider(overrides);
  const providers = { primary, get: () => primary };
  const sleep = vi.fn(async () => {});
  return { service: createMusicService({ providers, sleep }), primary, sleep };
}

describe('createMusicService', () => {
  it('没有平台时立刻报错', () => {
    expect(() => createMusicService({})).toThrow('providers');
  });

  it('没有主平台时调用报错', async () => {
    const service = createMusicService({ providers: { primary: null } });
    await expect(service.fetchPlaylists()).rejects.toThrow('未注册音乐平台');
  });

  it('fetchPlaylists 透传账号歌单', async () => {
    const { service, primary } = setup();
    const data = await service.fetchPlaylists();

    expect(primary.getUserPlaylists).toHaveBeenCalledWith({ limit: 1000 });
    expect(data.playlists).toHaveLength(1);
  });

  it('searchSongs 把 tracks/total 映射成 songs/songCount', async () => {
    const { service, primary } = setup();
    const result = await service.searchSongs('雨天', 2, 10, 'time');

    expect(primary.searchTracks).toHaveBeenCalledWith({
      keyword: '雨天', limit: 2, offset: 10, order: 'time',
    });
    expect(result).toEqual({ songs: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], songCount: 42 });
  });

  it('deepSearch 跨歌单去重、打权重并记录每个歌单的情况', async () => {
    const { service, sleep } = setup();
    const result = await service.deepSearch('夜晚', { maxPlaylists: 2 });

    expect(result.playlistsFound).toBe(2);
    expect(result.songs.map(song => song.id)).toEqual([1, 2, 3]);
    expect(result.songs.every(song => song.sourceWeight === 2)).toBe(true);
    expect(result.playlistStats).toEqual([
      { id: 'p1', name: '夜晚', trackCount: 2, added: 2 },
      { id: 'p2', name: '雨天', trackCount: 2, added: 1 },
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('deepSearch 单个歌单失败不影响其它歌单', async () => {
    const { service } = setup({
      getPlaylistTracks: vi.fn()
        .mockRejectedValueOnce(new Error('限流'))
        .mockResolvedValueOnce([{ id: 3 }]),
    });

    const result = await service.deepSearch('夜晚');

    expect(result.songs).toEqual([{ id: 3, sourceWeight: 2 }]);
    expect(result.playlistStats[0]).toMatchObject({ id: 'p1', error: '限流' });
    expect(result.playlistStats[1]).toMatchObject({ id: 'p2', added: 1 });
  });

  it('deepSearch 没有搜到歌单时报错', async () => {
    const { service } = setup({ searchPlaylists: vi.fn(async () => []) });
    await expect(service.deepSearch('不存在的词')).rejects.toThrow('没有找到与「不存在的词」相关的歌单');
  });

  it('artistAllSongs 打包歌手与专辑信息', async () => {
    const { service, primary } = setup();
    const data = await service.artistAllSongs('某歌手');

    expect(primary.getArtistTracks).toHaveBeenCalledWith('某歌手');
    expect(data).toEqual({
      artist: { id: 7, name: '某歌手' },
      albumsFound: 3,
      failedAlbums: ['x'],
      successPaths: ['album'],
      songs: [{ id: 4 }],
    });
  });
});
