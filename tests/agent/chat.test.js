import { describe, expect, it, vi } from 'vitest';
import { createChatAgent } from '../../src/agent/chat.js';
import {
  DECIDE_SYSTEM,
  EXTRACT_SYSTEM,
  RERANK_SYSTEM,
} from '../../src/agent/prompts.js';
import { createSessionService } from '../../src/app/services/sessions.js';
import { createSessionStore } from '../../src/app/storage/sessions.js';
import { INTENT_CONFIG } from '../../src/core/constants.js';
import { createMemoryArea } from '../helpers/memory-area.js';

const NOW = 1_700_000_000_000;
const FLAT_EQ = { preampDb: 0, bands: Array.from({ length: 10 }, () => ({ frequencyHz: 0, gainDb: 0 })) };

function setup({ responses = [], providers, llm: injectedLlm, searchBudgetMs, now } = {}) {
  const area = createMemoryArea();
  let seq = 0;
  const newId = prefix => `${prefix}-${++seq}`;
  const clock = now || (() => NOW);
  const store = createSessionStore({ area, now: clock, newId });

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
    now: clock,
  });

  const playlists = { save: vi.fn(async payload => ({ id: 'pl-1', ...payload })) };
  const eqPresets = { save: vi.fn(async payload => ({ id: 'eq-1', ...payload })) };
  const notify = vi.fn();
  // 原文提取是无条件并行的，测试里默认返回空，避免吃掉 responses 队列。
  const llm = injectedLlm || {
    stream: vi.fn(async (messages) => {
      const system = messages[0]?.content || '';
      if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: '', specific: false });
      return responses.shift();
    }),
  };

  const agent = createChatAgent({
    llm,
    providers: providers || defaultProviders(),
    sessions,
    playlists,
    eqPresets,
    player,
    notify,
    now: clock,
    newId,
    log: { warn: () => {}, error: () => {} },
    searchBudgetMs,
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

const decide = (patch = {}) => JSON.stringify({ mode: 'search', reply: '收到', payload: {}, ...patch });

describe('createChatAgent 参数校验', () => {
  it('缺依赖时立刻报错', () => {
    expect(() => createChatAgent()).toThrow('需要 llm');
  });
});

describe('createChatAgent 路由', () => {
  it('chat 模式写回 ack 和帮助文案', async () => {
    const { agent, store, notify } = setup({ responses: [decide({ mode: 'chat', reply: '好的' })] });

    await agent.start({ userNeed: '你好' });

    const session = await store.getCurrent();
    expect(session.messages.map(m => m.kind)).toEqual(['text', 'ack', 'text']);
    expect(session.messages[0]).toMatchObject({ role: 'user', text: '你好' });
    expect(session.messages[1]).toMatchObject({ kind: 'ack', text: '好的', mode: 'chat' });
    expect(session.messages[2].text).toContain('可以跟我说');
    expect(notify).toHaveBeenCalledWith('CHAT_THINKING_START', expect.objectContaining({ stage: 'route' }));
    expect(notify).toHaveBeenCalledWith('CHAT_THINKING_END', { sessionId: session.id });
  });

  it('决策模型输出坏 JSON 时退回关键词兜底，而不是拿整句去搜', async () => {
    const { agent, store, notify } = setup({
      responses: ['不是 JSON', JSON.stringify({ picks: [{ id: '101', reason: '兜底' }] })],
    });

    await agent.start({ userNeed: '我想听雨天' });

    const session = await store.getCurrent();
    const card = session.messages.find(m => m.kind === 'plan-card');
    expect(card.plan.fallback).toBe(true);
    expect(card.plan.queries[0]).toMatchObject({ tool: 'searchTracks', keyword: '雨天' });
    // 整句一旦拿去搜，平台会切成「我想」返回一屏无关结果。
    expect(card.plan.queries.map(q => q.keyword)).not.toContain('我想听雨天');
    expect(card.stats.fallback).toBe(true);
    // 没有额外一次「规划」调用：坏 JSON 直接走兜底计划。
    expect(notify).toHaveBeenCalledWith('CHAT_PROGRESS', expect.objectContaining({ stage: 'execute' }));
  });

  it('决策超时/失败时用抽取阶段的关键词兜底，并标出兜底来源', async () => {
    const llm = {
      stream: vi.fn(async (messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: '高达SEED op', specific: true });
        if (system === DECIDE_SYSTEM) throw new Error('决策超时');
        if (system === RERANK_SYSTEM) return JSON.stringify({ picks: [{ id: '101', reason: 'OP' }] });
        return '';
      }),
    };
    const { agent, store } = setup({ llm });

    await agent.start({ userNeed: '我想听高达SEED中的op' });

    const session = await store.getCurrent();
    const card = session.messages.find(m => m.kind === 'plan-card');
    expect(card.plan.queries[0]).toMatchObject({ keyword: '高达SEED op' });
    // 剥掉 op 的核心词也会补一发，平台对短关键词更宽容。
    expect(card.plan.queries.map(q => q.keyword)).toContain('高达seed');
    expect(card.plan.queries.map(q => q.keyword)).not.toContain('我想听高达SEED中的op');
    expect(card.stats.fallback).toBe(true);
    expect(card.thinking.text).toContain('退回关键词检索');
  });

  it('精排一首都没留下时给一句说明，而不是空卡片', async () => {
    const { agent, store } = setup({
      responses: [
        decide({ queries: [{ tool: 'searchTracks', keyword: '雨天', limit: 2 }], targetCount: 2 }),
        JSON.stringify({ picks: [] }),
      ],
    });

    await agent.start({ userNeed: '来点雨天的歌' });

    const session = await store.getCurrent();
    expect(session.messages.some(m => m.kind === 'plan-card')).toBe(false);
    const last = session.messages[session.messages.length - 1];
    expect(last).toMatchObject({ kind: 'text' });
    expect(last.text).toContain('没找到对得上的歌');
  });
});

