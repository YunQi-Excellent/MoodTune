import { afterAll, describe, expect, it, vi } from 'vitest';
import { rawCloudSong, rawPlaylist } from './providers/fixtures.js';

const messageListeners = [];

const chromeStub = {
  runtime: {
    onMessage: { addListener: listener => messageListeners.push(listener) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    getURL: path => path,
    getContexts: async () => [],
  },
  storage: {
    onChanged: { addListener: () => {} },
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
    session: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
  },
  sidePanel: { setPanelBehavior: async () => {} },
  tabs: { query: async () => [] },
  scripting: { executeScript: async () => {} },
};

const fetchStub = vi.fn(async input => {
  const url = new URL(String(input));
  const json = data => ({ ok: true, status: 200, json: async () => data });

  if (url.pathname === '/api/nuser/account/get') {
    return json({ code: 200, profile: { userId: 7, nickname: 'Me' } });
  }
  if (url.pathname === '/api/user/playlist') {
    return json({ code: 200, playlist: [rawPlaylist] });
  }
  if (url.pathname === '/api/cloudsearch/get/web') {
    return json({ code: 200, result: { songs: [rawCloudSong], songCount: 1 } });
  }
  if (url.pathname === '/api/song/enhance/player/url/v1') {
    return json({ code: 200, data: [{ url: 'http://m10.music.126.net/a.mp3' }] });
  }
  throw new Error(`unexpected URL: ${url}`);
});

vi.stubGlobal('chrome', chromeStub);
vi.stubGlobal('fetch', fetchStub);

await import('../background.js');

afterAll(() => {
  vi.unstubAllGlobals();
});

function callBackground(payload) {
  return new Promise((resolve, reject) => {
    const listener = messageListeners[0];
    if (!listener) {
      reject(new Error('background 没有注册消息监听器'));
      return;
    }
    const returned = listener(payload, {}, resolve);
    if (returned !== true) reject(new Error('background 没有异步处理该消息'));
  });
}

describe('background → provider 接线', () => {
  it('searchSongs 走 provider 并返回 Track', async () => {
    const result = await callBackground({
      action: 'searchSongs',
      keyword: '晴天',
      limit: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.songCount).toBe(1);
    expect(result.data[0]).toMatchObject({
      key: 'netease:123',
      name: '晴天',
      provider: 'netease',
      artists: '周杰伦 / 杨瑞代',
    });
  });

  it('fetchPlaylists 走 provider 并标记本人歌单', async () => {
    const result = await callBackground({ action: 'fetchPlaylists' });

    expect(result.ok).toBe(true);
    expect(result.data.user).toEqual({ uid: 7, nickname: 'Me' });
    expect(result.data.playlists[0]).toMatchObject({
      id: 9001,
      name: '深夜写代码',
      isOwn: true,
    });
  });

  it('PLAYER_RESOLVE_URL 走 provider 解析并升级 https', async () => {
    const result = await callBackground({
      target: 'background',
      type: 'PLAYER_RESOLVE_URL',
      payload: { song: { id: 123, provider: 'netease' } },
    });

    expect(result).toEqual({
      ok: true,
      url: 'https://m10.music.126.net/a.mp3',
    });
  });

  it('listSessions 走消息路由与会话仓储', async () => {
    const result = await callBackground({ action: 'listSessions' });

    expect(result).toEqual({ ok: true, sessions: [] });
  });

  it('pausePageAudio 走 provider 的外部播放器适配器', async () => {
    const result = await callBackground({ action: 'pausePageAudio' });

    expect(result.ok).toBe(true);
  });
});
