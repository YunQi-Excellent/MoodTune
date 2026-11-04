import { combineSignals, createTimeoutSignal, isAbortError, throwIfAborted } from '../core/abort.js';
import { INTENT_CONFIG } from '../core/constants.js';
import { defaultEq } from '../core/eq.js';
import { createId } from '../core/ids.js';
import { extractJson } from '../core/json.js';
import { trackKey } from '../core/track.js';
import { tuneEq } from './eq-tuner.js';
import { coreQuery, fallbackKeyword, isLiteralHit, normalizeForMatch } from './literal.js';
import {
  coarseFilter,
  dedupByWeight,
  executeQuery,
  normalizePlan,
  selectPicks,
} from './recommendation.js';
import { EXTRACT_SYSTEM, DECIDE_SYSTEM, RERANK_SYSTEM } from './prompts.js';

const HELP_TEXT = '可以跟我说：想听什么场景的歌（"深夜写代码"）、想调整听感（"低频轻一点"）、或者"把当前列表保存成 XX"。';

// 抽取只输出一行 JSON，给足 6 秒仍未返回就放弃快速通道，回退到原流程。
const EXTRACT_TIMEOUT_MS = 6000;
const LITERAL_TIMEOUT_MS = 6000;
// 「意图 + 检索规划」合并成一次调用后，单次封顶 15 秒：
// 模型再慢也不能把整轮预算吃掉，超时就按「找歌 + 原话直搜」兜底。
const DECIDE_TIMEOUT_MS = 15000;
// 检索动作并发数：太高会触发平台风控，太低等于串行。
const EXECUTE_CONCURRENCY = 3;
// 留给精排的时间：剩余预算低于这个值就跳过精排，直接用已召回候选出结果。
const RERANK_RESERVE_MS = 6000;
// 思考记录会跟着消息一起持久化，截断避免会话文件无限膨胀。
const THINKING_MAX_LEN = 4000;

const STAGE_LABELS = Object.freeze({
  decide: '决策',
  execute: '检索',
  rerank: '精排',
});

const FALLBACK_DECISION = Object.freeze({
  mode: 'search',
  reply: '收到，正在找歌…',
  payload: {},
});

/** 把毫秒说成人话：小于 10 秒保留一位小数，避免显示成「0 秒」。 */
export function formatSeconds(ms) {
  const value = Math.max(0, Number(ms) || 0);
  return value < 10000 ? (value / 1000).toFixed(1) : String(Math.round(value / 1000));
}

/** 超长思考只留头尾：中间通常是反复的推理，结尾的计划才是关键。 */
export function clipThinking(text) {
  const value = String(text ?? '');
  if (value.length <= THINKING_MAX_LEN) return value;
  const head = 1200;
  const tail = THINKING_MAX_LEN - head - 20;
  return `${value.slice(0, head)}\n…（已截断）…\n${value.slice(-tail)}`;
}

