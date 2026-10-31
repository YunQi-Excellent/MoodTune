import { defaultEq } from '../core/eq.js';
import { createId } from '../core/ids.js';
import { extractJson } from '../core/json.js';
import { trackKey } from '../core/track.js';
import { tuneEq } from './eq-tuner.js';
import {
  coarseFilter,
  dedupByWeight,
  executeQuery,
  normalizePlan,
  selectPicks,
} from './recommendation.js';
import { PLANNER_SYSTEM, RERANK_SYSTEM, ROUTER_SYSTEM } from './prompts.js';

const HELP_TEXT = '可以跟我说：想听什么场景的歌（"深夜写代码"）、想调整听感（"低频轻一点"）、或者"把当前列表保存成 XX"。';

const FALLBACK_ROUTE = Object.freeze({
  mode: 'search',
  reply: '收到，正在找歌…',
  payload: {},
});

/**
 * 对话编排：路由 → 检索/EQ/保存 → 写回会话。
 *
 * 这里只做流程，不碰 chrome API：
 * - `llm` 负责模型调用
 * - `providers` 提供平台
 * - `sessions` / `playlists` / `eqPresets` / `player` 是服务层
 * - `notify` 把 CHAT_* 事件推给侧边栏
 *
 * @param {object} options
 * @param {{ stream: Function }} options.llm
 * @param {{ primary: object }} options.providers
 * @param {object} options.sessions 会话服务
 * @param {object} options.playlists 歌单服务
 * @param {object} options.eqPresets 预设服务
 * @param {object} options.player 播放器服务
 * @param {(type: string, payload: object) => void} [options.notify]
 * @param {() => number} [options.now]
 * @param {(prefix: string) => string} [options.newId]
 * @param {Console} [options.log]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export function createChatAgent({
  llm,
  providers,
  sessions,
  playlists,
  eqPresets,
  player,
  notify = () => {},
  now = () => Date.now(),
  newId = prefix => createId(prefix),
  log = console,
  sleep,
} = {}) {
  if (!llm) throw new Error('createChatAgent 需要 llm');
  if (!providers) throw new Error('createChatAgent 需要 providers');
  if (!sessions) throw new Error('createChatAgent 需要 sessions');
  if (!playlists) throw new Error('createChatAgent 需要 playlists');
  if (!eqPresets) throw new Error('createChatAgent 需要 eqPresets');
  if (!player) throw new Error('createChatAgent 需要 player');

  let currentAbort = null;

  const requireProvider = () => {
    const provider = providers.primary;
    if (!provider) throw new Error('未注册音乐平台');
    return provider;
  };

  /** 把流式增量按 60ms 合批推给侧边栏，避免每个 token 一次 postMessage。 */
  const streamPusher = (sessionId) => {
    let buffer = '';
    let timer = null;

    const flush = () => {
      if (!buffer) return;
      const text = buffer;
      buffer = '';
      notify('CHAT_STREAM_CHUNK', { sessionId, delta: text });
    };

    return {
      push(chunk) {
        buffer += chunk;
        if (timer) return;
        timer = setTimeout(() => { timer = null; flush(); }, 60);
      },
      flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        flush();
      },
    };
  };

  async function route(userNeed, signal) {
    const raw = await llm.stream(
      [{ role: 'system', content: ROUTER_SYSTEM }, { role: 'user', content: userNeed }],
      { signal },
    );
    const parsed = extractJson(raw);
    if (!parsed || !parsed.mode) return { ...FALLBACK_ROUTE };
    return parsed;
  }

  async function search(userNeed, signal, sessionId, excludeIds, onProgress) {
    const pusher = streamPusher(sessionId);

    try {
      const provider = requireProvider();
      const providerContext = `当前平台：${provider.label}；可用检索能力：${provider.capabilities.search.join(' / ')}。`;

      onProgress?.('plan', '正在规划检索方案…');
      const planRaw = await llm.stream(
        [
          { role: 'system', content: PLANNER_SYSTEM },
          { role: 'user', content: `${providerContext}\n用户需求：${userNeed}\n\n请先分析，然后输出检索计划。` },
        ],
        { onChunk: chunk => pusher.push(chunk), signal },
      );
      pusher.flush();

      const plan = normalizePlan(extractJson(planRaw));

      notify('CHAT_THINKING_END', { sessionId });

      onProgress?.('execute', `执行 ${plan.queries.length} 个检索动作…`);
      const raw = [];
      for (const query of plan.queries) {
        if (signal.aborted) throw new Error('已中止');
        try {
          raw.push(...await executeQuery(query, provider, { sleep }));
        } catch (e) {
          log.warn('[chat] 检索失败：', e?.message);
        }
      }

      let deduped = dedupByWeight(raw);

      if (Array.isArray(excludeIds) && excludeIds.length > 0) {
        const excludeSet = new Set(excludeIds.map(id => String(id)));
        deduped = deduped.filter(song => (
          !excludeSet.has(String(song.id))
          && !excludeSet.has(trackKey(song))
        ));
      }

      if (deduped.length === 0) throw new Error('没有检索到任何新歌曲（会话歌单已包含候选）');

      const filtered = coarseFilter(deduped, plan.filters || {}, plan.targetCount);

      notify('CHAT_THINKING_START', { sessionId, stage: 'rerank' });

      const rerankPusher = streamPusher(sessionId);
      const forLLM = filtered.map(song => ({
        id: song.id,
        name: song.name,
        artists: song.artists,
        album: song.album,
        durationMs: song.durationMs,
      }));

      const rerankRaw = await llm.stream(
        [
          { role: 'system', content: RERANK_SYSTEM },
          { role: 'user', content: `用户需求：${userNeed}\n\n候选（${forLLM.length} 首）：\n${JSON.stringify(forLLM)}\n\n输出 picks。` },
        ],
        { onChunk: chunk => rerankPusher.push(chunk), signal },
      );
      rerankPusher.flush();

      const picks = selectPicks(extractJson(rerankRaw)?.picks, filtered, plan.targetCount);

      return {
        ok: true,
        plan,
        picks,
        stats: { raw: raw.length, total: deduped.length, filtered: filtered.length },
      };
    } catch (e) {
      pusher.flush();
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function tuneAndApply(userNeed, signal, sessionId, currentEq) {
    const pusher = streamPusher(sessionId);

    try {
      const { eq, reason } = await tuneEq({
        llm,
        userNeed,
        currentEq,
        onChunk: chunk => pusher.push(chunk),
        signal,
      });
      pusher.flush();

      const applied = await player.setEq(eq);
      if (!applied?.ok) throw new Error(applied?.error || '应用 EQ 失败');

      return { ok: true, eq: applied.eq || eq, reason };
    } catch (e) {
      pusher.flush();
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function run({ userNeed, sessionId, userMessageId }, signal) {
    let session = null;
    if (sessionId) {
      const list = await sessions.list();
      session = list.find(item => item.id === sessionId) || null;
    }
    if (!session) session = await sessions.current();
    if (!session) session = await sessions.create(userNeed.slice(0, 20) || '新会话');

    const nextMessageId = () => newId('msg');
    const append = message => sessions.appendMessage(session.id, {
      id: nextMessageId(),
      at: now(),
      ...message,
    });

    try {
      await sessions.appendMessage(session.id, {
        id: userMessageId || nextMessageId(),
        role: 'user',
        kind: 'text',
        text: userNeed,
        at: now(),
      });

      notify('CHAT_THINKING_START', { sessionId: session.id, stage: 'route' });

      let routing;
      try {
        routing = await route(userNeed, signal);
      } catch {
        routing = { ...FALLBACK_ROUTE };
      }
      if (signal.aborted) return;

      const mode = routing.mode || 'search';
      const routePayload = routing.payload || {};

      await append({ role: 'agent', kind: 'ack', text: routing.reply || '收到', mode });

      if (mode === 'eq') {
        const eqPrompt = routePayload.eqPrompt || userNeed;
        const fresh = (await sessions.get(session.id)) || session;
        const currentEq = fresh.cartEq || fresh.result?.eq || null;
        const result = await tuneAndApply(eqPrompt, signal, session.id, currentEq);

        notify('CHAT_THINKING_END', { sessionId: session.id });

        if (result.ok) {
          await sessions.update(session.id, { cartEq: result.eq });
          await append({ role: 'agent', kind: 'eq-card', eq: result.eq, reason: result.reason });
        } else {
          await append({ role: 'agent', kind: 'error', text: result.error });
        }
        return;
      }

      if (mode === 'open-eq-panel') {
        notify('CHAT_THINKING_END', { sessionId: session.id });
        const fresh = (await sessions.get(session.id)) || session;
        const currentEq = fresh.cartEq || fresh.result?.eq || defaultEq();
        await append({ role: 'agent', kind: 'eq-card', eq: currentEq, reason: null });
        return;
      }

      if (mode === 'save-eq') {
        const name = routePayload.name
          || `调音-${new Date(now()).toLocaleDateString('zh-CN')}`;
        try {
          const fresh = await sessions.get(session.id);
          const eqToSave = fresh?.cartEq || fresh?.result?.eq;
          if (!eqToSave) throw new Error('当前会话还没有调音');

          const saved = await eqPresets.save({ name, eq: eqToSave, source: 'manual' });
          await append({ role: 'agent', kind: 'save-card', cardType: 'eq', name: saved.name });
        } catch (e) {
          await append({ role: 'agent', kind: 'error', text: '保存调音失败：' + (e?.message || e) });
        }
        return;
      }

      if (mode === 'save-list') {
        const name = routePayload.name
          || `列表-${new Date(now()).toLocaleDateString('zh-CN')}`;
        try {
          const fresh = await sessions.get(session.id);
          const songsToSave = (fresh?.cart && fresh.cart.length > 0)
            ? fresh.cart
            : (fresh?.result?.playlist || []);
          if (!songsToSave.length) throw new Error('会话歌单和结算歌单都是空的');

          const saved = await playlists.save({ name, songs: songsToSave, source: 'manual' });
          await append({
            role: 'agent',
            kind: 'save-card',
            cardType: 'playlist',
            name: saved.name,
            count: saved.songs.length,
          });
        } catch (e) {
          await append({ role: 'agent', kind: 'error', text: '保存列表失败：' + (e?.message || e) });
        }
        return;
      }

      if (mode === 'chat') {
        notify('CHAT_THINKING_END', { sessionId: session.id });
        await append({ role: 'agent', kind: 'text', text: HELP_TEXT });
        return;
      }

      const freshSession = (await sessions.get(session.id)) || session;
      const excludeIds = (freshSession.cart || [])
        .flatMap(song => [song.id, trackKey(song)])
        .filter(id => id !== undefined && id !== null && id !== '');

      const searchResult = await search(
        userNeed,
        signal,
        session.id,
        excludeIds,
        (stage, detail) => notify('CHAT_PROGRESS', { sessionId: session.id, stage, detail }),
      );

      if (signal.aborted) return;
      notify('CHAT_THINKING_END', { sessionId: session.id });

      if (searchResult.ok) {
        await append({
          role: 'agent',
          kind: 'plan-card',
          picks: searchResult.picks,
          plan: searchResult.plan,
          stats: searchResult.stats,
        });
      } else {
        await append({ role: 'agent', kind: 'error', text: searchResult.error });
      }
    } catch (error) {
      if (signal.aborted) return;
      log.error('[chatStart] 失败：', error);
      try {
        await append({ role: 'agent', kind: 'error', text: error?.message || String(error) });
      } catch {}
    }
  }

  function abort() {
    if (!currentAbort) return false;
    try { currentAbort.abort(); } catch {}
    return true;
  }

  return {
    get running() {
      return Boolean(currentAbort);
    },

    /**
     * 开始一轮对话：中止上一轮，然后异步跑完整流程。
     * 返回的 Promise 不会 reject —— 失败会写进会话或日志。
     */
    async start(payload = {}) {
      abort();
      const controller = new AbortController();
      currentAbort = controller;

      try {
        await run(payload, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) log.warn('[chat] 流程失败：', error);
      } finally {
        if (currentAbort === controller) currentAbort = null;
      }
    },

    abort,
  };
}
