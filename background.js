import {
  ROUTER_SYSTEM,
  PLANNER_SYSTEM,
  RERANK_SYSTEM,
  EQ_TUNER_SYSTEM,
} from './prompts.js';

import {
  DEFAULT_PROVIDER_ID,
  EQ_CONFIG,
  INTENT_CONFIG,
  SESSION_CONFIG,
} from './src/core/constants.js';

import { defaultEq, normalizeEq } from './src/core/eq.js';
import { createId } from './src/core/ids.js';
import { extractJson } from './src/core/json.js';
import { sanitizeTrack, trackKey } from './src/core/track.js';
import { createProviderRegistry } from './src/providers/index.js';

import { createNeteaseExternalPlayer } from './src/app/background/netease-external-player.js';
import { createMessageRouter } from './src/app/background/router.js';
import { registerBackgroundEvents } from './src/app/background/events.js';
import { createChatHandlers } from './src/app/background/handlers/chat.js';
import { createEqHandlers } from './src/app/background/handlers/eq.js';
import { createFsHandlers } from './src/app/background/handlers/fs.js';
import { createMusicHandlers } from './src/app/background/handlers/music.js';
import { createPlayerHandlers } from './src/app/background/handlers/player.js';
import { createPlaylistHandlers } from './src/app/background/handlers/playlists.js';
import { createSessionHandlers } from './src/app/background/handlers/sessions.js';
import { createEqPresetService, createPlaylistService } from './src/app/services/assets.js';
import { createPlayerService } from './src/app/services/player.js';
import { createPlayerPreferences } from './src/app/services/preferences.js';
import { createSessionService } from './src/app/services/sessions.js';
import { createAssetStore } from './src/app/storage/assets.js';
import { EQ_PRESETS_KEY, SAVED_PLAYLISTS_KEY } from './src/app/storage/keys.js';
import { createSessionStore } from './src/app/storage/sessions.js';

import {
  getFsStatus,
  getLastSyncAt,
  unbindFolder,
  pullFromFolder,
  pushToFolder,
  smartSync,
  scheduleSyncToFolder,
  initFs,
  onHandleSaved,
} from './fs-sync.js';

let currentChatAbort = null;
let offscreenCreating = null;

/** 往侧边栏推事件；侧边栏没打开时静默失败。 */
const forwardToSidepanel = (type, payload) => {
  chrome.runtime.sendMessage({ target: 'sidepanel', type, payload }).catch(() => {});
};

const SAVED_PLAYLISTS_LIMIT = 100;

const musicProviders = createProviderRegistry({
  externalPlayer: createNeteaseExternalPlayer(),
});

/* =====================================================
   仓储
   所有 storage 写入都经过 storageQueue，避免并发读改写互相覆盖
   ===================================================== */
const sessionsStore = createSessionStore({
  area: chrome.storage.local,
  maxSessions: SESSION_CONFIG.maxSessions,
  maxMessages: SESSION_CONFIG.maxMessagesPerSession,
});

const playlistsStore = createAssetStore({
  area: chrome.storage.local,
  key: SAVED_PLAYLISTS_KEY,
  limit: SAVED_PLAYLISTS_LIMIT,
  idPrefix: 'pl',
  notFoundMessage: '找不到这个播放列表',
});

const eqPresetsStore = createAssetStore({
  area: chrome.storage.local,
  key: EQ_PRESETS_KEY,
  limit: EQ_CONFIG.presetsLimit,
  idPrefix: 'eq',
  notFoundMessage: '找不到这个调音',
});

/* =====================================================
   服务层
   仓储负责存，服务负责「存之外还要跟播放器做什么」
   ===================================================== */
const playerPrefs = createPlayerPreferences({ area: chrome.storage.local });

const player = createPlayerService({
  send: (type, payload) => sendToOffscreen(type, payload),
  providers: musicProviders,
  prefs: playerPrefs,
});

const normalizeSong = song => sanitizeTrack(song, { provider: DEFAULT_PROVIDER_ID });

const sessions = createSessionService({ store: sessionsStore, player, normalizeSong });
const playlists = createPlaylistService({ store: playlistsStore, player, normalizeSong });
const eqPresets = createEqPresetService({ store: eqPresetsStore, player, normalizeEq });

/* =====================================================
   LLM 配置 / Offscreen
   ===================================================== */