/**
 * 对话编排：决策（意图 + 检索计划）→ 检索/EQ/保存 → 写回会话。
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
  searchBudgetMs = INTENT_CONFIG.searchBudgetMs,
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

  /**
   * 一次模型调用同时决定「意图」和「检索动作」，替代原来的 route + plan 两次往返。
   * 只有 mode=search 时才需要 queries；解析失败/超时由调用方退回兜底决策。
   */
  async function decide(userNeed, signal, providerContext, onChunk, deadline, followUp = '') {
    // 决策最多吃掉本轮剩余预算，并且自己再封顶 15 秒：
    // 模型慢的时候宁可退回「原话直搜」，也不能让整轮对话卡在这一步。
    const remaining = deadline ? deadline - now() : DECIDE_TIMEOUT_MS;
    const timeout = createTimeoutSignal(signal, Math.max(1, Math.min(DECIDE_TIMEOUT_MS, remaining)));
    let emitted = '';
    const sink = (chunk) => {
      emitted += chunk;
      onChunk?.(chunk);
    };
    let raw;
    try {
      raw = await llm.stream(
        [
          { role: 'system', content: DECIDE_SYSTEM },
          {
            role: 'user',
            content: [
              providerContext,
              followUp ? `【上一轮】\n${followUp}` : '',
              `用户需求：${userNeed}`,
            ].filter(Boolean).join('\n'),
          },
        ],
        { signal: timeout.signal, onChunk: sink, onReasoning: sink },
      );
    } finally {
      timeout.cancel();
    }
    // 兼容不回调 onChunk 的 llm 实现：至少把返回文本记进思考记录。
    if (!emitted && raw) sink(raw);
    const parsed = extractJson(raw);
    if (!parsed || !parsed.mode) return null;
    return parsed;
  }

  /**
   * 用最轻的一次模型调用，从自由输入里抽出「用户到底想搜什么」。
   * 空字符串表示这不是一个点名作品的检索，交给规划器处理风格类需求。
   */
  async function extractUserQuery(userNeed, signal) {
    const timeout = createTimeoutSignal(signal, EXTRACT_TIMEOUT_MS);
    let raw;
    try {
      raw = await llm.stream(
        [{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content: userNeed }],
        {
          signal: timeout.signal,
          maxTokens: 80,
          temperature: 0,
        },
      );
    } finally {
      timeout.cancel();
    }

    const data = extractJson(raw) || {};
    const query = typeof data.query === 'string' ? data.query.trim().slice(0, 80) : '';
    if (!query) return '';
    // 模型明确判成「氛围/场景」时不做直搜；缺字段则交给命中判定兜底。
    return data.specific === false ? '' : query;
  }

  /**
   * 原文直搜：把用户原话（或模型抽出的连续片段）直接交给平台搜索。
   * 这是唯一一条不经过改写、不经过规划的召回路径。
   *
   * 原话里常带「的 op / 的 ost」这类口语尾巴，平台会把「的」和「op」当独立词，
   * 返回一堆无关结果（"P4D的op" → 302 条钢琴练习曲）。所以第一枪打原话，
   * 没命中就再打一次剥掉限定词的核心词（"p4d"），两次共用一个超时预算。
   * @returns {Promise<{query: string, tracks: object[], total: number, hitId?: string}|null>}
   */
  async function searchLiteral(query, signal) {
    const provider = requireProvider();
    const timeout = createTimeoutSignal(signal, LITERAL_TIMEOUT_MS);

    const keywords = [query];
    const core = coreQuery(query);
    if (core.length >= 2 && core !== normalizeForMatch(query)) keywords.push(core);

    try {
      for (const keyword of keywords) {
        const result = await provider.searchTracks({
          keyword,
          limit: INTENT_CONFIG.literalSearchLimit,
          offset: 0,
          // 网页搜索框用的是相关性排序；这里显式清空 order，避免热门排序把精确命中挤下去。
          order: '',
          signal: timeout.signal,
        });

        const tracks = Array.isArray(result?.tracks) ? result.tracks : [];
        const hitIndex = tracks.findIndex(track => isLiteralHit(keyword, track));
        if (hitIndex < 0) continue;

        // 命中项排第一，其余保持平台顺序，直接作为快速通道结果。
        const ordered = [
          tracks[hitIndex],
          ...tracks.filter((_, index) => index !== hitIndex),
        ];
        return {
          query: keyword,
          tracks: ordered,
          total: result.total || tracks.length,
          hitId: tracks[hitIndex].id,
        };
      }
      return null;
    } finally {
      timeout.cancel();
    }
  }

  /**
   * 会话里最后一张结果卡的候选。
   * 「再找一些/不止这几首」这类追加请求要在它的基础上继续，而不是从零开始。
   */
  function lastPlanPicks(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const message = list[i];
      if (message?.kind === 'plan-card' && Array.isArray(message.picks) && message.picks.length > 0) {
        return message.picks;
      }
    }
    return [];
  }

  /**
   * 拼一段「上一轮」上下文给决策模型。
   *
   * 决策调用本身不带对话历史，而「再检索一下，不止这几首」这种话脱离了上一轮
   * 就完全没法理解：模型不知道用户原来要什么，也不知道哪些词已经搜过。
   */
  function buildFollowUpContext(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let cardIndex = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.kind === 'plan-card') { cardIndex = i; break; }
    }
    if (cardIndex < 0) return '';

    let previousNeed = '';
    for (let i = cardIndex - 1; i >= 0; i -= 1) {
      if (list[i]?.role === 'user' && list[i]?.text) { previousNeed = list[i].text; break; }
    }

    const card = list[cardIndex];
    const queries = (card.plan?.queries || [])
      .map(query => query.keyword || query.playlistName || query.artistName)
      .filter(Boolean)
      .slice(0, 4);
    const names = (card.picks || []).slice(0, 3).map(pick => pick.name).filter(Boolean);

    return [
      previousNeed ? `上一轮用户需求：${previousNeed}` : '',
      queries.length ? `上一轮用过的检索词：${queries.join(' / ')}` : '',
      names.length ? `上一轮结果：${names.join('、')} 等 ${(card.picks || []).length} 首` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * 直搜结果是不是上一轮已经给过的那一批？是的话说明用户在要求「再找一些」，
   * 这时直搜没有增量，应该改走决策 + 追加检索。
   */
  function repeatsPrevious(direct, previousPicks) {
    const prevIds = new Set((previousPicks || []).map(pick => String(pick.id)));
    if (prevIds.size === 0) return false;
    const tracks = (direct?.tracks || []).slice(0, INTENT_CONFIG.literalSearchLimit);
    return tracks.length > 0 && tracks.every(track => prevIds.has(String(track.id)));
  }

  /** 合并「上一轮保留」+「本轮新增」：按 id 去重，保留原顺序，截断到上限。 */
  function mergePicks(carried, added, limit) {
    const seen = new Set();
    const merged = [];
    for (const pick of [...(carried || []), ...(added || [])]) {
      const key = String(pick?.id ?? '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(pick);
      if (merged.length >= limit) break;
    }
    return merged;
  }

  /** 从直搜结果里去掉会话歌单已有的歌，并把命中项标出来。 */
  function pickLiteralTracks(tracks, excludeIds, limit, hitId) {
    const excludeSet = new Set((excludeIds || []).map(id => String(id)));
    return tracks
      .filter(song => (
        !excludeSet.has(String(song.id))
        && !excludeSet.has(trackKey(song))
      ))
      .slice(0, limit)
      .map(song => ({
        ...song,
        reason: hitId !== undefined && String(song.id) === String(hitId)
          ? '原文直搜命中'
          : '',
      }));
  }

  /**
   * 把「意图 + 规划」的决策整理成可执行的检索计划。
   * 模型没给 queries / 给了坏 JSON 时，退回「用抽取出来的关键词搜」。
   *
   * 注意这里绝对不能退回「用用户原话搜一次」：平台会把 "我想听高达SEED中的op"
   * 切成「我想」，返回一屏《我想牵着你的手》这种结果，看起来像正常结果，
   * 其实是垃圾。宁可搜得宽一点，也不能让兜底方案本身跑偏。
   */
  function buildPlan(decision, userNeed, extracted = '') {
    const source = decision && decision.mode === 'search' ? decision : {};
    try {
      return normalizePlan({
        queries: source.queries,
        filters: source.filters,
        targetCount: source.targetCount,
        reasoning: source.reasoning,
      });
    } catch {
      return {
        ...normalizePlan({
          queries: fallbackKeywords(userNeed, extracted).map(keyword => ({
            tool: 'searchTracks',
            keyword,
            limit: 20,
          })),
          targetCount: 10,
          reasoning: '模型没有给出检索计划，退回关键词检索',
        }),
        fallback: true,
      };
    }
  }

  /** 兜底检索词：优先用模型抽出来的词，再补上削掉口语前缀的原话。 */
  function fallbackKeywords(userNeed, extracted = '') {
    const keywords = [];
    const push = (value) => {
      const text = String(value || '').trim();
      if (text.length < 2) return;
      if (keywords.some(item => normalizeForMatch(item) === normalizeForMatch(text))) return;
      keywords.push(text);
    };

    push(extracted);
    const cleaned = fallbackKeyword(userNeed);
    push(cleaned);
    push(coreQuery(cleaned));
    if (keywords.length === 0) push('音乐');
    return keywords.slice(0, 3);
  }

  /**
   * 并发执行检索动作（最多 EXECUTE_CONCURRENCY 路）。
   * 任何一路失败都只丢这一路的结果，不影响其它路；用户中断则整体上抛。
   */
  async function runQueries(queries, provider, signal) {
    const collected = [];
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= queries.length) return;
        throwIfAborted(signal);
        try {
          collected.push(...await executeQuery(queries[index], provider, { sleep, signal }));
        } catch (e) {
          if (isAbortError(e)) throw e;
          log.warn('[chat] 检索失败：', e?.message);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(EXECUTE_CONCURRENCY, queries.length) }, worker),
    );
    return collected;
  }

  /**
   * 执行 → 精排（慢路径）。
   *
   * 规划已经在上一步和意图判定合并完成，这里只剩「跑检索 + 精排」。
   * `deadline` 是本轮对话的绝对截止时间，前面的决策/抽取花掉的时间都要算进去。
   */
  async function search(userNeed, signal, sessionId, excludeIds, {
    onProgress,
    deadline,
    plan,
    priorThinking = '',
    decideMs = 0,
    carryPicks = [],
  } = {}) {
    const pusher = streamPusher(sessionId);
    const budget = new AbortController();
    const scopedSignal = combineSignals(signal, budget.signal);
    const startedAt = now();
    const budgetMs = Math.max(
      1,
      Math.min(searchBudgetMs, deadline ? deadline - startedAt : searchBudgetMs),
    );
    let thinkingText = String(priorThinking || '');
    let timedOut = false;
    // 当前正在跑的阶段：超时/失败时用它判断到底卡在哪一步。
    let currentStage = 'execute';
    // 各阶段耗时：既是给用户的解释（为什么慢），也是排查检索质量的第一手数据。
    const timings = { decide: Math.max(0, Math.round(decideMs)), execute: 0, rerank: 0 };
    let stageStartedAt = startedAt;
    const endStage = (name) => {
      timings[name] = Math.round(now() - stageStartedAt);
      stageStartedAt = now();
    };
    const budgetSeconds = () => formatSeconds(budgetMs);
    const timingsText = () => Object.entries(timings)
      .filter(([, ms]) => ms > 0)
      .map(([name, ms]) => `${STAGE_LABELS[name] || name} ${ms < 100 ? '<0.1' : (ms / 1000).toFixed(1)}s`)
      .join(' · ');

    const timer = setTimeout(() => {
      timedOut = true;
      budget.abort();
    }, budgetMs);

    const collectThinking = (chunk) => {
      thinkingText += chunk;
      pusher.push(chunk);
    };
    const snapshotThinking = () => {
      const meta = timingsText();
      const body = thinkingText.trim();
      // 思考记录永远不留空：模型如果只回了 JSON（或推理流没吐出来），
      // 至少让用户看到「哪个阶段花了多久」，而不是一条无法点击的空卡片。
      const text = [
        meta ? `阶段耗时：${meta}` : '',
        body || '（模型没有输出可展示的分析）',
      ].filter(Boolean).join('\n\n');
      return {
        text: clipThinking(text),
        // 决策 + 检索 + 精排的总耗时：决策发生在 search() 之前，不能漏算。
        elapsedMs: Math.max(0, Math.round(decideMs) + (now() - startedAt)),
        timings: { ...timings },
        timingsText: meta,
      };
    };
    const stageDivider = (label) => {
      if (!thinkingText.trim()) return;
      const text = `\n\n—— ${label} ——\n\n`;
      thinkingText += text;
      pusher.push(text);
    };

    try {
      const provider = requireProvider();

      // 兜底计划要说明白：用户看到的结果为什么只是「平台相关性顺序」，
      // 而不是模型规划过的。这条也解释了「为什么这轮不够准」。
      if (plan.fallback) {
        const keywords = (plan.queries || []).map(query => query?.keyword).filter(Boolean);
        const note = `（决策阶段没有给出可用的检索计划，已退回关键词检索：${keywords.join(' / ')}。`
          + '结果按平台相关性排序，可能不如正常规划精准。）';
        thinkingText += `${thinkingText.trim() ? '\n\n' : ''}${note}\n\n`;
        pusher.push(note + '\n\n');
      }

      onProgress?.('execute', `执行 ${plan.queries.length} 个检索动作…`);
      notify('CHAT_THINKING_START', { sessionId, stage: 'execute' });
      currentStage = 'execute';
      stageStartedAt = now();
      const raw = await runQueries(plan.queries, provider, scopedSignal);

      let deduped = dedupByWeight(raw);
      endStage('execute');

      if (Array.isArray(excludeIds) && excludeIds.length > 0) {
        const excludeSet = new Set(excludeIds.map(id => String(id)));
        deduped = deduped.filter(song => (
          !excludeSet.has(String(song.id))
          && !excludeSet.has(trackKey(song))
        ));
      }

      const carried = Array.isArray(carryPicks) ? carryPicks : [];
      const carriedIds = new Set(carried.map(pick => String(pick.id)));

      if (deduped.length === 0 && carried.length > 0) {
        // 没有新的可补，但上一轮的结果还在：原样交回去，让上层给出提示而不是错误卡片。
        return {
          ok: true,
          plan,
          picks: carried,
          stats: {
            raw: raw.length,
            total: 0,
            filtered: 0,
            carried: carried.length,
            added: 0,
            fallback: Boolean(plan.fallback),
            rerankSkipped: true,
            timedOut,
          },
          thinking: snapshotThinking(),
        };
      }

      if (deduped.length === 0) {
        if (timedOut) {
          throw new Error(`检索超时（${budgetSeconds()} 秒），已停止。可以换个更具体的说法，或再试一次。`);
        }
        throw new Error('没有检索到任何新歌曲（会话歌单已包含候选）');
      }

      const filtered = coarseFilter(deduped, plan.filters || {}, plan.targetCount);
      // 追加检索：总量 = 上一轮保留 + 本轮目标（封顶 maxTargetCount），本轮只补差额。
      const totalTarget = Math.min(
        INTENT_CONFIG.maxTargetCount,
        carried.length + plan.targetCount,
      );
      const newQuota = Math.max(1, totalTarget - carried.length);
      const fallbackPicks = () => (filtered.length > 0 ? filtered : deduped)
        .slice(0, newQuota)
        .map(song => ({ ...song, reason: '' }));
      const withCarried = picks => mergePicks(carried, picks, totalTarget);
      const statsFor = (picks, extra = {}) => ({
        raw: raw.length,
        total: deduped.length,
        filtered: filtered.length,
        carried: carried.length,
        added: picks.filter(pick => !carriedIds.has(String(pick.id))).length,
        fallback: Boolean(plan.fallback),
        ...extra,
      });

      // 预算用完、或剩余时间不够跑完精排：跳过精排直接出结果，不让用户空等。
      const remaining = deadline ? deadline - now() : Number.POSITIVE_INFINITY;
      if (timedOut || remaining < RERANK_RESERVE_MS) {
        const picks = withCarried(fallbackPicks());
        return {
          ok: true,
          plan,
          picks,
          stats: statsFor(picks, { timedOut, rerankSkipped: true }),
          thinking: snapshotThinking(),
        };
      }

      throwIfAborted(scopedSignal);
      stageDivider('精排');
      notify('CHAT_THINKING_START', { sessionId, stage: 'rerank' });
      currentStage = 'rerank';
      stageStartedAt = now();

      const forLLM = filtered.map(song => ({
        id: song.id,
        name: song.name,
        artists: song.artists,
        album: song.album,
        durationMs: song.durationMs,
      }));

      let picks;
      try {
        const beforeRerank = thinkingText.length;
        const rerankRaw = await llm.stream(
          [
            { role: 'system', content: RERANK_SYSTEM },
            { role: 'user', content: `用户需求：${userNeed}\n\n候选（${forLLM.length} 首）：\n${JSON.stringify(forLLM)}\n\n输出 picks。` },
          ],
          {
            onChunk: collectThinking,
            onReasoning: collectThinking,
            signal: scopedSignal,
          },
        );
        if (thinkingText.length === beforeRerank && rerankRaw) {
          thinkingText += rerankRaw;
          pusher.push(rerankRaw);
        }
        pusher.flush();
        endStage('rerank');
        picks = withCarried(selectPicks(extractJson(rerankRaw)?.picks, filtered, newQuota));
      } catch (e) {
        if (timedOut && !signal?.aborted) {
          endStage('rerank');
          const fallback = withCarried(fallbackPicks());
          return {
            ok: true,
            plan,
            picks: fallback,
            stats: statsFor(fallback, { timedOut: true, rerankSkipped: true }),
            thinking: snapshotThinking(),
          };
        }
        throw e;
      }

      return {
        ok: true,
        plan,
        picks,
        stats: statsFor(picks),
        thinking: snapshotThinking(),
      };
    } catch (e) {
      pusher.flush();
      // 记下「当前跑到哪个阶段才炸的」，超时报告才能指到真正慢的那一步。
      if (timings[currentStage] === 0) timings[currentStage] = Math.round(now() - stageStartedAt);
      if (timedOut && !signal?.aborted) {
        return {
          ok: false,
          error: currentStage === 'decide'
            ? `模型规划阶段用完了 ${budgetSeconds()} 秒预算，检索还没开始。可以再试一次，或换个更具体的说法。`
            : `检索超时（${budgetSeconds()} 秒），已停止。可以换个更具体的说法，或再试一次。`,
          thinking: snapshotThinking(),
        };
      }
      return { ok: false, error: e?.message || String(e), thinking: snapshotThinking() };
    } finally {
      clearTimeout(timer);
      // 排查「为什么慢」时先看这一行：哪个阶段吃掉了预算一目了然。
      log.info?.('[chat] 检索阶段耗时：', timingsText() || '（无）');
    }
  }

  async function tuneAndApply(userNeed, signal, sessionId, currentEq) {
    const pusher = streamPusher(sessionId);
    const startedAt = now();

    try {
      const { eq, reason, raw } = await tuneEq({
        llm,
        userNeed,
        currentEq,
        onChunk: chunk => pusher.push(chunk),
        signal,
      });
      pusher.flush();

      const applied = await player.setEq(eq);
      if (!applied?.ok) throw new Error(applied?.error || '应用 EQ 失败');

      return {
        ok: true,
        eq: applied.eq || eq,
        reason,
        thinking: {
          text: String(raw || '').trim().slice(0, THINKING_MAX_LEN),
          elapsedMs: Math.max(0, now() - startedAt),
        },
      };
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
    const runStartedAt = now();
    // 预算从用户按下发送就开始算：路由 + 抽取 + 规划 + 检索 + 精排共享同一份。
    const deadline = runStartedAt + searchBudgetMs;

    try {
      await sessions.appendMessage(session.id, {
        id: userMessageId || nextMessageId(),
        role: 'user',
        kind: 'text',
        text: userNeed,
        at: now(),
      });

      notify('CHAT_THINKING_START', { sessionId: session.id, stage: 'route' });

      const provider = requireProvider();
      const providerContext = `当前平台：${provider.label}；可用检索能力：${provider.capabilities.search.join(' / ')}。`;

      // 决策调用一完成就没人看了，直搜命中时要主动掐掉，别让它的文字继续往思考节点里灌。
      const decidePusher = streamPusher(session.id);
      let decideText = '';
      let decideClosed = false;
      const collectDecide = (chunk) => {
        if (decideClosed) return;
        decideText += chunk;
        decidePusher.push(chunk);
      };

      // 三件事并行：抽检索词 + 原文直搜、一次模型调用同时定意图与检索计划。
      // 抽取结果要留着：决策失败时它就是我们唯一靠得住的关键词来源。
      const extractPromise = extractUserQuery(userNeed, signal).catch(() => '');
      const literalPromise = extractPromise
        .then(query => (query ? searchLiteral(query, signal) : null))
        .catch(() => null);

      const decideAbort = new AbortController();
      const decideStartedAt = now();
      const decidePromise = decide(
        userNeed,
        combineSignals(signal, decideAbort.signal),
        providerContext,
        collectDecide,
        deadline,
        buildFollowUpContext(session.messages),
      ).catch(() => null);

      // 上一轮的结果卡：用于识别「再找一些」以及防止直搜原样重复上一轮。
      const previousPicks = lastPlanPicks(session.messages);

      // 直搜一旦命中就已经确定是「找歌」，不必等那次更慢的决策调用。
      const directOnly = literalPromise.then(hit => (hit
        ? { type: 'direct', value: hit }
        : new Promise(() => {})));

      const first = await Promise.race([
        decidePromise.then(value => ({ type: 'decide', value })),
        directOnly,
      ]);
      if (signal.aborted) return;

      let decision = null;
      let direct = null;
      if (first.type === 'direct' && repeatsPrevious(first.value, previousPicks)) {
        // 直搜只会把上一轮原样再来一遍（用户很可能在说「再找一些」）：
        // 不要短路，等决策回来走追加检索。
        decision = await decidePromise;
        decideClosed = true;
        decidePusher.flush();
      } else if (first.type === 'direct') {
        direct = first.value;
        // 决策不再需要：立刻中止请求并停止把它的流式输出推给侧边栏。
        decideClosed = true;
        decideAbort.abort();
        decidePusher.flush();
        decision = { ...FALLBACK_DECISION };
      } else {
        decideClosed = true;
        decision = first.value;
        decidePusher.flush();
      }

      const decideMs = Math.max(0, now() - decideStartedAt);
      const mode = decision?.mode || 'search';
      const routePayload = decision?.payload || {};

      // 决策就把预算吃光了：别再假装还能检索，直接说清楚卡在哪。
      if (mode === 'search' && !direct && deadline - now() <= 0) {
        const timingsText = `决策 ${decideMs < 100 ? '<0.1' : (decideMs / 1000).toFixed(1)}s`;
        notify('CHAT_THINKING_END', { sessionId: session.id });
        await append({
          role: 'agent',
          kind: 'error',
          text: `模型决策阶段用完了 ${formatSeconds(searchBudgetMs)} 秒预算，检索还没开始。可以再试一次，或换个更具体的说法。`,
          thinking: {
            text: clipThinking(decideText || '（模型没有输出可展示的分析）'),
            elapsedMs: decideMs,
            timingsText,
          },
          timingsText,
        });
        return;
      }

      await append({
        role: 'agent',
        kind: 'ack',
        text: decision?.reply || FALLBACK_DECISION.reply,
        mode,
      });

      if (mode === 'eq') {
        const eqPrompt = routePayload.eqPrompt || userNeed;
        const fresh = (await sessions.get(session.id)) || session;
        const currentEq = fresh.cartEq || fresh.result?.eq || null;
        notify('CHAT_THINKING_START', { sessionId: session.id, stage: 'eq' });
        const result = await tuneAndApply(eqPrompt, signal, session.id, currentEq);

        notify('CHAT_THINKING_END', { sessionId: session.id });

        if (result.ok) {
          await sessions.update(session.id, { cartEq: result.eq });
          await append({
            role: 'agent',
            kind: 'eq-card',
            eq: result.eq,
            reason: result.reason,
            thinking: result.thinking,
          });
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
      const cartSongs = freshSession.cart || [];

      // 「再找一些」：承接上一轮结果，但已经在会话歌单里的不再重复列出。
      const carryOver = decision?.carryOver === true;
      const cartIdSet = new Set(cartSongs.map(song => String(song.id)));
      const cartKeySet = new Set(cartSongs.map(song => String(trackKey(song))));
      const carried = carryOver
        ? lastPlanPicks(freshSession.messages).filter(pick => (
          !cartIdSet.has(String(pick.id))
          && !cartKeySet.has(String(trackKey(pick)))
        ))
        : [];

      // 新检索要排除：会话歌单里的 + 上一轮已经给过的（它们会单独拼回去）。
      const excludeIds = [
        ...cartSongs.flatMap(song => [song.id, trackKey(song)]),
        ...carried.flatMap(pick => [pick.id, trackKey(pick)]),
      ].filter(id => id !== undefined && id !== null && id !== '');

      if (!direct) direct = await literalPromise;
      if (signal.aborted) return;

      if (direct) {
        const literalPicks = pickLiteralTracks(
          direct.tracks,
          excludeIds,
          INTENT_CONFIG.literalSearchLimit,
          direct.hitId,
        );
        // 「再找一些」+ 直搜命中：上一轮保留的也要拼回去，不能只给这次直搜的。
        const picks = carryOver && carried.length > 0
          ? mergePicks(carried, literalPicks, INTENT_CONFIG.maxTargetCount)
          : literalPicks;
        if (picks.length > 0) {
          const hitTrack = direct.tracks.find(track => String(track.id) === String(direct.hitId));
          const thinking = {
            text: [
              `原文提取：${direct.query}`,
              `命中：${hitTrack?.name || picks[0]?.name || ''}`,
              '（原文直搜，跳过规划/挖歌单/精排）',
            ].join('\n'),
            elapsedMs: Math.max(0, now() - runStartedAt),
          };
          // 让实时思考节点也看到这段内容；重载后从 plan-card 的 thinking 恢复。
          notify('CHAT_STREAM_CHUNK', { sessionId: session.id, delta: thinking.text });
          notify('CHAT_THINKING_END', { sessionId: session.id });
          await append({
            role: 'agent',
            kind: 'plan-card',
            picks,
            plan: {
              queries: [{
                tool: 'searchTracks',
                keyword: direct.query,
                limit: INTENT_CONFIG.literalSearchLimit,
              }],
              targetCount: picks.length,
              direct: true,
            },
            stats: {
              raw: direct.tracks.length,
              total: picks.length,
              filtered: picks.length,
              carried: carryOver ? carried.length : 0,
              added: literalPicks.length,
              direct: true,
            },
            thinking,
          });
          return;
        }
      }

      // 决策没给出可用计划时，兜底关键词优先用抽取阶段的结果；
      // 抽取最多 6 秒，决策都失败了，这里再等它的成本可以接受。
      const planKeywords = decision?.mode === 'search'
        && Array.isArray(decision.queries) && decision.queries.length > 0
        ? ''
        : await extractPromise;

      const searchResult = await search(
        userNeed,
        signal,
        session.id,
        excludeIds,
        {
          deadline,
          plan: buildPlan(decision, userNeed, planKeywords),
          carryPicks: carried,
          // 决策阶段的流式输出已经推给侧边栏了，这里只把它并进最终落库的思考记录。
          priorThinking: decideText,
          decideMs,
          onProgress: (stage, detail) => notify('CHAT_PROGRESS', { sessionId: session.id, stage, detail }),
        },
      );

      if (signal.aborted) return;
      notify('CHAT_THINKING_END', { sessionId: session.id });

      if (searchResult.ok && carryOver && searchResult.stats.added === 0) {
        // 追加请求没找到新歌：不重复渲染一模一样的卡片，直接说明情况。
        await append({
          role: 'agent',
          kind: 'text',
          text: `这轮没有找到新的歌，上一轮的 ${carried.length} 首还在上面的卡片里。`
            + '可以告诉我具体的歌手/作品名，或者换个方向再试。',
        });
        return;
      }

      if (searchResult.ok && searchResult.picks.length === 0) {
        // 精排一首都没留下：给一句话，而不是一张空卡片（空卡片既看不出原因也没法点）。
        await append({
          role: 'agent',
          kind: 'text',
          text: '这次没找到对得上的歌。可以换成歌手名、作品名，或者告诉我更具体的曲风/语言/年代。',
        });
        return;
      }

      if (searchResult.ok) {
        await append({
          role: 'agent',
          kind: 'plan-card',
          picks: searchResult.picks,
          plan: searchResult.plan,
          stats: searchResult.stats,
          thinking: searchResult.thinking,
          timingsText: searchResult.thinking?.timingsText || '',
        });
      } else {
        await append({
          role: 'agent',
          kind: 'error',
          text: searchResult.error,
          thinking: searchResult.thinking,
          timingsText: searchResult.thinking?.timingsText || '',
        });
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
