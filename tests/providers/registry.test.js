import { describe, expect, it } from 'vitest';
import { ProviderRegistry, assertProvider } from '../../src/providers/registry.js';

function fakeProvider(overrides = {}) {
  return {
    id: 'fake',
    label: 'Fake',
    capabilities: {
      playback: 'external',
      search: ['tracks'],
      auth: 'none',
      effects: false,
    },
    searchTracks: async () => ({ tracks: [], total: 0 }),
    searchPlaylists: async () => [],
    getPlaylistTracks: async () => [],
    getUserPlaylists: async () => ({
      user: { uid: 1, nickname: '' },
      playlists: [],
    }),
    getArtistTracks: async () => ({
      artist: { id: 1, name: '', picUrl: '', albumCount: 0 },
      tracks: [],
      albumsFound: 0,
      failedAlbums: [],
      successPaths: {},
    }),
    resolveStreamUrl: async () => 'https://stream',
    ...overrides,
  };
}

describe('assertProvider', () => {
  it('接受完整 provider', () => {
    expect(assertProvider(fakeProvider()).id).toBe('fake');
  });

  it('拒绝缺少方法', () => {
    expect(() => assertProvider(fakeProvider({ resolveStreamUrl: undefined })))
      .toThrow('缺少方法：resolveStreamUrl');
  });

  it('拒绝非法能力', () => {
    expect(() => assertProvider(fakeProvider({
      capabilities: { playback: 'direct', search: ['tracks'], auth: 'none', effects: 'yes' },
    }))).toThrow('effects 必须是布尔值');
  });
});

describe('ProviderRegistry', () => {
  it('注册、查询、列表与主 provider', () => {
    const registry = new ProviderRegistry();
    const first = fakeProvider({ id: 'a' });
    const second = fakeProvider({ id: 'b' });

    registry.register(first).register(second, { primary: true });

    expect(registry.has('a')).toBe(true);
    expect(registry.get('a')).toBe(first);
    expect(registry.get('missing')).toBeNull();
    expect(registry.ids()).toEqual(['a', 'b']);
    expect(registry.list()).toEqual([first, second]);
    expect(registry.primary).toBe(second);
    expect(registry.primaryId).toBe('b');
  });

  it('构造函数按顺序注册，第一个成为主 provider', () => {
    const registry = new ProviderRegistry([
      fakeProvider({ id: 'a' }),
      fakeProvider({ id: 'b' }),
    ]);

    expect(registry.primaryId).toBe('a');
  });

  it('setPrimary 切换主 provider', () => {
    const registry = new ProviderRegistry([
      fakeProvider({ id: 'a' }),
      fakeProvider({ id: 'b' }),
    ]);

    registry.setPrimary('b');

    expect(registry.primaryId).toBe('b');
    expect(registry.require('b').id).toBe('b');
  });

  it('重复注册抛错', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider({ id: 'a' }));

    expect(() => registry.register(fakeProvider({ id: 'a' }))).toThrow('已注册');
  });

  it('未注册 provider 在 require / setPrimary 时抛错', () => {
    const registry = new ProviderRegistry();

    expect(() => registry.require('missing')).toThrow('未注册的 provider');
    expect(() => registry.setPrimary('missing')).toThrow('未注册的 provider');
  });
});