async function getLLMConfig() {
  const { llmConfig } = await chrome.storage.local.get('llmConfig');
  if (!llmConfig || !llmConfig.endpoint || !llmConfig.model || !llmConfig.apiKey) return null;
  return llmConfig;
}
async function hasOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    return contexts.length > 0;
  } catch { return false; }
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (offscreenCreating) { await offscreenCreating; return true; }
  offscreenCreating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: '在侧边栏关闭后继续后台播放音乐并处理 EQ',
      });
    } catch (e) {
      if (!String(e?.message || '').includes('already')) console.warn('[NeteaseTool] 创建 offscreen 失败：', e);
    } finally { offscreenCreating = null; }
  })();
  await offscreenCreating;
  return true;
}
async function sendToOffscreen(type, payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', type, payload });
}

/* =====================================================
   音乐平台适配层
   ===================================================== */
function requireProvider() {
  const provider = musicProviders.primary;
  if (!provider) throw new Error('未注册音乐平台');
  return provider;
}

async function fetchPlaylists() {
  return requireProvider().getUserPlaylists({ limit: 1000 });
}

async function searchSongs(keyword, limit = 30, offset = 0, order = 'hot') {
  const result = await requireProvider().searchTracks({ keyword, limit, offset, order });
  return { songs: result.tracks, songCount: result.total };
}

