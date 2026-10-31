import { describe, expect, it, vi } from 'vitest';
import { createChatAgent } from '../../src/agent/chat.js';
import { createSessionService } from '../../src/app/services/sessions.js';
import { createSessionStore } from '../../src/app/storage/sessions.js';
import { createMemoryArea } from '../helpers/memory-area.js';

const NOW = 1_700_000_000_000;
const FLAT_EQ = { preampDb: 0, bands: Array.from({ length: 10 }, () => ({ frequencyHz: 0, gainDb: 0 })) };

function setup({ responses = [], providers, llm: injectedLlm } = {}) {
  const area = createMemoryArea();
  let seq = 0;
  const newId = prefix => `${prefix}-${++seq}`;
  const store = createSessionStore({ area, now: () => NOW, newId });

  const player = {
    setEq: vi.fn(async eq => ({ ok: true, eq })),
    setPlaylist: vi.fn(async () => ({ ok: true })),
    pauseExternal: vi.fn(async () => {}),
  };
  const sessions = createSessionService({
    store,
    player,
    normalizeSong: song => song,
    defaultEq: () => FLAT_EQ,
    newId,
    now: () => NOW,
  });

  const playlists = { save: vi.fn(async payload => ({ id: 'pl-1', ...payload })) };
  const eqPresets = { save: vi.fn(async payload => ({ id: 'eq-1', ...payload })) };
  const notify = vi.fn();
  const llm = injectedLlm || { stream: vi.fn(async () => responses.shift()) };

  const agent = createChatAgent({
    llm,
    providers: providers || defaultProviders(),
    sessions,
    playlists,
    eqPresets,
    player,
    notify,
    now: () => NOW,
    newId,
    log: { warn: () => {}, error: () => {} },
  });

  return { agent, store, sessions, player, playlists, eqPresets, notify, llm };
}

function defaultProviders() {
  return {
    primary: {
      label: '测试平台',
      capabilities: { search: ['searchTracks', 'searchPlaylists', 'getArtistTracks'] },
      searchTracks: vi.fn(async () => ({
        tracks: [
          { id: 101, name: '雨天', artists: 'A', album: 'X', durationMs: 200_000 },
          { id: 102, name: '晴天', artists: 'B', album: 'Y', durationMs: 180_000 },
        ],
        total: 2,
      })),
    },
  };
}

const route = (mode, reply = '收到') => JSON.stringify({ mode, reply, payload: {} });

describe('createChatAgent 参数校验', () => {
  it('缺依赖时立刻报错', () => {
    expect(() => createChatAgent()).toThrow('需要 llm');
  });
});

describe('createChatAgent 路由', () => {
  it('chat 模式写回 ack 和帮助文案', async () => {
    const { agent, store, notify } = setup({ responses: [route('chat', '好的')] });

    await agent.start({ userNeed: '你好' });

    const session = await store.getCurrent();
    expect(session.messages.map(m => m.kind)).toEqual(['text', 'ack', 'text']);
    expect(session.messages[0]).toMatchObject({ role: 'user', text: '你好' });
    expect(session.messages[1]).toMatchObject({ kind: 'ack', text: '好的', mode: 'chat' });
    expect(session.messages[2].text).toContain('可以跟我说');
    expect(notify).toHaveBeenCalledWith('CHAT_THINKING_START', expect.objectContaining({ stage: 'route' }));
    expect(notify).toHaveBeenCalledWith('CHAT_THINKING_END', { sessionId: session.id });
  });

  it('路由模型输出坏 JSON 时退回搜索流程', async () => {
    const { agent, store, notify } = setup({ responses: ['不是 JSON'] });

    await agent.start({ userNeed: '随便听听' });

    const session = await store.getCurrent();
    expect(session.messages.map(m => m.kind)).toContain('error');
    expect(notify).toHaveBeenCalledWith('CHAT_PROGRESS', expect.objectContaining({ stage: 'plan' }));
  });
});

