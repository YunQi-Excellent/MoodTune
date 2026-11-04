import { describe, expect, it, vi } from 'vitest';
import { createNeteaseProvider } from '../../src/providers/netease/index.js';
import { rawAlbum, rawArtist, rawCloudSong, rawPlaylist } from './fixtures.js';

function makeClient(overrides = {}) {
  return {
    searchSongs: vi.fn(async () => ({
      songs: [rawCloudSong],
      songCount: 1,
      via: 'cloudsearch',
    })),
    searchPlaylists: vi.fn(async () => [rawPlaylist]),
    getPlaylistTracks: vi.fn(async () => [rawCloudSong]),
    getAccount: vi.fn(async () => ({ profile: { userId: 7, nickname: 'Me' } })),
    getUserPlaylists: vi.fn(async () => [rawPlaylist]),
    findArtist: vi.fn(async () => rawArtist),
    getArtistAlbums: vi.fn(async () => [rawAlbum]),
    getAlbum: vi.fn(async () => ({
      album: rawAlbum,
      songs: [rawCloudSong],
      via: '/api/v1/album/77',
    })),
    resolveStreamUrl: vi.fn(async () => 'https://stream.example/song.mp3'),
    ...overrides,
  };
}

describe('createNeteaseProvider', () => {
  it('声明平台能力', () => {
    const provider = createNeteaseProvider({ client: makeClient(), sleep: async () => {} });

    expect(provider.id).toBe('netease');
    expect(provider.label).toBe('网易云音乐');
    expect(provider.capabilities).toEqual({
      playback: 'direct',
      search: ['tracks', 'playlists', 'artists', 'userPlaylists'],
      auth: 'cookie',
      effects: true,
    });
  });

  it('searchTracks 映射成 Track', async () => {
    const client = makeClient();
    const provider = createNeteaseProvider({ client, sleep: async () => {} });

    const result = await provider.searchTracks({ keyword: '晴天', limit: 10 });

    expect(client.searchSongs).toHaveBeenCalledWith('晴天', {
      limit: 10,
      offset: 0,
      order: 'hot',
      signal: undefined,
    });
    expect(result.total).toBe(1);
    expect(result.via).toBe('cloudsearch');
    expect(result.tracks[0]).toMatchObject({
      key: 'netease:123',
      name: '晴天',
      artists: '周杰伦 / 杨瑞代',
    });
  });

  it('searchTracks 拒绝空关键词', async () => {
    const provider = createNeteaseProvider({ client: makeClient(), sleep: async () => {} });

    await expect(provider.searchTracks({ keyword: '  ' })).rejects.toThrow('搜索词不能为空');
  });

  it('searchPlaylists 映射摘要', async () => {
    const provider = createNeteaseProvider({ client: makeClient(), sleep: async () => {} });

    const playlists = await provider.searchPlaylists({ keyword: '深夜', limit: 5 });

    expect(playlists).toEqual([
      expect.objectContaining({
        id: 9001,
        name: '深夜写代码',
        isOwn: false,
        link: 'https://music.163.com/#/playlist?id=9001',
      }),
    ]);
  });

  it('getPlaylistTracks 映射成 Track[]', async () => {
    const client = makeClient();
    const provider = createNeteaseProvider({ client, sleep: async () => {} });

    const tracks = await provider.getPlaylistTracks(9001, { maxTracks: 50 });

    expect(client.getPlaylistTracks).toHaveBeenCalledWith(9001, { maxTracks: 50, signal: undefined });
    expect(tracks[0].key).toBe('netease:123');
  });

  it('getUserPlaylists 注入当前用户并标记本人歌单', async () => {
    const client = makeClient();
    const provider = createNeteaseProvider({ client, sleep: async () => {} });

    const result = await provider.getUserPlaylists({ limit: 20 });

    expect(result.user).toEqual({ uid: 7, nickname: 'Me' });
    expect(result.playlists[0].isOwn).toBe(true);
    expect(client.getUserPlaylists).toHaveBeenCalledWith(7, { limit: 20, offset: 0, signal: undefined });
  });

  it('getArtistTracks 汇总专辑并去重', async () => {
    const client = makeClient({
      getAlbum: vi.fn(async () => ({
        album: rawAlbum,
        songs: [rawCloudSong, rawCloudSong],
        via: '/api/v1/album/77',
      })),
    });
    const provider = createNeteaseProvider({ client, sleep: async () => {} });

    const result = await provider.getArtistTracks('Aimer');

    expect(client.findArtist).toHaveBeenCalledWith('Aimer', { signal: undefined });
    expect(client.getArtistAlbums).toHaveBeenCalledWith(55, 'Aimer', { signal: undefined });
    expect(result.artist).toMatchObject({ id: 55, name: 'Aimer', albumCount: 9 });
    expect(result.albumsFound).toBe(1);
    expect(result.tracks).toHaveLength(1);
    expect(result.successPaths).toEqual({ '/api/v1/album/77': 1 });
  });

  it('getArtistTracks 记录失败专辑', async () => {
    const client = makeClient({
      getAlbum: vi.fn(async () => { throw new Error('album down'); }),
    });
    const provider = createNeteaseProvider({ client, sleep: async () => {} });

    const result = await provider.getArtistTracks('Aimer');

    expect(result.tracks).toEqual([]);
    expect(result.failedAlbums).toEqual([
      { id: 77, name: 'Album', error: 'album down' },
    ]);
  });

  it('getArtistTracks 中止后不再继续拉专辑', async () => {
    const controller = new AbortController();
    const client = makeClient({
      getArtistAlbums: vi.fn(async () => [rawAlbum, { ...rawAlbum, id: 78, name: 'Album 2' }]),
      getAlbum: vi.fn(async () => {
        controller.abort();
        throw Object.assign(new Error('已中止'), { name: 'AbortError' });
      }),
    });
    const provider = createNeteaseProvider({ client, sleep: async () => {} });

    await expect(provider.getArtistTracks('Aimer', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    // 第一张专辑就中止了，第二张不该再请求。
    expect(client.getAlbum).toHaveBeenCalledTimes(1);
  });

  it('resolveStreamUrl 兼容 providerId 与 id', async () => {
    const client = makeClient();
    const provider = createNeteaseProvider({ client, sleep: async () => {} });

    await expect(provider.resolveStreamUrl({ providerId: '123', id: 123 }))
      .resolves.toBe('https://stream.example/song.mp3');
    await expect(provider.resolveStreamUrl({ id: 456 }))
      .resolves.toBe('https://stream.example/song.mp3');

    expect(client.resolveStreamUrl).toHaveBeenNthCalledWith(1, '123');
    expect(client.resolveStreamUrl).toHaveBeenNthCalledWith(2, 456);
    await expect(provider.resolveStreamUrl({})).rejects.toThrow('缺少歌曲 ID');
  });

  it('pauseExternalPlayback 转发到宿主播放器', async () => {
    const externalPlayer = { pause: vi.fn(async () => {}) };
    const provider = createNeteaseProvider({
      client: makeClient(),
      sleep: async () => {},
      externalPlayer,
    });

    await provider.pauseExternalPlayback();

    expect(externalPlayer.pause).toHaveBeenCalledTimes(1);
  });

  it('没有外部播放器时 pauseExternalPlayback 是空操作', async () => {
    const provider = createNeteaseProvider({ client: makeClient(), sleep: async () => {} });

    await expect(provider.pauseExternalPlayback()).resolves.toBeUndefined();
  });
});
