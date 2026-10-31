import { describe, expect, it } from 'vitest';
import { artistsText, sameTrack, sanitizeTrack, trackKey } from '../../src/core/track.js';

describe('trackKey', () => {
  it('优先使用显式 key', () => {
    expect(trackKey({ key: 'local:abc' })).toBe('local:abc');
  });

  it('旧数据没有 provider 时按网易云处理', () => {
    expect(trackKey({ id: 123 })).toBe('netease:123');
    expect(trackKey({ provider: 'qq', id: 'abc' })).toBe('qq:abc');
  });

  it('providerId 为空时回退到 id', () => {
    expect(trackKey({ provider: 'local', providerId: '', id: 7 })).toBe('local:7');
  });

  it('空对象返回空字符串', () => {
    expect(trackKey(null)).toBe('');
    expect(trackKey({})).toBe('');
  });
});

describe('sanitizeTrack', () => {
  it('归一化旧版歌曲字段并补 provider 维度', () => {
    const track = sanitizeTrack({
      id: 123,
      name: '晴天',
      artists: '周杰伦 / 杨瑞代',
      album: '叶惠美',
      durationMs: '269000',
      cover: 'https://example.com/c.jpg',
      link: 'https://music.163.com/#/song?id=123',
    });

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
      cover: 'https://example.com/c.jpg',
    });
  });

  it('支持数组艺人并保留调用方指定的 provider', () => {
    const track = sanitizeTrack(
      {
        provider: 'local',
        providerId: '/music/a.flac',
        name: 'A',
        artistList: ['X', { name: 'Y' }, null],
      },
      { provider: 'netease' },
    );

    expect(track.provider).toBe('local');
    expect(track.key).toBe('local:/music/a.flac');
    expect(track.artists).toBe('X / Y');
    expect(track.artistList).toEqual(['X', 'Y']);
  });

  it('限制文本长度并兜底 duration', () => {
    const track = sanitizeTrack({
      id: 1,
      name: 'x'.repeat(400),
      artists: 'y'.repeat(300),
      album: 'z'.repeat(400),
      durationMs: 'not-a-number',
      cover: 'c'.repeat(600),
      link: 'l'.repeat(600),
    });

    expect(track.name).toHaveLength(300);
    expect(track.artists).toHaveLength(200);
    expect(track.album).toHaveLength(300);
    expect(track.durationMs).toBe(0);
    expect(track.cover).toHaveLength(500);
    expect(track.link).toHaveLength(500);
  });

  it('空输入不抛错', () => {
    const track = sanitizeTrack(null);

    expect(track.provider).toBe('netease');
    expect(track.key).toBe('');
    expect(track.name).toBe('');
    expect(track.durationMs).toBe(0);
  });
});

describe('sameTrack', () => {
  it('按跨平台 key 比较', () => {
    expect(sameTrack({ id: 1 }, { provider: 'netease', providerId: '1' })).toBe(true);
    expect(sameTrack({ id: 1 }, { id: 2 })).toBe(false);
    expect(sameTrack(null, { id: 1 })).toBe(false);
  });
});

describe('artistsText', () => {
  it('兼容字符串与数组', () => {
    expect(artistsText('A / B')).toBe('A / B');
    expect(artistsText(['A', { name: 'B' }, null])).toBe('A / B');
    expect(artistsText(null)).toBe('');
  });
});