describe('createChatAgent 检索', () => {
  it('规划 → 检索 → 精排，写入 plan-card', async () => {
    const providers = defaultProviders();
    const { agent, store } = setup({
      providers,
      responses: [
        route('search', '找歌'),
        JSON.stringify({
          queries: [{ tool: 'searchSongs', keyword: '雨天', limit: 2 }],
          targetCount: 2,
        }),
        JSON.stringify({ picks: [{ id: '101', reason: '氛围合适' }] }),
      ],
    });

    await agent.start({ userNeed: '来点雨天的歌' });

    const session = await store.getCurrent();
    const card = session.messages.find(m => m.kind === 'plan-card');

    expect(card.picks).toHaveLength(1);
    expect(card.picks[0]).toMatchObject({ id: 101, name: '雨天', reason: '氛围合适' });
    expect(card.plan.queries[0]).toMatchObject({ tool: 'searchSongs', keyword: '雨天' });
    expect(card.stats).toEqual({ raw: 2, total: 2, filtered: 2 });

    expect(providers.primary.searchTracks).toHaveBeenCalledWith({
      keyword: '雨天',
      limit: 2,
      offset: 0,
      order: 'hot',
    });
  });

  it('排除会话购物车里已有的歌', async () => {
    const providers = defaultProviders();
    const { agent, store, sessions } = setup({
      providers,
      responses: [
        route('search'),
        JSON.stringify({ queries: [{ tool: 'searchSongs', keyword: '雨天' }], targetCount: 1 }),
        JSON.stringify({ picks: [{ id: 102, reason: 'ok' }] }),
      ],
    });
    const session = await store.create('测试');
    await sessions.cart.add(session.id, [{ id: 101, provider: 'netease' }]);

    await agent.start({ userNeed: '再来点', sessionId: session.id });

    const fresh = await store.get(session.id);
    const card = fresh.messages.find(m => m.kind === 'plan-card');
    expect(card.picks.map(pick => pick.id)).toEqual([102]);
    expect(card.stats.total).toBe(1);
  });

  it('规划失败时写入错误卡片', async () => {
    const { agent, store } = setup({ responses: [route('search'), '完全没有 JSON'] });

    await agent.start({ userNeed: '来点歌' });

    const session = await store.getCurrent();
    const error = session.messages.find(m => m.kind === 'error');
    expect(error.text).toBe('模型没有给出有效的检索计划');
  });

  it('没有检索结果时提示已包含候选', async () => {
    const providers = defaultProviders();
    providers.primary.searchTracks.mockResolvedValueOnce({ tracks: [], total: 0 });
    const { agent, store } = setup({
      providers,
      responses: [
        route('search'),
        JSON.stringify({ queries: [{ tool: 'searchTracks', keyword: 'x' }], targetCount: 1 }),
      ],
    });

    await agent.start({ userNeed: '来点歌' });

    const session = await store.getCurrent();
    expect(session.messages.find(m => m.kind === 'error').text)
      .toContain('没有检索到任何新歌曲');
  });
});

describe('createChatAgent 调音与保存', () => {
  it('eq 模式应用 EQ 并写入 eq-card', async () => {
    const { agent, store, player } = setup({
      responses: [
        JSON.stringify({ mode: 'eq', reply: '调好了', payload: { eqPrompt: '低频轻一点' } }),
        JSON.stringify({ eq: { preampDb: -2, bands: [] }, reason: '收低频' }),
      ],
    });

    await agent.start({ userNeed: '低频轻一点' });

    const session = await store.getCurrent();
    expect(player.setEq).toHaveBeenCalled();
    expect(session.cartEq).toMatchObject({ preampDb: -2 });
    expect(session.messages.find(m => m.kind === 'eq-card')).toMatchObject({ reason: '收低频' });
  });

  it('save-list 模式保存购物车里的歌', async () => {
    const { agent, store, sessions, playlists } = setup({
      responses: [JSON.stringify({ mode: 'save-list', reply: '保存中', payload: { name: '雨天歌单' } })],
    });
    const session = await store.create('测试');
    await sessions.cart.add(session.id, [{ id: 1 }, { id: 2 }]);

    await agent.start({ userNeed: '保存成雨天歌单', sessionId: session.id });

    expect(playlists.save).toHaveBeenCalledWith({
      name: '雨天歌单',
      songs: [{ id: 1 }, { id: 2 }],
      source: 'manual',
    });
    const fresh = await store.get(session.id);
    expect(fresh.messages.find(m => m.kind === 'save-card')).toMatchObject({
      cardType: 'playlist',
      count: 2,
    });
  });

  it('没有可保存的歌时写错误卡片', async () => {
    const { agent, store } = setup({
      responses: [JSON.stringify({ mode: 'save-list', reply: '保存中', payload: {} })],
    });

    await agent.start({ userNeed: '保存一下' });

    const session = await store.getCurrent();
    expect(session.messages.find(m => m.kind === 'error').text)
      .toContain('保存列表失败');
  });
});

describe('createChatAgent 中止', () => {
  it('abort 中止正在进行的请求，且不写错误卡片', async () => {
    const llm = {
      stream: vi.fn((messages, { signal } = {}) => new Promise((_, reject) => {
        if (signal?.aborted) { reject(new Error('已中止')); return; }
        signal?.addEventListener('abort', () => reject(new Error('已中止')));
      })),
    };
    const { agent, store } = setup({ llm });

    const running = agent.start({ userNeed: '深夜写歌' });
    expect(agent.running).toBe(true);
    expect(agent.abort()).toBe(true);

    await running;

    expect(agent.running).toBe(false);
    const session = await store.getCurrent();
    expect(session.messages.map(m => m.kind)).toEqual(['text']);
  });

  it('空闲时 abort 返回 false', () => {
    const { agent } = setup();
    expect(agent.abort()).toBe(false);
    expect(agent.running).toBe(false);
  });
});