describe('createChatAgent 检索', () => {
  it('决策 → 检索 → 精排，写入 plan-card', async () => {
    const providers = defaultProviders();
    const { agent, store } = setup({
      providers,
      responses: [
        decide({
          reply: '找歌',
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
    expect(card.stats).toMatchObject({ raw: 2, total: 2, filtered: 2, carried: 0, added: 1 });
    // 思考流随卡片一起落库，重载后还能展开看。
    expect(card.thinking.text).toContain('"queries"');
    expect(card.thinking.text).toContain('"picks"');

    expect(providers.primary.searchTracks).toHaveBeenCalledWith({
      keyword: '雨天',
      limit: 2,
      offset: 0,
      order: 'hot',
      signal: expect.any(AbortSignal),
    });
  });

  it('检索期间不结束思考节点（否则停止按钮会消失）', async () => {
    const providers = defaultProviders();
    const { agent, notify } = setup({
      providers,
      responses: [
        decide({
          reply: '找歌',
          queries: [{ tool: 'searchSongs', keyword: '雨天', limit: 2 }],
          targetCount: 2,
        }),
        JSON.stringify({ picks: [{ id: '101', reason: '氛围合适' }] }),
      ],
    });

    await agent.start({ userNeed: '来点雨天的歌' });

    const calls = notify.mock.calls;
    const types = calls.map(([type]) => type);
    const executeAt = calls.findIndex(
      ([type, payload]) => type === 'CHAT_THINKING_START' && payload?.stage === 'execute',
    );

    expect(executeAt).toBeGreaterThanOrEqual(0);
    // 一轮检索只允许在真正结束时发一次 THINKING_END。
    expect(types.filter(type => type === 'CHAT_THINKING_END')).toHaveLength(1);
    expect(types.lastIndexOf('CHAT_THINKING_END')).toBeGreaterThan(executeAt);
  });

  it('原文直搜命中时跳过规划，直接出结果', async () => {
    const providers = {
      primary: {
        label: '测试平台',
        capabilities: { search: ['tracks'] },
        searchTracks: vi.fn(async () => ({
          tracks: [
            { id: 900, name: '霓虹下的酒神', artists: '酒神', album: '霓虹下的酒神 EP', durationMs: 180_000 },
            { id: 901, name: '别的歌', artists: 'X', album: 'Y', durationMs: 200_000 },
          ],
          total: 2,
        })),
      },
    };
    const llm = {
      stream: vi.fn(async (messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: '酒神op', specific: true });
        if (system === DECIDE_SYSTEM) return decide({ reply: '找歌' });
        throw new Error('命中后不应再调决策/精排');
      }),
    };
    const { agent, store } = setup({ providers, llm });

    await agent.start({ userNeed: '我想听酒神op' });

    const session = await store.getCurrent();
    const card = session.messages.find(m => m.kind === 'plan-card');

    expect(card.picks[0]).toMatchObject({
      id: 900,
      name: '霓虹下的酒神',
      reason: '原文直搜命中',
    });
    expect(card.stats).toMatchObject({ direct: true, total: 2 });
    expect(card.plan.queries[0]).toMatchObject({ tool: 'searchTracks', keyword: '酒神op' });
    expect(card.thinking.text).toContain('原文提取：酒神op');

    // 原文直搜用的是网页搜索同款相关性排序（不带 order=hot）。
    expect(providers.primary.searchTracks).toHaveBeenCalledWith({
      keyword: '酒神op',
      limit: INTENT_CONFIG.literalSearchLimit,
      offset: 0,
      order: '',
      signal: expect.anything(),
    });
    // 只调了「抽取 + 路由」两次，没有规划/精排。
    expect(llm.stream).toHaveBeenCalledTimes(2);
  });

  it('原文直搜没有命中时回退到决策里的检索动作', async () => {
    const providers = defaultProviders();
    const llm = {
      stream: vi.fn(async (messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: '酒神op', specific: true });
        if (system === DECIDE_SYSTEM) {
          return decide({ queries: [{ tool: 'searchTracks', keyword: '雨天', limit: 2 }], targetCount: 1 });
        }
        if (system === RERANK_SYSTEM) return JSON.stringify({ picks: [{ id: '101', reason: 'ok' }] });
        throw new Error('unexpected llm call');
      }),
    };
    const { agent, store } = setup({ providers, llm });

    await agent.start({ userNeed: '我想听酒神op' });

    const session = await store.getCurrent();
    const card = session.messages.find(m => m.kind === 'plan-card');

    expect(card.picks.map(pick => pick.id)).toEqual([101]);
    expect(card.stats.direct).toBeUndefined();
    expect(card.plan.queries[0]).toMatchObject({ tool: 'searchTracks', keyword: '雨天' });
  });

  it('原话搜不到时用剥掉「的 op」的核心词再搜一次', async () => {
    // 真实平台行为：搜「P4D的op」返回一堆钢琴练习曲，搜「p4d」才回到原声带。
    const providers = {
      primary: {
        label: '测试平台',
        capabilities: { search: ['tracks'] },
        searchTracks: vi.fn(async ({ keyword }) => (keyword === 'P4D的op'
          ? {
            tracks: [{ id: 1, name: '小奏鸣曲 op 36 no 4', artists: '阿D', album: '钢琴考级' }],
            total: 302,
          }
          : {
            tracks: [
              { id: 200, name: 'Your Affection (“NEVER MORE”P4D-EDIT ver.)', artists: '平田志穂子', album: 'Persona4 DANCING ALL NIGHT Original Soundtrack' },
              { id: 201, name: 'Dance!', artists: '平田志穂子', album: 'Persona4 DANCING ALL NIGHT Original Soundtrack' },
            ],
            total: 262,
          })),
      },
    };
    const llm = {
      stream: vi.fn(async (messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: 'P4D的op', specific: true });
        if (system === DECIDE_SYSTEM) return decide({ reply: '找歌' });
        throw new Error('命中后不应再调决策/精排');
      }),
    };
    const { agent, store } = setup({ providers, llm });

    await agent.start({ userNeed: '我想听P4D的op' });

    const session = await store.getCurrent();
    const card = session.messages.find(m => m.kind === 'plan-card');

    expect(card.stats.direct).toBe(true);
    expect(card.picks.map(pick => pick.id)).toEqual([200, 201]);
    expect(card.plan.queries[0]).toMatchObject({ keyword: 'p4d' });
    expect(card.thinking.text).toContain('原文提取：p4d');
    expect(providers.primary.searchTracks.mock.calls.map(([options]) => options.keyword))
      .toEqual(['P4D的op', 'p4d']);
  });

  it('原文直搜命中时不再等慢路由', async () => {
    let releaseRoute;
    const providers = {
      primary: {
        label: '测试平台',
        capabilities: { search: ['tracks'] },
        searchTracks: vi.fn(async () => ({
          tracks: [{ id: 900, name: '霓虹下的酒神', artists: '酒神', album: '霓虹下的酒神 EP' }],
          total: 1,
        })),
      },
    };
    const llm = {
      stream: vi.fn((messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return Promise.resolve(JSON.stringify({ query: '酒神', specific: true }));
        if (system === DECIDE_SYSTEM) {
          return new Promise((resolve) => { releaseRoute = () => resolve(decide({ reply: '慢路由' })); });
        }
        throw new Error('命中后不应再调决策/精排');
      }),
    };
    const { agent, store } = setup({ providers, llm });

    try {
      await agent.start({ userNeed: '我想听酒神' });

      const session = await store.getCurrent();
      const card = session.messages.find(m => m.kind === 'plan-card');
      const ack = session.messages.find(m => m.kind === 'ack');

      expect(card.stats.direct).toBe(true);
      // 用的是兜底 ack，说明没有等路由那一路。
      expect(ack.text).toBe('收到，正在找歌…');
    } finally {
      if (releaseRoute) releaseRoute();
    }
  });

  it('检索预算耗尽时中止并给出超时提示，而不是无限跑', async () => {
    // 手动时钟：让「决策」这一步真的消耗掉一段时间，阶段耗时才有内容。
    let clock = NOW;
    const now = () => clock;
    const slowDecide = {
      stream: vi.fn(async (messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: '', specific: false });
        if (system === DECIDE_SYSTEM) {
          clock += 10;
          return decide({ queries: [{ tool: 'searchTracks', keyword: '慢查询' }], targetCount: 1 });
        }
        throw new Error('unexpected llm call');
      }),
    };
    const providers = {
      primary: {
        label: '测试平台',
        capabilities: { search: ['tracks'] },
        searchTracks: vi.fn(({ signal } = {}) => new Promise((_, reject) => {
          const fail = () => reject(Object.assign(new Error('已中止'), { name: 'AbortError' }));
          if (signal?.aborted) { fail(); return; }
          signal?.addEventListener('abort', fail);
        })),
      },
    };
    const { agent, store } = setup({
      providers,
      llm: slowDecide,
      now,
      searchBudgetMs: 50,
    });

    await agent.start({ userNeed: '慢查询' });

    const session = await store.getCurrent();
    const error = session.messages.find(message => message.kind === 'error');
    expect(error.text).toContain('检索超时');
    // 超时也必须留下可展开的思考记录与阶段耗时，用户才知道到底慢在哪一步。
    expect(error.timingsText).toContain('决策');
    expect(error.thinking.text).toContain('阶段耗时');
  });

  it('预算在检索中途耗尽时，已拿到的候选仍然出卡而不是报超时', async () => {
    const providers = {
      primary: {
        label: '测试平台',
        capabilities: { search: ['searchTracks'] },
        searchTracks: vi.fn(({ keyword, signal } = {}) => {
          if (keyword === '快查询') {
            return Promise.resolve({
              tracks: [{ id: 201, name: '雨天', artists: 'A', album: 'X', durationMs: 200_000 }],
              total: 1,
            });
          }
          return new Promise((_, reject) => {
            const fail = () => reject(Object.assign(new Error('已中止'), { name: 'AbortError' }));
            if (signal?.aborted) { fail(); return; }
            signal?.addEventListener('abort', fail);
          });
        }),
      },
    };
    const { agent, store } = setup({
      providers,
      searchBudgetMs: 40,
      responses: [decide({
        queries: [
          { tool: 'searchTracks', keyword: '快查询', limit: 10 },
          { tool: 'searchTracks', keyword: '慢查询', limit: 10 },
        ],
        targetCount: 2,
      })],
    });

    await agent.start({ userNeed: '来点雨天的歌' });

    const session = await store.getCurrent();
    const card = session.messages.find(message => message.kind === 'plan-card');
    expect(card.picks.map(pick => pick.id)).toEqual([201]);
    // 半份结果要标明是超时降级来的，用户才知道为什么没精排。
    expect(card.stats.timedOut).toBe(true);
    expect(card.stats.rerankSkipped).toBe(true);
  });

  it('决策阶段就吃光预算时，提示指向模型而不是检索', async () => {
    let clock = NOW;
    const now = () => clock;
    const abortErr = () => Object.assign(new Error('已中止'), { name: 'AbortError' });
    const llm = {
      stream: vi.fn((messages, { signal } = {}) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return Promise.resolve(JSON.stringify({ query: '', specific: false }));
        if (system === DECIDE_SYSTEM) {
          // 决策一直不返回，并且在等待期间把预算吃光。
          clock += 80;
          return new Promise((_, reject) => {
            if (signal?.aborted) { reject(abortErr()); return; }
            signal?.addEventListener('abort', () => reject(abortErr()));
          });
        }
        throw new Error('unexpected llm call');
      }),
    };
    const { agent, store } = setup({ llm, now, searchBudgetMs: 50 });

    await agent.start({ userNeed: '深夜写代码的歌' });

    const session = await store.getCurrent();
    const error = session.messages.find(message => message.kind === 'error');
    expect(error.text).toContain('决策阶段');
    // 模型什么都没吐出来时，思考记录也不能是空的（否则卡片没法点开）。
    expect(error.thinking.text).toContain('模型没有输出可展示的分析');
  });

  it('中断会取消进行中的平台检索，且不写结果/错误卡片', async () => {
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const abortErr = () => Object.assign(new Error('已中止'), { name: 'AbortError' });

    const providers = {
      primary: {
        label: '测试平台',
        capabilities: { search: ['tracks'] },
        searchTracks: vi.fn(({ signal } = {}) => {
          markStarted();
          return new Promise((_, reject) => {
            if (signal?.aborted) { reject(abortErr()); return; }
            signal?.addEventListener('abort', () => reject(abortErr()));
          });
        }),
      },
    };
    const { agent, store, notify } = setup({
      providers,
      responses: [
        decide({ queries: [{ tool: 'searchTracks', keyword: '慢查询' }], targetCount: 3 }),
      ],
    });

    const running = agent.start({ userNeed: '慢查询' });
    await started;
    expect(agent.abort()).toBe(true);
    await running;

    const session = await store.getCurrent();
    expect(session.messages.map(message => message.kind)).toEqual(['text', 'ack']);
    expect(notify.mock.calls.some(([type]) => type === 'CHAT_THINKING_END')).toBe(false);
  });

  it('排除会话购物车里已有的歌', async () => {
    const providers = defaultProviders();
    const { agent, store, sessions } = setup({
      providers,
      responses: [
        decide({ queries: [{ tool: 'searchSongs', keyword: '雨天' }], targetCount: 1 }),
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

  it('决策里没有 queries 时退回关键词兜底（不拿整句去搜）', async () => {
    const providers = defaultProviders();
    const { agent, store } = setup({
      providers,
      responses: [decide(), JSON.stringify({ picks: [{ id: '101', reason: 'ok' }] })],
    });

    await agent.start({ userNeed: '来点雨天的歌' });

    const session = await store.getCurrent();
    const card = session.messages.find(m => m.kind === 'plan-card');
    expect(card.plan.queries[0]).toMatchObject({ tool: 'searchTracks', keyword: '雨天' });
    expect(card.plan.fallback).toBe(true);
  });

  it('多个检索动作并发执行，而不是一条条排队', async () => {
    const started = [];
    const gates = [];
    const providers = {
      primary: {
        label: '测试平台',
        capabilities: { search: ['tracks'] },
        searchTracks: vi.fn(({ keyword }) => {
          started.push(keyword);
          return new Promise((resolve) => {
            gates.push(() => resolve({ tracks: [{ id: keyword, name: keyword }], total: 1 }));
          });
        }),
      },
    };
    const llm = {
      stream: vi.fn(async (messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: '', specific: false });
        if (system === DECIDE_SYSTEM) {
          return decide({
            queries: ['a', 'b', 'c'].map(keyword => ({ tool: 'searchTracks', keyword })),
          });
        }
        return JSON.stringify({ picks: [] });
      }),
    };
    const { agent } = setup({ providers, llm });

    const running = agent.start({ userNeed: '来点歌' });
    // 三条检索必须同时挂起：只要还是串行，这里最多只会看到 1 条。
    await vi.waitFor(() => expect(started).toHaveLength(3));
    gates.forEach(resolve => resolve());
    await running;
  });

  it('剩余预算不够精排时直接给候选，不硬跑精排', async () => {
    let clock = NOW;
    const llm = {
      stream: vi.fn(async (messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: '', specific: false });
        if (system === DECIDE_SYSTEM) {
          // 决策吃掉 25s，整轮只剩 5s：不够一次精排。
          clock += 25_000;
          return decide({ queries: [{ tool: 'searchTracks', keyword: '雨天' }] });
        }
        throw new Error('预算不足时不应再调精排');
      }),
    };
    const { agent, store } = setup({
      providers: defaultProviders(),
      llm,
      now: () => clock,
      searchBudgetMs: 30_000,
    });

    await agent.start({ userNeed: '来点歌' });

    const card = (await store.getCurrent()).messages.find(m => m.kind === 'plan-card');
    expect(card.stats.rerankSkipped).toBe(true);
    expect(card.picks.length).toBeGreaterThan(0);
  });

  it('决策花掉 25s 后，剩下的预算真的交给精排', async () => {
    let clock = NOW;
    const llm = {
      stream: vi.fn(async (messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: '', specific: false });
        if (system === DECIDE_SYSTEM) {
          clock += 25_000;
          return decide({ queries: [{ tool: 'searchTracks', keyword: '雨天' }], targetCount: 2 });
        }
        if (system === RERANK_SYSTEM) {
          clock += 10_000;
          return JSON.stringify({ picks: [{ id: '101', reason: '雨天合适' }] });
        }
        throw new Error('unexpected llm call');
      }),
    };
    const { agent, store } = setup({
      providers: defaultProviders(),
      llm,
      now: () => clock,
    });

    await agent.start({ userNeed: '来点雨天的歌' });

    const card = (await store.getCurrent()).messages.find(m => m.kind === 'plan-card');
    expect(card.stats.rerankSkipped).toBeFalsy();
    expect(card.picks.map(pick => pick.id)).toEqual([101]);
    // 25s 决策 + 10s 精排仍在默认 60s 预算内。
    expect(clock).toBe(NOW + 35_000);
  });

  it('「再找一些」承接上一轮结果，只补进不在歌单里的新歌', async () => {
    const providers = {
      primary: {
        label: '测试平台',
        capabilities: { search: ['tracks'] },
        searchTracks: vi.fn(async () => ({
          tracks: [
            { id: 201, name: '新歌A', artists: 'X', album: 'Y' },
            { id: 202, name: '新歌B', artists: 'X', album: 'Y' },
          ],
          total: 2,
        })),
      },
    };
    const llm = {
      stream: vi.fn(async (messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: '', specific: false });
        if (system === DECIDE_SYSTEM) {
          return decide({
            carryOver: true,
            queries: [{ tool: 'searchTracks', keyword: '新方向' }],
            targetCount: 10,
          });
        }
        return JSON.stringify({ picks: [{ id: '201', reason: 'ok' }, { id: '202', reason: 'ok' }] });
      }),
    };
    const { agent, store, sessions } = setup({ providers, llm });
    const session = await store.create('测试');
    await store.appendMessage(session.id, {
      id: 'old-user',
      role: 'user',
      kind: 'text',
      at: NOW,
      text: '我想听高达SEED的op',
    });
    // 上一轮给过 3 首，其中 101 已经被加进歌单。
    await store.appendMessage(session.id, {
      id: 'old-card',
      role: 'agent',
      at: NOW,
      kind: 'plan-card',
      picks: [
        { id: 101, name: '旧1', artists: 'X', album: 'Y' },
        { id: 102, name: '旧2', artists: 'X', album: 'Y' },
        { id: 103, name: '旧3', artists: 'X', album: 'Y' },
      ],
      stats: {},
      plan: { queries: [] },
    });
    await sessions.cart.add(session.id, [{ id: 101, provider: 'netease' }]);

    await agent.start({ userNeed: '再检索一下，不止这几首', sessionId: session.id });

    const fresh = await store.get(session.id);
    const card = fresh.messages.filter(m => m.kind === 'plan-card').pop();
    // 旧歌里已经在歌单的 101 不再出现，102/103 保留，后面接本轮新增。
    expect(card.picks.map(pick => pick.id)).toEqual([102, 103, 201, 202]);
    expect(card.stats).toMatchObject({ carried: 2, added: 2 });

    // 决策调用必须带上上一轮上下文，否则「不止这几首」根本无从理解。
    const decideCall = llm.stream.mock.calls.find(([messages]) => messages[0]?.content === DECIDE_SYSTEM);
    const decidePrompt = decideCall[0][1].content;
    expect(decidePrompt).toContain('上一轮用户需求：我想听高达SEED的op');
    expect(decidePrompt).toContain('上一轮结果：旧1、旧2、旧3 等 3 首');
  });

  it('追加检索没有新歌时给提示，不重复渲染整张卡片', async () => {
    const providers = {
      primary: {
        label: '测试平台',
        capabilities: { search: ['tracks'] },
        searchTracks: vi.fn(async () => ({
          tracks: [
            { id: 102, name: '旧2', artists: 'X', album: 'Y' },
            { id: 103, name: '旧3', artists: 'X', album: 'Y' },
          ],
          total: 2,
        })),
      },
    };
    const llm = {
      stream: vi.fn(async (messages) => {
        const system = messages[0]?.content || '';
        if (system === EXTRACT_SYSTEM) return JSON.stringify({ query: '', specific: false });
        if (system === DECIDE_SYSTEM) {
          return decide({ carryOver: true, queries: [{ tool: 'searchTracks', keyword: '同款' }] });
        }
        throw new Error('候选都被排除后不应再精排');
      }),
    };
    const { agent, store } = setup({ providers, llm });
    const session = await store.create('测试');
    await store.appendMessage(session.id, {
      id: 'old-card',
      role: 'agent',
      at: NOW,
      kind: 'plan-card',
      picks: [
        { id: 102, name: '旧2', artists: 'X', album: 'Y' },
        { id: 103, name: '旧3', artists: 'X', album: 'Y' },
      ],
      stats: {},
      plan: { queries: [] },
    });

    await agent.start({ userNeed: '再来点', sessionId: session.id });

    const fresh = await store.get(session.id);
    expect(fresh.messages.filter(m => m.kind === 'plan-card')).toHaveLength(1);
    const tip = fresh.messages[fresh.messages.length - 1];
    expect(tip.kind).toBe('text');
    expect(tip.text).toContain('没有找到新的歌');
  });

  it('没有检索结果时提示已包含候选', async () => {
    const providers = defaultProviders();
    providers.primary.searchTracks.mockResolvedValueOnce({ tracks: [], total: 0 });
    const { agent, store } = setup({
      providers,
      responses: [
        decide({ queries: [{ tool: 'searchTracks', keyword: 'x' }], targetCount: 1 }),
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
