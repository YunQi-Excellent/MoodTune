import { describe, expect, it, vi } from 'vitest';
import { createNeteaseClient, normalizeStreamUrl } from '../../src/providers/netease/client.js';
import { rawCloudSong, rawPlaylist } from './fixtures.js';

function makeClient(requestJson, sleep = async () => {}) {
  return createNeteaseClient({ http: { requestJson }, sleep });
}

describe('searchSongs', () => {
  it('cloudsearch 失败时回退到 search/get', async () => {
    const requestJson = vi.fn()
      .mockRejectedValueOnce(new Error('cloud down'))
      .mockResolvedValueOnce({
        result: { songs: [rawCloudSong], songCount: 1 },
      });

    const client = makeClient(requestJson);
    const result = await client.searchSongs('jay', { limit: 10 });

    expect(result.via).toBe('search/get');
    expect(result.songs).toEqual([rawCloudSong]);
    expect(result.songCount).toBe(1);
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      '/api/cloudsearch/get/web',
      expect.objectContaining({
        params: expect.objectContaining({ s: 'jay', type: 1, limit: 10, order: 'hot' }),
      }),
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      '/api/search/get/web',
      expect.objectContaining({
        params: expect.objectContaining({ s: 'jay', type: 1, limit: 10 }),
      }),
    );
  });

  it('两路都失败时抛出合并错误', async () => {
    const requestJson = vi.fn(async () => { throw new Error('down'); });
    const client = makeClient(requestJson);

    await expect(client.searchSongs('jay')).rejects.toThrow('搜索失败');
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it('中止不会被 cloudsearch 回退吞掉', async () => {
    const requestJson = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const client = makeClient(requestJson);
    const controller = new AbortController();

    await expect(client.searchSongs('jay', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('signal 透传到 HTTP 层', async () => {
    const requestJson = vi.fn(async () => ({ result: { songs: [], songCount: 0 } }));
    const client = makeClient(requestJson);
    const controller = new AbortController();

    await client.searchSongs('jay', { signal: controller.signal });

    expect(requestJson).toHaveBeenCalledWith(
      '/api/cloudsearch/get/web',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('getPlaylistTracks', () => {
  it('按 batchSize 分批请求歌曲详情', async () => {
    const requestJson = vi.fn(async (path, options = {}) => {
      if (path === '/api/v6/playlist/detail') {
        return { playlist: { trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
      }
      if (path === '/api/v3/song/detail') {
        return {
          songs: JSON.parse(options.params.c).map(item => ({ id: item.id, name: `s${item.id}` })),
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const sleep = vi.fn(async () => {});
    const client = makeClient(requestJson, sleep);

    const songs = await client.getPlaylistTracks(9, { batchSize: 2 });

    expect(songs.map(song => song.id)).toEqual([1, 2, 3]);
    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      '/api/v6/playlist/detail',
      expect.objectContaining({ params: expect.objectContaining({ id: 9 }) }),
    );
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('遵守 maxTracks 上限', async () => {
    const requestJson = vi.fn(async (path, options = {}) => {
      if (path === '/api/v6/playlist/detail') {
        return { playlist: { trackIds: [1, 2, 3, 4, 5].map(id => ({ id })) } };
      }
      const ids = JSON.parse(options.params.c).map(item => item.id);
      return { songs: ids.map(id => ({ id })) };
    });
    const client = makeClient(requestJson);

    const songs = await client.getPlaylistTracks(9, { maxTracks: 2 });

    expect(songs.map(song => song.id)).toEqual([1, 2]);
  });

  it('空歌单抛错', async () => {
    const requestJson = vi.fn(async () => ({ playlist: { trackIds: [] } }));
    const client = makeClient(requestJson);

    await expect(client.getPlaylistTracks(9)).rejects.toThrow('trackIds 为空');
  });

  it('中止后不再继续分批拉歌曲详情', async () => {
    const controller = new AbortController();
    const requestJson = vi.fn(async (path) => {
      if (path === '/api/v6/playlist/detail') {
        return { playlist: { trackIds: [1, 2, 3, 4].map(id => ({ id })) } };
      }
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const client = makeClient(requestJson);

    await expect(client.getPlaylistTracks(9, { batchSize: 1, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    // 1 次歌单详情 + 第 1 批详情；第 1 批就中止了，后面的批次不该再发。
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});

describe('getArtistAlbums', () => {
  it('artist API 无结果时回退搜索，并过滤其他歌手', async () => {
    const requestJson = vi.fn(async (path, options = {}) => {
      if (path === '/api/artist/albums/55') return { hotAlbums: [] };
      if (path === '/api/search/get/web' && options.params.type === 10) {
        return {
          result: {
            albums: [
              { id: 77, name: 'Album', artist: { id: 55 } },
              { id: 78, name: 'Other', artist: { id: 99 } },
            ],
          },
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const client = makeClient(requestJson);

    const albums = await client.getArtistAlbums(55, 'Aimer');

    expect(albums.map(album => album.id)).toEqual([77]);
  });
});

describe('getUserPlaylists', () => {
  it('按 uid 拉取用户歌单', async () => {
    const requestJson = vi.fn(async () => ({ playlist: [rawPlaylist] }));
    const client = makeClient(requestJson);

    const playlists = await client.getUserPlaylists(7, { limit: 100 });

    expect(playlists).toEqual([rawPlaylist]);
    expect(requestJson).toHaveBeenCalledWith(
      '/api/user/playlist',
      expect.objectContaining({ params: { uid: 7, limit: 100, offset: 0 } }),
    );
  });
});

describe('resolveStreamUrl', () => {
  it('依次尝试三档音质并把 http 升级为 https', async () => {
    let calls = 0;
    const requestJson = vi.fn(async () => {
      calls++;
      if (calls < 3) return { data: [{ url: null }] };
      return { data: [{ url: 'http://m10.music.126.net/a.mp3' }] };
    });
    const client = makeClient(requestJson);

    const url = await client.resolveStreamUrl(123);

    expect(url).toBe('https://m10.music.126.net/a.mp3');
    expect(requestJson).toHaveBeenCalledTimes(3);
  });

  it('全部失败时抛出可读错误', async () => {
    const requestJson = vi.fn(async () => ({ data: [{ url: null }] }));
    const client = makeClient(requestJson);

    await expect(client.resolveStreamUrl(123)).rejects.toThrow('无法获取播放地址');
  });

  it('normalizeStreamUrl 只升级 http 协议', () => {
    expect(normalizeStreamUrl('http://a/b.mp3')).toBe('https://a/b.mp3');
    expect(normalizeStreamUrl('https://a/b.mp3')).toBe('https://a/b.mp3');
  });
});
