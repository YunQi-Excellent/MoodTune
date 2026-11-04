import { describe, expect, it, vi } from 'vitest';
import { createChatHandlers } from '../../../src/app/background/handlers/chat.js';
import { createEqHandlers } from '../../../src/app/background/handlers/eq.js';
import { createFsHandlers } from '../../../src/app/background/handlers/fs.js';
import { createMusicHandlers } from '../../../src/app/background/handlers/music.js';
import { createPlayerHandlers } from '../../../src/app/background/handlers/player.js';
import { createPlaylistHandlers } from '../../../src/app/background/handlers/playlists.js';
import { createSessionHandlers } from '../../../src/app/background/handlers/sessions.js';

describe('chat handlers', () => {
  function setup() {
    const chat = { start: vi.fn(), abort: vi.fn(() => true) };
    const sessions = { current: vi.fn(async () => ({ id: 'sess-1' })) };
    const forward = vi.fn();
    return {
      chat,
      sessions,
      forward,
      handlers: createChatHandlers({ chat, sessions, forwardToSidepanel: forward }),
    };
  }

  it('chatStart 后台启动并立即回包（中止上一轮由 agent 负责）', () => {
    const { handlers, chat } = setup();

    const response = handlers.chatStart({ userNeed: ' 深夜写歌 ', sessionId: 'sess-3' });

    expect(response).toEqual({ ok: true });
    expect(chat.start).toHaveBeenCalledWith({
      userNeed: '深夜写歌',
      sessionId: 'sess-3',
      userMessageId: undefined,
    });
  });

  it('chatStart 空内容直接报错且不启动', () => {
    const { handlers, chat } = setup();

    expect(handlers.chatStart({ userNeed: '   ' })).toEqual({ ok: false, error: '内容为空' });
    expect(chat.start).not.toHaveBeenCalled();
  });

  it('chatAbort 中止并把当前会话一起告知侧边栏', async () => {
    const { handlers, chat, forward } = setup();

    await expect(handlers.chatAbort({})).resolves.toEqual({ ok: true, aborted: true });
    expect(chat.abort).toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith('CHAT_THINKING_END', { sessionId: 'sess-1', aborted: true });
  });

  it('没有在跑的任务时不广播结束事件', async () => {
    const { handlers, chat, forward } = setup();
    chat.abort.mockReturnValue(false);

    await expect(handlers.chatAbort({})).resolves.toEqual({ ok: true, aborted: false });
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('fs handlers', () => {
  function setup(overrides = {}) {
    const fs = {
      getStatus: vi.fn(async () => ({ state: 'bound', name: 'MoodTune' })),
      getLastSyncAt: vi.fn(() => 123),
      bind: vi.fn(async () => ({ ok: true, mode: 'push' })),
      unbind: vi.fn(async () => ({ ok: true })),
      syncNow: vi.fn(async () => ({ ok: true, direction: 'none' })),
      forcePush: vi.fn(async () => ({ ok: true })),
      pull: vi.fn(async () => ({ ok: true })),
      ...overrides,
    };
    return { fs, handlers: createFsHandlers(fs) };
  }

  it('fsGetStatus 合并状态与时间戳', async () => {
    const { handlers, fs } = setup();
    await expect(handlers.fsGetStatus({})).resolves.toEqual({
      ok: true, state: 'bound', name: 'MoodTune', lastSyncAt: 123,
    });
    expect(fs.getStatus).toHaveBeenCalled();
  });

  it('fsBindFolder 原样透传结果', async () => {
    const { handlers } = setup();
    await expect(handlers.fsBindFolder({})).resolves.toEqual({ ok: true, mode: 'push' });
  });

  it('fsForcePush 带上覆盖参数', async () => {
    const { handlers, fs } = setup();
    await handlers.fsForcePush({ allowEmpty: true });
    expect(fs.forcePush).toHaveBeenCalledWith({ force: true, allowEmptyOverwrite: true });
  });

  it('失败统一转成 { ok: false, reason }', async () => {
    const { handlers } = setup({
      syncNow: vi.fn(async () => { throw new Error('没有权限'); }),
    });
    await expect(handlers.fsSyncNow({})).resolves.toEqual({ ok: false, reason: '没有权限' });
  });
});

describe('player handlers', () => {
  function setup(overrides = {}) {
    const player = {
      saveEq: vi.fn(),
      saveEffects: vi.fn(),
      saveVolume: vi.fn(),
      loadPrefs: vi.fn(async () => ({ ok: true, volume: 0.5, eq: null, effects: null })),
      resolveStreamUrl: vi.fn(async () => 'https://a/1.mp3'),
      dispatch: vi.fn(async () => ({ ok: true })),
      ...overrides,
    };
    const forward = vi.fn();
    return { player, forward, handlers: createPlayerHandlers({ player, forwardToSidepanel: forward }) };
  }

  it('PERSIST_EQ / PERSIST_EFFECTS / PERSIST_VOLUME 只做持久化', () => {
    const { handlers, player } = setup();

    expect(handlers.types.PERSIST_EQ({ payload: { eq: { bands: [] } } })).toEqual({ ok: true });
    expect(handlers.types.PERSIST_EFFECTS({ payload: { effects: { enabled: true } } })).toEqual({ ok: true });
    expect(handlers.types.PERSIST_VOLUME({ payload: { volume: 0.3 } })).toEqual({ ok: true });
    expect(player.saveEq).toHaveBeenCalledWith({ bands: [] });
    expect(player.saveEffects).toHaveBeenCalledWith({ enabled: true });
    expect(player.saveVolume).toHaveBeenCalledWith(0.3);
  });

  it('PLAYER_RESOLVE_URL 返回解析出的地址', async () => {
    const { handlers } = setup();
    await expect(handlers.types.PLAYER_RESOLVE_URL({ payload: { song: { id: 1 } } }))
      .resolves.toEqual({ ok: true, url: 'https://a/1.mp3' });
  });

  it('PLAYER_STATE_CHANGED 转发给侧边栏', () => {
    const { handlers, forward } = setup();
    const payload = { playing: true };
    expect(handlers.types.PLAYER_STATE_CHANGED({ payload })).toEqual({ ok: true });
    expect(forward).toHaveBeenCalledWith('PLAYER_STATE_CHANGED', payload);
  });

  it('其余 PLAYER_* 转发给播放器，空响应补 { ok: true }', async () => {
    const { handlers, player } = setup({ dispatch: vi.fn(async () => undefined) });

    await expect(handlers.prefix.handle({ type: 'PLAYER_NEXT', payload: { x: 1 } }))
      .resolves.toEqual({ ok: true });
    expect(player.dispatch).toHaveBeenCalledWith('PLAYER_NEXT', { x: 1 });
  });
});

describe('music handlers', () => {
  function setup() {
    const music = {
      fetchPlaylists: vi.fn(async () => ({ playlists: [] })),
      searchSongs: vi.fn(async () => ({ songs: [{ id: 1 }], songCount: 1 })),
      deepSearch: vi.fn(async () => ({ songs: [] })),
      artistAllSongs: vi.fn(async () => ({ songs: [] })),
      pause: vi.fn(async () => {}),
    };
    return { music, handlers: createMusicHandlers(music) };
  }

  it('searchSongs 规整参数并回包', async () => {
    const { handlers, music } = setup();

    const response = await handlers.searchSongs({ keyword: ' 晴天 ', limit: 5, order: 'time' });

    expect(music.searchSongs).toHaveBeenCalledWith('晴天', 5, 0, 'time');
    expect(response).toEqual({ ok: true, data: [{ id: 1 }], songCount: 1, keyword: '晴天', order: 'time' });
  });

  it('searchSongs / deepSearch / artistAllSongs 缺参数时报错', async () => {
    const { handlers } = setup();

    expect(await handlers.searchSongs({ keyword: '' })).toEqual({ ok: false, error: '搜索词不能为空' });
    expect(await handlers.deepSearch({ keyword: ' ' })).toEqual({ ok: false, error: '搜索词不能为空' });
    expect(await handlers.artistAllSongs({ artistName: '' })).toEqual({ ok: false, error: '歌手名不能为空' });
  });

  it('pausePageAudio 走平台暂停', async () => {
    const { handlers, music } = setup();
    await expect(handlers.pausePageAudio({})).resolves.toEqual({ ok: true });
    expect(music.pause).toHaveBeenCalled();
  });
});

describe('playlist handlers', () => {
  function setup(session = { cart: [], result: null }) {
    const playlists = {
      list: vi.fn(async () => []),
      save: vi.fn(async payload => ({ id: 'pl-1', ...payload })),
      remove: vi.fn(async () => []),
      rename: vi.fn(async () => []),
      play: vi.fn(async () => ({ id: 'pl-1' })),
    };
    const sessions = { current: vi.fn(async () => session) };
    const player = { getState: vi.fn(async () => ({ ok: true, state: { playlist: [{ id: 9 }] } })) };
    return { playlists, sessions, player, handlers: createPlaylistHandlers({ playlists, sessions, player }) };
  }

  it('优先保存会话购物车', async () => {
    const { handlers, playlists, player } = setup({ cart: [{ id: 1 }], result: null });

    const response = await handlers.saveCurrentPlaylist({ name: '夜跑' });

    expect(playlists.save).toHaveBeenCalledWith({
      name: '夜跑', songs: [{ id: 1 }], source: 'manual',
    });
    expect(response.ok).toBe(true);
    expect(player.getState).not.toHaveBeenCalled();
  });

  it('购物车为空时退回结算快照', async () => {
    const { handlers, playlists } = setup({ cart: [], result: { playlist: [{ id: 2 }] } });

    await handlers.saveCurrentPlaylist({});
    expect(playlists.save).toHaveBeenCalledWith({
      name: '未命名', songs: [{ id: 2 }], source: 'manual',
    });
  });

  it('都为空时退回播放器当前歌单', async () => {
    const { handlers, playlists } = setup({ cart: [], result: null });

    await handlers.saveCurrentPlaylist({ name: 'x' });
    expect(playlists.save).toHaveBeenCalledWith({
      name: 'x', songs: [{ id: 9 }], source: 'manual',
    });
  });

  it('播放器也没有歌时报错', async () => {
    const { handlers, player } = setup({ cart: [], result: null });
    player.getState.mockResolvedValueOnce({ ok: true, state: { playlist: [] } });

    await expect(handlers.saveCurrentPlaylist({})).resolves.toEqual({
      ok: false, error: '没有可保存的歌曲',
    });
  });
});

describe('eq handlers', () => {
  function setup() {
    const presets = {
      list: vi.fn(async () => []),
      save: vi.fn(async payload => ({ id: 'eq-1', ...payload })),
      remove: vi.fn(async () => []),
      rename: vi.fn(async () => []),
      apply: vi.fn(async () => ({ preset: { id: 'eq-1' }, eq: { bands: [] } })),
    };
    const player = {
      getEq: vi.fn(async () => ({ ok: true, eq: { bands: [1] } })),
      setEq: vi.fn(async eq => ({ ok: true, eq })),
      resetEq: vi.fn(async () => ({ ok: true })),
      getEffects: vi.fn(async () => ({ ok: true, effects: { enabled: true } })),
      setEffects: vi.fn(async effects => ({ ok: true, effects })),
      resetEffects: vi.fn(async () => ({ ok: true })),
    };
    return { presets, player, handlers: createEqHandlers({ presets, player }) };
  }

  it('saveEqPreset 没传 eq 时读取当前 EQ', async () => {
    const { handlers, presets, player } = setup();

    await handlers.saveEqPreset({ name: '低频' });

    expect(player.getEq).toHaveBeenCalled();
    expect(presets.save).toHaveBeenCalledWith({
      name: '低频', eq: { bands: [1] }, source: 'manual',
    });
  });

  it('读不到当前 EQ 时报错', async () => {
    const { handlers, player } = setup();
    player.getEq.mockResolvedValueOnce({ ok: false });

    await expect(handlers.saveEqPreset({})).rejects.toThrow('读不到当前 EQ');
  });

  it('applyEqPreset 合并预设与应用结果', async () => {
    const { handlers } = setup();
    await expect(handlers.applyEqPreset({ id: 'eq-1' })).resolves.toEqual({
      ok: true, preset: { id: 'eq-1' }, eq: { bands: [] },
    });
  });

  it('setEqDirect / resetEq 在播放器无响应时补 ok', async () => {
    const { handlers, player } = setup();
    player.setEq.mockResolvedValueOnce(undefined);
    player.resetEq.mockResolvedValueOnce(undefined);

    await expect(handlers.setEqDirect({ eq: null })).resolves.toEqual({ ok: true });
    await expect(handlers.resetEq({})).resolves.toEqual({ ok: true });
  });

  it('效果链直连走同一个 player 通道', async () => {
    const { handlers, player } = setup();

    await expect(handlers.getEffectsState({})).resolves.toEqual({ ok: true, effects: { enabled: true } });
    await expect(handlers.setEffectsDirect({ effects: { enabled: false } })).resolves.toEqual({
      ok: true, effects: { enabled: false },
    });
    await expect(handlers.resetEffects({})).resolves.toEqual({ ok: true });
    expect(player.setEffects).toHaveBeenCalledWith({ enabled: false });
    expect(player.resetEffects).toHaveBeenCalled();
  });
});

describe('session handlers', () => {
  function setup() {
    const sessions = {
      list: vi.fn(async () => []),
      current: vi.fn(async () => ({ id: 'sess-1' })),
      create: vi.fn(async name => ({ id: 'sess-2', name })),
      switchTo: vi.fn(async id => ({ id })),
      remove: vi.fn(async () => []),
      rename: vi.fn(async (id, name) => ({ id, name })),
      cart: {
        add: vi.fn(async () => ({ added: 1, total: 1 })),
        remove: vi.fn(async () => ({ total: 0 })),
        reorder: vi.fn(async () => ({ total: 0 })),
        clear: vi.fn(async () => ({ total: 0 })),
        settle: vi.fn(async () => ({ ok: true, count: 1, result: {} })),
        setEq: vi.fn(async () => ({})),
      },
      updateResultSource: vi.fn(async () => {}),
      restore: vi.fn(async () => ({ eq: null, songCount: 0, messages: [] })),
      openEqPanel: vi.fn(async () => ({ messageId: 'msg-1' })),
    };
    return { sessions, handlers: createSessionHandlers(sessions) };
  }

  it('会话增删改查映射到服务', async () => {
    const { handlers, sessions } = setup();

    await expect(handlers.createSession({ name: '新' })).resolves.toEqual({
      ok: true, session: { id: 'sess-2', name: '新' },
    });
    await expect(handlers.listSessions({})).resolves.toEqual({ ok: true, sessions: [] });
    await handlers.deleteSession({ id: 'sess-1' });
    expect(sessions.remove).toHaveBeenCalledWith('sess-1');
  });

  it('购物车结果展开到响应里', async () => {
    const { handlers } = setup();
    await expect(handlers.cartAdd({ sessionId: 's', songs: [{ id: 1 }] }))
      .resolves.toEqual({ ok: true, added: 1, total: 1 });
    await expect(handlers.cartSettle({ sessionId: 's' }))
      .resolves.toEqual({ ok: true, count: 1, result: {} });
  });

  it('cartSetEq 传空值时存 null', async () => {
    const { handlers, sessions } = setup();
    await handlers.cartSetEq({ sessionId: 's', eq: null });
    expect(sessions.cart.setEq).toHaveBeenCalledWith('s', null);
  });

  it('updateSessionResultSource 只取来源字段', async () => {
    const { handlers, sessions } = setup();
    await handlers.updateSessionResultSource({ sessionId: 's', playlistSource: 'model' });
    expect(sessions.updateResultSource).toHaveBeenCalledWith('s', {
      playlistSource: 'model', eqSource: undefined,
    });
  });

  it('restoreSession / openEqPanel 展开服务结果', async () => {
    const { handlers } = setup();
    await expect(handlers.restoreSession({ id: 's' }))
      .resolves.toEqual({ ok: true, eq: null, songCount: 0, messages: [] });
    await expect(handlers.openEqPanel({})).resolves.toEqual({ ok: true, messageId: 'msg-1' });
  });
});
