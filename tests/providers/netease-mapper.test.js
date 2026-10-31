import { describe, expect, it } from 'vitest';
import { mapArtist, mapPlaylistSummary, mapTrack } from '../../src/providers/netease/mapper.js';
import { rawArtist, rawCloudSong, rawLegacySong, rawPlaylist } from './fixtures.js';

describe('mapTrack', () => {
  it('映射 cloudsearch 新字段（ar / al / dt）', () => {
    const track = mapTrack(rawCloudSong);

    expect(track).toMatchObject({
      id: 123,
      provider: 'netease',
      providerId: '123',
      key: 'netease:123',
      name: '晴天',
      artists: '周杰伦 / 杨瑞代',
      artistList: ['周杰伦', '杨瑞代'],
      album: '叶惠美',
      durationMs: 269000,
      cover: 'https://p1.music.126.net/cover.jpg',
      link: 'https://music.163.com/#/song?id=123',
    });
  });

  it('映射旧版 search 字段（artists / album / duration）', () => {
    const track = mapTrack(rawLegacySong);

    expect(track).toMatchObject({
      id: 456,
      key: 'netease:456',
      artists: 'A / B',
      album: 'Old Album',
      durationMs: 180000,
      cover: 'https://p2.music.126.net/old.jpg',
    });
  });

  it('专辑与封面可被调用方覆盖', () => {
    const track = mapTrack(rawCloudSong, {
      album: '另一个专辑',
      cover: 'https://example.com/override.jpg',
    });

    expect(track.album).toBe('另一个专辑');
    expect(track.cover).toBe('https://example.com/override.jpg');
  });

  it('空对象不抛错', () => {
    const track = mapTrack(null);

    expect(track.provider).toBe('netease');
    expect(track.key).toBe('');
    expect(track.link).toBe('');
    expect(track.durationMs).toBe(0);
  });
});

describe('mapPlaylistSummary', () => {
  it('标记本人歌单并生成链接', () => {
    const playlist = mapPlaylistSummary(rawPlaylist, { currentUserId: 7 });

    expect(playlist).toMatchObject({
      id: 9001,
      name: '深夜写代码',
      trackCount: 12,
      privacy: 0,
      creator: 'Me',
      creatorId: 7,
      isOwn: true,
      link: 'https://music.163.com/#/playlist?id=9001',
    });
  });

  it('没有 currentUserId 时 isOwn 为 false', () => {
    expect(mapPlaylistSummary(rawPlaylist).isOwn).toBe(false);
  });
});

describe('mapArtist', () => {
  it('映射歌手信息', () => {
    expect(mapArtist(rawArtist)).toEqual({
      id: 55,
      name: 'Aimer',
      picUrl: 'https://p3.music.126.net/artist.jpg',
      albumCount: 9,
    });
  });

  it('兼容 img1v1Url 与 albumCount 字段', () => {
    expect(mapArtist({ id: 1, name: 'X', img1v1Url: 'img', albumCount: 3 })).toEqual({
      id: 1,
      name: 'X',
      picUrl: 'img',
      albumCount: 3,
    });
  });
});