async function deepSearchViaPlaylists(keyword, opts = {}) {
  const maxPlaylists = opts.maxPlaylists ?? 10;
  const maxTracksPerPlaylist = opts.maxTracksPerPlaylist ?? 1000;
  const provider = requireProvider();
  const playlists = await provider.searchPlaylists({ keyword, limit: maxPlaylists });
  if (playlists.length === 0) throw new Error(`没有找到与「${keyword}」相关的歌单`);

  const seen = new Set();
  const songs = [];
  const playlistStats = [];

  for (const playlist of playlists) {
    try {
      const tracks = await provider.getPlaylistTracks(playlist.id, {
        maxTracks: maxTracksPerPlaylist,
      });
      let added = 0;
      for (const track of tracks) {
        const key = trackKey(track) || track.id;
        if (seen.has(key)) continue;
        seen.add(key);
        songs.push({ ...track, sourceWeight: 2 });
        added++;
      }
      playlistStats.push({
        id: playlist.id,
        name: playlist.name,
        trackCount: tracks.length,
        added,
      });
    } catch (error) {
      playlistStats.push({
        id: playlist.id,
        name: playlist.name,
        error: error?.message || String(error),
      });
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { playlistsFound: playlists.length, playlistStats, songs };
}

async function fetchArtistAllSongs(artistName) {
  const result = await requireProvider().getArtistTracks(artistName);
  return {
    artist: result.artist,
    albumsFound: result.albumsFound,
    failedAlbums: result.failedAlbums,
    successPaths: result.successPaths,
    songs: result.tracks,
  };
}

/* =====================================================
   LLM
   ===================================================== */
async function callLLMStream(messages, onChunk, signal) {
  const cfg = await getLLMConfig();
  if (!cfg) throw new Error('未配置大模型');
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.3,
      stream: true,
    }),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`大模型 HTTP ${res.status}${t ? '：' + t.slice(0, 200) : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    if (content) onChunk(content);
    return content;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onChunk(delta); }
      } catch {}
    }
  }
  return full;
}
function makeStreamPusher(sessionId) {
  let buffer = '';
  let timer = null;
  const flush = () => {
    if (!buffer) return;
    const text = buffer;
    buffer = '';
    forwardToSidepanel('CHAT_STREAM_CHUNK', { sessionId, delta: text });
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
}
async function tuneEqWithLLM({ userNeed, currentEq, onChunk, signal }) {
  const eqContext = currentEq
    ? `\n\n当前 EQ（请在此基础上修改，除非用户说"重新调"）：\n${JSON.stringify({
        preampDb: currentEq.preampDb,
        bands: currentEq.bands,
      }, null, 2)}`
    : '\n\n用户还没有任何 EQ 配置，请从平坦状态开始设计。';
  const messages = [
    { role: 'system', content: EQ_TUNER_SYSTEM },
    { role: 'user', content: `用户需求：${userNeed}${eqContext}\n\n请先分析，再输出调整后的完整 EQ JSON。` },
  ];
  const raw = await callLLMStream(messages, onChunk || (() => {}), signal);
  const parsed = extractJson(raw);
  if (!parsed || !parsed.eq) throw new Error('大模型没有给出有效的 EQ JSON');
  const normalized = normalizeEq(parsed.eq);
  return { eq: normalized, reason: String(parsed.reason || '').slice(0, 200) };
}

/* =====================================================
   工具执行
   ===================================================== */
function normalizeToolName(tool) {
  if (tool === 'searchSongs') return 'searchTracks';
  if (tool === 'fetchArtistAllSongs') return 'getArtistTracks';
  return tool;
}

async function executeMyPlaylistsQuery(q) {
  const provider = requireProvider();
  const plData = await provider.getUserPlaylists({ limit: 1000 });
  const allPlaylists = plData.playlists || [];
  if (allPlaylists.length === 0) throw new Error('你的音乐账号下没有任何歌单');
  const keyword = String(q.playlistName || '').trim();
  let targets;
  if (!keyword) targets = allPlaylists;
  else {
    const kwLower = keyword.toLowerCase();
    targets = allPlaylists.filter(p => String(p.name).toLowerCase().includes(kwLower));
    if (targets.length === 0) {
      const words = kwLower.split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        targets = allPlaylists.filter(p => {
          const name = String(p.name).toLowerCase();
          return words.every(w => name.includes(w));
        });
      }
    }
    if (targets.length === 0) {
      const names = allPlaylists.slice(0, 8).map(p => `「${p.name}」`).join('、');
      throw new Error(`没有找到名字包含「${keyword}」的歌单。你的歌单里有：${names}${allPlaylists.length > 8 ? ' 等' : ''}`);
    }
  }
  targets = targets.filter(p => (p.trackCount === null || p.trackCount === undefined || p.trackCount > 0));
  const limit = Math.min(Math.max(Number(q.limit) || 5, 1), 20);
  const picked = targets.slice(0, limit);
  if (picked.length === 0) throw new Error('匹配到的歌单都是空的');
  const maxTracks = Math.min(Math.max(Number(q.maxTracksPerPlaylist) || 400, 1), 1000);
  const seen = new Set();
  const collected = [];
  for (const p of picked) {
    try {
      const tracks = await provider.getPlaylistTracks(p.id, { maxTracks });
      for (const track of tracks) {
        const key = trackKey(track) || track.id;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push({ ...track, sourceWeight: 4, fromPlaylist: p.name });
      }
    } catch (e) { console.warn(`[意图搜索] 挖用户歌单 ${p.id} 失败：${e?.message || e}`); }
    await new Promise(r => setTimeout(r, 200));
  }
  return collected;
}
async function executeOneQuery(q, provider = requireProvider()) {
  const tool = normalizeToolName(q.tool);

  if (tool === 'searchTracks') {
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
    const result = await provider.searchTracks({
      keyword: String(q.keyword || ''),
      limit,
      offset: 0,
      order: 'hot',
    });
    return result.tracks.map(track => ({ ...track, sourceWeight: 3 }));
  }

  if (tool === 'searchPlaylists') {
    const limit = Math.min(Math.max(Number(q.limit) || 5, 1), 20);
    const maxTracks = Math.min(Math.max(Number(q.maxTracksPerPlaylist) || 200, 1), 500);
    const playlists = await provider.searchPlaylists({
      keyword: String(q.keyword || ''),
      limit,
    });
    const collected = [];
    for (const p of playlists) {
      try {
        const tracks = await provider.getPlaylistTracks(p.id, { maxTracks });
        for (const track of tracks) {
          collected.push({ ...track, sourceWeight: 2 });
        }
      } catch (e) { console.warn(`[意图搜索] 挖歌单 ${p.id} 失败：${e?.message || e}`); }
      await new Promise(r => setTimeout(r, 200));
    }
    return collected;
  }

  if (tool === 'getArtistTracks') {
    const artistName = String(q.artistName || '').trim();
    if (!artistName) return [];
    const result = await provider.getArtistTracks(artistName);
    return result.tracks.map(track => ({ ...track, sourceWeight: 1 }));
  }

  if (tool === 'myPlaylists') return executeMyPlaylistsQuery(q);
  throw new Error(`未知工具：${q.tool}`);
}
function dedupByWeight(candidates) {
  const byKey = new Map();
  for (const song of candidates) {
    const key = trackKey(song) || song.id;
    const old = byKey.get(key);
    if (!old || (song.sourceWeight || 0) > (old.sourceWeight || 0)) byKey.set(key, song);
  }
  return [...byKey.values()];
}
function coarseFilter(candidates, filters, targetCount) {
  let out = candidates;
  if (filters?.durationMs) {
    const { min, max } = filters.durationMs;
    out = out.filter(s => {
      if (Number.isFinite(min) && s.durationMs && s.durationMs < min) return false;
      if (Number.isFinite(max) && s.durationMs && s.durationMs > max) return false;
      return true;
    });
  }
  if (Array.isArray(filters?.excludeKeywords)) {
    const kws = filters.excludeKeywords
      .filter(k => typeof k === 'string' && k.trim())
      .map(k => k.toLowerCase());
    if (kws.length) {
      out = out.filter(s => {
        const text = `${s.name || ''} ${s.album || ''} ${s.artists || ''}`.toLowerCase();
        return !kws.some(k => text.includes(k));
      });
    }
  }
  out.sort((a, b) => {
    const w = (b.sourceWeight || 0) - (a.sourceWeight || 0);
    if (w !== 0) return w;
    return (b.cover ? 1 : 0) - (a.cover ? 1 : 0);
  });
  const cap = Math.min(
    Math.max((targetCount || 10) * INTENT_CONFIG.coarseFilterMultiplier, INTENT_CONFIG.coarseFilterMin),
    INTENT_CONFIG.coarseFilterMax
  );
  return out.slice(0, cap);
}

/* =====================================================
   对话路由
   ===================================================== */
async function routeIntent(userNeed, signal) {
  const raw = await callLLMStream(
    [{ role: 'system', content: ROUTER_SYSTEM }, { role: 'user', content: userNeed }],
    () => {}, signal
  );
  const parsed = extractJson(raw);
  if (!parsed || !parsed.mode) return { mode: 'search', reply: '收到，正在找歌…', payload: {} };
  return parsed;
}
async function runIntentSearchForChat(userNeed, signal, sessionId, excludeIds, onProgress) {
  const pusher = makeStreamPusher(sessionId);
  try {
    const provider = requireProvider();
    const providerContext = `当前平台：${provider.label}；可用检索能力：${provider.capabilities.search.join(' / ')}。`;

    onProgress?.('plan', '正在规划检索方案…');
    const planRaw = await callLLMStream(
      [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: `${providerContext}\n用户需求：${userNeed}\n\n请先分析，然后输出检索计划。` },
      ],
      (chunk) => pusher.push(chunk),
      signal
    );
    pusher.flush();
    const plan = extractJson(planRaw);
    if (!plan) throw new Error('模型没有给出有效的检索计划');
    plan.queries = Array.isArray(plan.queries) ? plan.queries.slice(0, INTENT_CONFIG.maxQueries) : [];
    if (!Number.isFinite(plan.targetCount) || plan.targetCount < 0) plan.targetCount = 10;
    if (plan.targetCount > INTENT_CONFIG.maxTargetCount) plan.targetCount = INTENT_CONFIG.maxTargetCount;
    if (plan.queries.length === 0) throw new Error('模型没有给出任何检索动作');

    forwardToSidepanel('CHAT_THINKING_END', { sessionId });

    onProgress?.('execute', `执行 ${plan.queries.length} 个检索动作…`);
    const raw = [];
    for (const q of plan.queries) {
      if (signal.aborted) throw new Error('已中止');
      try {
        const result = await executeOneQuery(q, provider);
        raw.push(...result);
      } catch (e) { console.warn('[chat] 检索失败：', e?.message); }
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

    forwardToSidepanel('CHAT_THINKING_START', { sessionId, stage: 'rerank' });

    const pusher2 = makeStreamPusher(sessionId);
    const forLLM = filtered.map(s => ({
      id: s.id, name: s.name, artists: s.artists,
      album: s.album, durationMs: s.durationMs,
    }));
    const rerankRaw = await callLLMStream(
      [
        { role: 'system', content: RERANK_SYSTEM },
        { role: 'user', content: `用户需求：${userNeed}\n\n候选（${forLLM.length} 首）：\n${JSON.stringify(forLLM)}\n\n输出 picks。` },
      ],
      (chunk) => pusher2.push(chunk),
      signal
    );
    pusher2.flush();
    const rerankResult = extractJson(rerankRaw);
    if (!rerankResult || !Array.isArray(rerankResult.picks)) throw new Error('模型没有给出有效的 picks');

    const validIds = new Set(filtered.map(song => String(song.id)));
    const seen = new Set();
    const cleanPicks = [];
    for (const p of rerankResult.picks) {
      const id = String(p?.id ?? '');
      if (!id || !validIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      cleanPicks.push({ id, reason: String(p.reason || '').slice(0, INTENT_CONFIG.rerankReasonMaxLen) });
      if (cleanPicks.length >= plan.targetCount) break;
    }
    const byId = new Map(filtered.map(song => [String(song.id), song]));
    const picks = cleanPicks.map(p => ({ ...byId.get(p.id), reason: p.reason }));
    return {
      ok: true, plan, picks,
      stats: { raw: raw.length, total: deduped.length, filtered: filtered.length },
    };
  } catch (e) {
    pusher.flush();
    return { ok: false, error: e?.message || String(e) };
  }
}
async function runEqTuningForChat(userNeed, signal, sessionId, currentEq) {
  const pusher = makeStreamPusher(sessionId);
  try {
    const { eq, reason } = await tuneEqWithLLM({
      userNeed, currentEq,
      onChunk: (chunk) => pusher.push(chunk),
      signal,
    });
    pusher.flush();
    const applyR = await player.setEq(eq);
    if (!applyR?.ok) throw new Error(applyR?.error || '应用 EQ 失败');
    return { ok: true, eq: applyR.eq || eq, reason };
  } catch (e) {
    pusher.flush();
    return { ok: false, error: e?.message || String(e) };
  }
}

/* =====================================================
   对话入口
   ===================================================== */
async function runChatRequest({ userNeed, sessionId, userMessageId }) {
  let session = null;
  if (sessionId) {
    const list = await sessions.list();
    session = list.find(s => s.id === sessionId) || null;
  }
  if (!session) session = await sessions.current();
  if (!session) session = await sessions.create(userNeed.slice(0, 20) || '新会话');

  const abort = new AbortController();
  currentChatAbort = abort;
  const signal = abort.signal;

  const newMsgId = () => createId('msg');

  try {
    await sessions.appendMessage(session.id, {
      id: userMessageId || newMsgId(),
      role: 'user', kind: 'text',
      text: userNeed, at: Date.now(),
    });

    forwardToSidepanel('CHAT_THINKING_START', { sessionId: session.id, stage: 'route' });

    let route;
    try { route = await routeIntent(userNeed, signal); }
    catch (e) { route = { mode: 'search', reply: '收到，正在找歌…', payload: {} }; }

    const mode = route.mode || 'search';
    const payload = route.payload || {};

    await sessions.appendMessage(session.id, {
      id: newMsgId(), role: 'agent', kind: 'ack',
      text: route.reply || '收到', at: Date.now(), mode,
    });

    // ---- eq ----
    if (mode === 'eq') {
      const eqPrompt = payload.eqPrompt || userNeed;
      const sessionsFresh = await sessions.list();
      const freshSession = sessionsFresh.find(s => s.id === session.id) || session;
      const currentEq = freshSession.cartEq || freshSession.result?.eq || null;
      const result = await runEqTuningForChat(eqPrompt, signal, session.id, currentEq);
      forwardToSidepanel('CHAT_THINKING_END', { sessionId: session.id });
      if (result.ok) {
        await sessions.update(session.id, { cartEq: result.eq });
        await sessions.appendMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'eq-card',
          eq: result.eq, reason: result.reason, at: Date.now(),
        });
      } else {
        await sessions.appendMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'error',
          text: result.error, at: Date.now(),
        });
      }
      return;
    }

    // ---- open-eq-panel ----
    if (mode === 'open-eq-panel') {
      forwardToSidepanel('CHAT_THINKING_END', { sessionId: session.id });
      const sessionsFresh = await sessions.list();
      const fresh = sessionsFresh.find(s => s.id === session.id) || session;
      const currentEq = fresh.cartEq || fresh.result?.eq || defaultEq();
      await sessions.appendMessage(session.id, {
        id: newMsgId(), role: 'agent', kind: 'eq-card',
        eq: currentEq, reason: null, at: Date.now(),
      });
      return;
    }

    // ---- save-eq ----
    if (mode === 'save-eq') {
      const name = payload.name || `调音-${new Date().toLocaleDateString('zh-CN')}`;
      try {
        const sessionsFresh = await sessions.list();
        const fresh = sessionsFresh.find(s => s.id === session.id);
        const eqToSave = fresh?.cartEq || fresh?.result?.eq;
        if (!eqToSave) throw new Error('当前会话还没有调音');
        const saved = await eqPresets.save({ name, eq: eqToSave, source: 'manual' });
        await sessions.appendMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'save-card',
          cardType: 'eq', name: saved.name, at: Date.now(),
        });
      } catch (e) {
        await sessions.appendMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'error',
          text: '保存调音失败：' + (e?.message || e), at: Date.now(),
        });
      }
      return;
    }

    // ---- save-list ----
    if (mode === 'save-list') {
      const name = payload.name || `列表-${new Date().toLocaleDateString('zh-CN')}`;
      try {
        const sessionsFresh = await sessions.list();
        const fresh = sessionsFresh.find(s => s.id === session.id);
        const songsToSave = (fresh?.cart && fresh.cart.length > 0)
          ? fresh.cart
          : (fresh?.result?.playlist || []);
        if (!songsToSave.length) throw new Error('会话歌单和结算歌单都是空的');
        const saved = await playlists.save({ name, songs: songsToSave, source: 'manual' });
        await sessions.appendMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'save-card',
          cardType: 'playlist', name: saved.name,
          count: saved.songs.length, at: Date.now(),
        });
      } catch (e) {
        await sessions.appendMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'error',
          text: '保存列表失败：' + (e?.message || e), at: Date.now(),
        });
      }
      return;
    }

    // ---- chat ----
    if (mode === 'chat') {
      forwardToSidepanel('CHAT_THINKING_END', { sessionId: session.id });
      await sessions.appendMessage(session.id, {
        id: newMsgId(), role: 'agent', kind: 'text',
        text: '可以跟我说：想听什么场景的歌（"深夜写代码"）、想调整听感（"低频轻一点"）、或者"把当前列表保存成 XX"。',
        at: Date.now(),
      });
      return;
    }

    // ---- search（默认）----
    const sessionsFresh = await sessions.list();
    const freshSession = sessionsFresh.find(s => s.id === session.id) || session;
    const excludeIds = (freshSession.cart || [])
      .flatMap(song => [song.id, trackKey(song)])
      .filter(id => id !== undefined && id !== null && id !== '');

    const searchResult = await runIntentSearchForChat(
      userNeed, signal, session.id, excludeIds,
      (stage, detail) => {
        forwardToSidepanel('CHAT_PROGRESS', { sessionId: session.id, stage, detail });
      }
    );

    forwardToSidepanel('CHAT_THINKING_END', { sessionId: session.id });

    if (searchResult.ok) {
      await sessions.appendMessage(session.id, {
        id: newMsgId(), role: 'agent', kind: 'plan-card',
        picks: searchResult.picks,
        plan: searchResult.plan,
        stats: searchResult.stats,
        at: Date.now(),
      });
    } else {
      await sessions.appendMessage(session.id, {
        id: newMsgId(), role: 'agent', kind: 'error',
        text: searchResult.error, at: Date.now(),
      });
    }
  } catch (e) {
    if (signal.aborted) return;
    console.error('[chatStart] 失败：', e);
    try {
      await sessions.appendMessage(session.id, {
        id: newMsgId(), role: 'agent', kind: 'error',
        text: e?.message || String(e), at: Date.now(),
      });
    } catch {}
  } finally {
    if (currentChatAbort === abort) currentChatAbort = null;
  }
}


/* =====================================================
   消息路由
   ===================================================== */
const abortChat = () => {
  if (!currentChatAbort) return;
  try { currentChatAbort.abort(); } catch {}
};

const startChat = (payload) => {
  runChatRequest(payload).catch(e => console.warn('[chatStart] 未捕获失败：', e));
};

const playerHandlers = createPlayerHandlers({ player, forwardToSidepanel });

const routeMessage = createMessageRouter({
  actions: {
    ...createFsHandlers({
      getStatus: getFsStatus,
      getLastSyncAt,
      bind: onHandleSaved,
      unbind: unbindFolder,
      syncNow: smartSync,
      forcePush: pushToFolder,
      pull: pullFromFolder,
    }),

    ...createMusicHandlers({
      fetchPlaylists,
      searchSongs,
      deepSearch: deepSearchViaPlaylists,
      artistAllSongs: fetchArtistAllSongs,
      pause: () => player.pauseExternal(),
    }),

    ...createPlaylistHandlers({ playlists, sessions, player }),
    ...createEqHandlers({ presets: eqPresets, player }),
    ...createChatHandlers({
      chat: { start: startChat, abort: abortChat },
      sessions,
      forwardToSidepanel,
    }),
    ...createSessionHandlers(sessions),
  },
  types: playerHandlers.types,
  typePrefixes: [playerHandlers.prefix],
});

chrome.runtime.onMessage.addListener(routeMessage);

/* =====================================================
   扩展事件
   ===================================================== */
registerBackgroundEvents({
  fs: { init: initFs, scheduleSync: scheduleSyncToFolder },
});
