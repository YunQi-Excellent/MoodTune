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
  PLAYER_DEFAULTS,
  SESSION_CONFIG,
} from './src/core/constants.js';

import { defaultEq, normalizeEq } from './src/core/eq.js';
import { createId } from './src/core/ids.js';
import { extractJson } from './src/core/json.js';
import { sanitizeTrack, trackKey } from './src/core/track.js';
import { getDefaultProvider } from './src/providers/index.js';

import {
  getFsStatus,
  getLastSyncAt,
  bindFolder,
  unbindFolder,
  pullFromFolder,
  pushToFolder,
  smartSync,
  scheduleSyncToFolder,
  initFs,
  onHandleSaved,
} from './fs-sync.js';

let currentIntentAbort = null;
let offscreenCreating = null;

const INTENT_STATE_KEY = 'intentState';
const SAVED_PLAYLISTS_KEY = 'savedPlaylists';
const SAVED_PLAYLISTS_LIMIT = 100;
const EQ_PRESETS_KEY = 'eqPresets';
const SESSIONS_KEY = 'chatSessions';
const CURRENT_SESSION_KEY = 'currentSessionId';

/* =====================================================
   保存的播放列表
   ===================================================== */
async function getSavedPlaylists() {
  const r = await chrome.storage.local.get(SAVED_PLAYLISTS_KEY);
  return Array.isArray(r[SAVED_PLAYLISTS_KEY]) ? r[SAVED_PLAYLISTS_KEY] : [];
}
function sanitizeSong(song) {
  return sanitizeTrack(song, { provider: DEFAULT_PROVIDER_ID });
}
async function savePlaylist({ name, songs, source }) {
  if (!Array.isArray(songs) || songs.length === 0) throw new Error('播放列表为空');
  const list = await getSavedPlaylists();
  const item = {
    id: createId('pl'),
    name: String(name || '未命名').trim().slice(0, 60) || '未命名',
    songs: songs.map(sanitizeSong),
    createdAt: Date.now(),
    source: source || 'manual',
  };
  list.unshift(item);
  if (list.length > SAVED_PLAYLISTS_LIMIT) list.length = SAVED_PLAYLISTS_LIMIT;
  await chrome.storage.local.set({ [SAVED_PLAYLISTS_KEY]: list });
  return item;
}
async function deletePlaylist(id) {
  const list = await getSavedPlaylists();
  const next = list.filter(p => p.id !== id);
  await chrome.storage.local.set({ [SAVED_PLAYLISTS_KEY]: next });
  return next;
}
async function renamePlaylist(id, name) {
  const list = await getSavedPlaylists();
  const target = list.find(p => p.id === id);
  if (!target) throw new Error('找不到这个播放列表');
  target.name = String(name || '未命名').trim().slice(0, 60) || '未命名';
  await chrome.storage.local.set({ [SAVED_PLAYLISTS_KEY]: list });
  return list;
}
async function playSavedPlaylist(id) {
  const list = await getSavedPlaylists();
  const target = list.find(p => p.id === id);
  if (!target) throw new Error('找不到这个播放列表');
  await sendToOffscreen('PLAYER_SET_PLAYLIST', { songs: target.songs, autoPlay: true });
  return target;
}

/* =====================================================
   EQ 预设
   ===================================================== */
async function getEqPresets() {
  const r = await chrome.storage.local.get(EQ_PRESETS_KEY);
  return Array.isArray(r[EQ_PRESETS_KEY]) ? r[EQ_PRESETS_KEY] : [];
}
async function saveEqPreset({ name, eq, source }) {
  if (!eq) throw new Error('没有可保存的调音');
  const list = await getEqPresets();
  const item = {
    id: createId('eq'),
    name: String(name || '未命名').trim().slice(0, 60) || '未命名',
    eq: normalizeEq(eq),
    createdAt: Date.now(),
    source: source || 'manual',
  };
  list.unshift(item);
  if (list.length > EQ_CONFIG.presetsLimit) list.length = EQ_CONFIG.presetsLimit;
  await chrome.storage.local.set({ [EQ_PRESETS_KEY]: list });
  return item;
}
async function deleteEqPreset(id) {
  const list = await getEqPresets();
  const next = list.filter(p => p.id !== id);
  await chrome.storage.local.set({ [EQ_PRESETS_KEY]: next });
  return next;
}
async function renameEqPreset(id, name) {
  const list = await getEqPresets();
  const target = list.find(p => p.id === id);
  if (!target) throw new Error('找不到这个调音');
  target.name = String(name || '未命名').trim().slice(0, 60) || '未命名';
  await chrome.storage.local.set({ [EQ_PRESETS_KEY]: list });
  return list;
}
async function applyEqPreset(id) {
  const list = await getEqPresets();
  const target = list.find(p => p.id === id);
  if (!target) throw new Error('找不到这个调音');
  const r = await sendToOffscreen('EQ_SET', { eq: target.eq });
  return { preset: target, eq: r?.eq };
}

/* =====================================================
   Session（含 cart / result）
   ===================================================== */
async function getSessions() {
  const r = await chrome.storage.local.get(SESSIONS_KEY);
  return Array.isArray(r[SESSIONS_KEY]) ? r[SESSIONS_KEY] : [];
}
async function saveSessions(sessions) {
  await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
}
async function getCurrentSession() {
  const idR = await chrome.storage.local.get(CURRENT_SESSION_KEY);
  const currentId = idR[CURRENT_SESSION_KEY];
  if (!currentId) return null;
  const sessions = await getSessions();
  return sessions.find(s => s.id === currentId) || null;
}
async function createSession(name) {
  const sessions = await getSessions();
  const session = {
    id: createId('sess'),
    name: String(name || '新会话').trim().slice(0, 40) || '新会话',
    createdAt: Date.now(),
    messages: [],
    cart: [],
    cartEq: null,
    result: null,
    songCount: 0,
    lastActiveAt: Date.now(),
  };
  sessions.unshift(session);
  if (sessions.length > SESSION_CONFIG.maxSessions) sessions.length = SESSION_CONFIG.maxSessions;
  await saveSessions(sessions);
  await chrome.storage.local.set({ [CURRENT_SESSION_KEY]: session.id });
  return session;
}
async function switchSession(id) {
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === id);
  if (!target) throw new Error('找不到这个会话');
  await chrome.storage.local.set({ [CURRENT_SESSION_KEY]: id });
  return target;
}
async function deleteSession(id) {
  const sessions = await getSessions();
  const next = sessions.filter(s => s.id !== id);
  await saveSessions(next);
  const idR = await chrome.storage.local.get(CURRENT_SESSION_KEY);
  if (idR[CURRENT_SESSION_KEY] === id) {
    if (next.length > 0) await chrome.storage.local.set({ [CURRENT_SESSION_KEY]: next[0].id });
    else await chrome.storage.local.remove(CURRENT_SESSION_KEY);
  }
  return next;
}
async function renameSession(id, name) {
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === id);
  if (!target) throw new Error('找不到会话');
  target.name = String(name || '').trim().slice(0, 40) || '未命名';
  await saveSessions(sessions);
  return target;
}
async function appendSessionMessage(sessionId, message) {
  const sessions = await getSessions();
  let target = sessions.find(s => s.id === sessionId);
  if (!target) {
    const fresh = {
      id: sessionId || ('sess-' + Date.now().toString(36)),
      name: '新会话',
      createdAt: Date.now(),
      messages: [],
      cart: [],
      cartEq: null,
      result: null,
      songCount: 0,
      lastActiveAt: Date.now(),
    };
    fresh.messages.push(message);
    sessions.unshift(fresh);
    await saveSessions(sessions);
    return fresh;
  }
  if (message.id && target.messages.some(m => m.id === message.id)) return target;
  target.messages.push(message);
  if (target.messages.length > SESSION_CONFIG.maxMessagesPerSession) {
    target.messages = target.messages.slice(-SESSION_CONFIG.maxMessagesPerSession);
  }
  target.lastActiveAt = Date.now();
  await saveSessions(sessions);
  return target;
}
async function updateSession(sessionId, patch) {
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === sessionId);
  if (!target) return null;
  Object.assign(target, patch);
  target.lastActiveAt = Date.now();
  await saveSessions(sessions);
  return target;
}

/* =====================================================
   购物车操作
   ===================================================== */
async function cartAdd(sessionId, songs) {
  if (!Array.isArray(songs) || songs.length === 0) return null;
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === sessionId);
  if (!target) throw new Error('找不到会话');
  target.cart = Array.isArray(target.cart) ? target.cart : [];
  const existing = new Set(target.cart.map(s => s.id));
  let added = 0;
  for (const s of songs) {
    if (existing.has(s.id)) continue;
    target.cart.push(sanitizeSong(s));
    existing.add(s.id);
    added++;
  }
  target.lastActiveAt = Date.now();
  await saveSessions(sessions);
  return { added, total: target.cart.length };
}
async function cartRemove(sessionId, songIds) {
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === sessionId);
  if (!target) throw new Error('找不到会话');
  const removeSet = new Set(songIds);
  target.cart = (target.cart || []).filter(s => !removeSet.has(s.id));
  target.lastActiveAt = Date.now();
  await saveSessions(sessions);
  return { total: target.cart.length };
}
async function cartReorder(sessionId, orderedIds) {
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === sessionId);
  if (!target) throw new Error('找不到会话');
  const cartMap = new Map((target.cart || []).map(s => [s.id, s]));
  const next = [];
  for (const id of orderedIds) {
    const item = cartMap.get(id);
    if (item) { next.push(item); cartMap.delete(id); }
  }
  for (const item of cartMap.values()) next.push(item);
  target.cart = next;
  target.lastActiveAt = Date.now();
  await saveSessions(sessions);
  return { total: next.length };
}
async function cartClear(sessionId) {
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === sessionId);
  if (!target) throw new Error('找不到会话');
  target.cart = [];
  target.lastActiveAt = Date.now();
  await saveSessions(sessions);
  return { total: 0 };
}
async function cartSettle(sessionId) {
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === sessionId);
  if (!target) throw new Error('找不到会话');
  const cart = Array.isArray(target.cart) ? target.cart : [];
  if (cart.length === 0) throw new Error('会话歌单是空的');

  let appliedEq = null;
  if (target.cartEq) {
    try {
      const r = await sendToOffscreen('EQ_SET', { eq: target.cartEq });
      if (r?.ok) appliedEq = r.eq || target.cartEq;
    } catch {}
  }

  await pausePageAudio();
  await sendToOffscreen('PLAYER_SET_PLAYLIST', { songs: cart, autoPlay: true });

  const result = {
    playlist: cart.map(sanitizeSong),
    eq: appliedEq || target.cartEq || null,
    playlistSource: target.result?.playlistSource || null,
    eqSource: target.result?.eqSource || null,
    settledAt: Date.now(),
  };
  target.result = result;
  target.songCount = cart.length;
  target.lastActiveAt = Date.now();
  await saveSessions(sessions);
  return { ok: true, count: cart.length, result };
}
async function restoreSession(id) {
  const sessions = await getSessions();
  const target = sessions.find(s => s.id === id);
  if (!target) throw new Error('找不到会话');

  const result = { eq: null, songCount: 0, messages: [] };
  const r = target.result;

  if (r) {
    if (r.eq) {
      try {
        const res = await sendToOffscreen('EQ_SET', { eq: r.eq });
        if (res?.ok) {
          result.eq = res.eq || r.eq;
          result.messages.push('已应用调音快照');
        }
      } catch (e) {
        result.messages.push('恢复调音失败：' + (e?.message || e));
      }
    }
    if (Array.isArray(r.playlist) && r.playlist.length > 0) {
      try {
        await pausePageAudio();
        await sendToOffscreen('PLAYER_SET_PLAYLIST', { songs: r.playlist, autoPlay: true });
        result.songCount = r.playlist.length;
        result.messages.push(`已恢复 ${r.playlist.length} 首歌`);
      } catch (e) {
        result.messages.push('恢复歌单失败：' + (e?.message || e));
      }
    }
  } else {
    if (target.eq) {
      try {
        const res = await sendToOffscreen('EQ_SET', { eq: target.eq });
        if (res?.ok) result.eq = res.eq || target.eq;
      } catch {}
    }
    if (Array.isArray(target.playlistSnapshot) && target.playlistSnapshot.length > 0) {
      try {
        await pausePageAudio();
        await sendToOffscreen('PLAYER_SET_PLAYLIST', { songs: target.playlistSnapshot, autoPlay: true });
        result.songCount = target.playlistSnapshot.length;
      } catch {}
    }
  }

  await chrome.storage.local.set({ [CURRENT_SESSION_KEY]: id });
  return result;
}

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
   意图状态（旧入口）
   ===================================================== */
async function getIntentState() {
  const r = await chrome.storage.session.get(INTENT_STATE_KEY);
  return r[INTENT_STATE_KEY] || null;
}
async function setIntentState(updater) {
  const cur = await getIntentState();
  const next = typeof updater === 'function' ? updater(cur) : { ...(cur || {}), ...updater };
  await chrome.storage.session.set({ [INTENT_STATE_KEY]: next });
  return next;
}
async function appendIntentLog(level, text) {
  await setIntentState(cur => {
    const s = cur || { status: 'idle', log: [] };
    s.log = [...(s.log || []), { time: Date.now(), level, text }];
    if (s.log.length > 200) s.log = s.log.slice(-200);
    return s;
  });
}
async function setIntentThinking(channel, text) {
  await setIntentState(cur => ({ ...(cur || {}), thinking: { channel, text: text || '' } }));
}
async function appendIntentThinking(channel, chunk) {
  await setIntentState(cur => {
    const s = cur || {};
    const prev = s.thinking || { channel, text: '' };
    const text = (prev.channel === channel ? prev.text : '') + chunk;
    s.thinking = { channel, text };
    return s;
  });
}
async function clearIntentThinking() {
  await setIntentState(cur => ({ ...(cur || {}), thinking: null }));
}

/* =====================================================
   音乐平台适配层
   ===================================================== */
function requireProvider() {
  const provider = getDefaultProvider();
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
    chrome.runtime.sendMessage({
      target: 'sidepanel',
      type: 'CHAT_STREAM_CHUNK',
      payload: { sessionId, delta: text },
    }).catch(() => {});
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
function getQueryLabel(q) {
  const tool = normalizeToolName(q.tool);
  if (tool === 'searchTracks' || tool === 'searchPlaylists') return q.keyword || '';
  if (tool === 'getArtistTracks') return q.artistName || '';
  if (tool === 'myPlaylists') return q.playlistName ? `歌单名含「${q.playlistName}」` : '（我的全部歌单）';
  return '';
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

    chrome.runtime.sendMessage({
      target: 'sidepanel', type: 'CHAT_THINKING_END',
      payload: { sessionId },
    }).catch(() => {});

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

    chrome.runtime.sendMessage({
      target: 'sidepanel', type: 'CHAT_THINKING_START',
      payload: { sessionId, stage: 'rerank' },
    }).catch(() => {});

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
    const applyR = await sendToOffscreen('EQ_SET', { eq });
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
    const sessions = await getSessions();
    session = sessions.find(s => s.id === sessionId) || null;
  }
  if (!session) session = await getCurrentSession();
  if (!session) session = await createSession(userNeed.slice(0, 20) || '新会话');

  const abort = new AbortController();
  currentIntentAbort = abort;
  const signal = abort.signal;

  const newMsgId = () => createId('msg');

  try {
    await appendSessionMessage(session.id, {
      id: userMessageId || newMsgId(),
      role: 'user', kind: 'text',
      text: userNeed, at: Date.now(),
    });

    chrome.runtime.sendMessage({
      target: 'sidepanel', type: 'CHAT_THINKING_START',
      payload: { sessionId: session.id, stage: 'route' },
    }).catch(() => {});

    let route;
    try { route = await routeIntent(userNeed, signal); }
    catch (e) { route = { mode: 'search', reply: '收到，正在找歌…', payload: {} }; }

    const mode = route.mode || 'search';
    const payload = route.payload || {};

    await appendSessionMessage(session.id, {
      id: newMsgId(), role: 'agent', kind: 'ack',
      text: route.reply || '收到', at: Date.now(), mode,
    });

    // ---- eq ----
    if (mode === 'eq') {
      const eqPrompt = payload.eqPrompt || userNeed;
      const sessionsFresh = await getSessions();
      const freshSession = sessionsFresh.find(s => s.id === session.id) || session;
      const currentEq = freshSession.cartEq || freshSession.result?.eq || null;
      const result = await runEqTuningForChat(eqPrompt, signal, session.id, currentEq);
      chrome.runtime.sendMessage({
        target: 'sidepanel', type: 'CHAT_THINKING_END',
        payload: { sessionId: session.id },
      }).catch(() => {});
      if (result.ok) {
        await updateSession(session.id, { cartEq: result.eq });
        await appendSessionMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'eq-card',
          eq: result.eq, reason: result.reason, at: Date.now(),
        });
      } else {
        await appendSessionMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'error',
          text: result.error, at: Date.now(),
        });
      }
      return;
    }

    // ---- open-eq-panel ----
    if (mode === 'open-eq-panel') {
      chrome.runtime.sendMessage({
        target: 'sidepanel', type: 'CHAT_THINKING_END',
        payload: { sessionId: session.id },
      }).catch(() => {});
      const sessionsFresh = await getSessions();
      const fresh = sessionsFresh.find(s => s.id === session.id) || session;
      const currentEq = fresh.cartEq || fresh.result?.eq || defaultEq();
      await appendSessionMessage(session.id, {
        id: newMsgId(), role: 'agent', kind: 'eq-card',
        eq: currentEq, reason: null, at: Date.now(),
      });
      return;
    }

    // ---- save-eq ----
    if (mode === 'save-eq') {
      const name = payload.name || `调音-${new Date().toLocaleDateString('zh-CN')}`;
      try {
        const sessionsFresh = await getSessions();
        const fresh = sessionsFresh.find(s => s.id === session.id);
        const eqToSave = fresh?.cartEq || fresh?.result?.eq;
        if (!eqToSave) throw new Error('当前会话还没有调音');
        const saved = await saveEqPreset({ name, eq: eqToSave, source: 'manual' });
        await appendSessionMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'save-card',
          cardType: 'eq', name: saved.name, at: Date.now(),
        });
      } catch (e) {
        await appendSessionMessage(session.id, {
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
        const sessionsFresh = await getSessions();
        const fresh = sessionsFresh.find(s => s.id === session.id);
        const songsToSave = (fresh?.cart && fresh.cart.length > 0)
          ? fresh.cart
          : (fresh?.result?.playlist || []);
        if (!songsToSave.length) throw new Error('会话歌单和结算歌单都是空的');
        const saved = await savePlaylist({ name, songs: songsToSave, source: 'manual' });
        await appendSessionMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'save-card',
          cardType: 'playlist', name: saved.name,
          count: saved.songs.length, at: Date.now(),
        });
      } catch (e) {
        await appendSessionMessage(session.id, {
          id: newMsgId(), role: 'agent', kind: 'error',
          text: '保存列表失败：' + (e?.message || e), at: Date.now(),
        });
      }
      return;
    }

    // ---- chat ----
    if (mode === 'chat') {
      chrome.runtime.sendMessage({
        target: 'sidepanel', type: 'CHAT_THINKING_END',
        payload: { sessionId: session.id },
      }).catch(() => {});
      await appendSessionMessage(session.id, {
        id: newMsgId(), role: 'agent', kind: 'text',
        text: '可以跟我说：想听什么场景的歌（"深夜写代码"）、想调整听感（"低频轻一点"）、或者"把当前列表保存成 XX"。',
        at: Date.now(),
      });
      return;
    }

    // ---- search（默认）----
    const sessionsFresh = await getSessions();
    const freshSession = sessionsFresh.find(s => s.id === session.id) || session;
    const excludeIds = (freshSession.cart || [])
      .flatMap(song => [song.id, trackKey(song)])
      .filter(id => id !== undefined && id !== null && id !== '');

    const searchResult = await runIntentSearchForChat(
      userNeed, signal, session.id, excludeIds,
      (stage, detail) => {
        chrome.runtime.sendMessage({
          target: 'sidepanel', type: 'CHAT_PROGRESS',
          payload: { sessionId: session.id, stage, detail },
        }).catch(() => {});
      }
    );

    chrome.runtime.sendMessage({
      target: 'sidepanel', type: 'CHAT_THINKING_END',
      payload: { sessionId: session.id },
    }).catch(() => {});

    if (searchResult.ok) {
      await appendSessionMessage(session.id, {
        id: newMsgId(), role: 'agent', kind: 'plan-card',
        picks: searchResult.picks,
        plan: searchResult.plan,
        stats: searchResult.stats,
        at: Date.now(),
      });
    } else {
      await appendSessionMessage(session.id, {
        id: newMsgId(), role: 'agent', kind: 'error',
        text: searchResult.error, at: Date.now(),
      });
    }
  } catch (e) {
    if (signal.aborted) return;
    console.error('[chatStart] 失败：', e);
    try {
      await appendSessionMessage(session.id, {
        id: newMsgId(), role: 'agent', kind: 'error',
        text: e?.message || String(e), at: Date.now(),
      });
    } catch {}
  } finally {
    if (currentIntentAbort === abort) currentIntentAbort = null;
  }
}

/* =====================================================
   旧入口
   ===================================================== */
async function runIntentSearch(userNeed) {
  await chrome.storage.session.set({
    [INTENT_STATE_KEY]: { status: 'running', userNeed, startedAt: Date.now(), log: [], thinking: null, plan: null, picks: null, stats: null, error: null },
  });
  const abort = new AbortController();
  currentIntentAbort = abort;
  const signal = abort.signal;
  try {
    const result = await runIntentSearchForChat(userNeed, signal, null, [], null);
    if (result.ok) {
      await setIntentState({
        status: 'done', finishedAt: Date.now(), plan: result.plan, picks: result.picks, stats: result.stats,
      });
    } else {
      await setIntentState({ status: 'error', error: result.error, finishedAt: Date.now() });
    }
  } catch (e) {
    await setIntentState({ status: 'error', error: e?.message || String(e), finishedAt: Date.now() });
  } finally {
    if (currentIntentAbort === abort) currentIntentAbort = null;
  }
}
async function runEqTuning(userNeed) {
  await chrome.storage.session.set({
    [INTENT_STATE_KEY]: { status: 'running', mode: 'eq', userNeed, startedAt: Date.now(), log: [], thinking: null, eqResult: null, error: null },
  });
  const abort = new AbortController();
  currentIntentAbort = abort;
  const signal = abort.signal;
  try {
    let currentEq = null;
    try { const r = await sendToOffscreen('EQ_GET'); if (r?.ok) currentEq = r.eq; } catch {}
    const { eq, reason } = await tuneEqWithLLM({
      userNeed, currentEq,
      onChunk: (chunk) => { appendIntentThinking('eq', chunk).catch(() => {}); },
      signal,
    });
    const applyR = await sendToOffscreen('EQ_SET', { eq });
    if (!applyR?.ok) throw new Error(applyR?.error || '应用 EQ 失败');
    await setIntentState({ status: 'done', mode: 'eq', finishedAt: Date.now(), eqResult: { eq: applyR.eq || eq, reason } });
  } catch (e) {
    await setIntentState({ status: 'error', mode: 'eq', error: e?.message || String(e), finishedAt: Date.now() });
  } finally {
    if (currentIntentAbort === abort) currentIntentAbort = null;
  }
}

/* =====================================================
   暂停页面音频
   ===================================================== */
async function pausePageAudio() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://music.163.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.querySelectorAll('audio').forEach(a => { try { a.pause(); } catch {} }),
        });
      } catch {}
    }
  } catch {}
}

/* =====================================================
   消息路由
   ===================================================== */
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  /* ============ 文件系统：状态查询 ============ */
  if (req?.action === 'fsGetStatus') {
    (async () => {
      try {
        const status = await getFsStatus();
        sendResponse({ ok: true, ...status, lastSyncAt: getLastSyncAt() });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  /* ============ 文件系统：绑定文件夹（handle 已由 options 页存到 IndexedDB）============ */
  if (req?.action === 'fsBindFolder') {
    (async () => {
      try {
        const r = await onHandleSaved();
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, reason: e?.message || String(e) });
      }
    })();
    return true;
  }

  /* ============ 文件系统：解绑 ============ */
  if (req?.action === 'fsUnbindFolder') {
    (async () => {
      try {
        const r = await unbindFolder();
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, reason: e?.message || String(e) });
      }
    })();
    return true;
  }

  /* ============ 文件系统：智能同步（自动判断方向）============ */
  if (req?.action === 'fsSyncNow') {
    (async () => {
      try {
        const r = await smartSync();
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, reason: e?.message || String(e) });
      }
    })();
    return true;
  }

  /* ============ 文件系统：强制上传（覆盖文件夹）============ */
  if (req?.action === 'fsForcePush') {
    (async () => {
      try {
        const r = await pushToFolder({ force: true, allowEmptyOverwrite: !!req.allowEmpty });
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, reason: e?.message || String(e) });
      }
    })();
    return true;
  }

  /* ============ 文件系统：从文件拉取 ============ */
  if (req?.action === 'fsPullFromFolder') {
    (async () => {
      try {
        const r = await pullFromFolder();
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, reason: e?.message || String(e) });
      }
    })();
    return true;
  }

  /* offscreen 持久化 */
  if (req?.target === 'background' && req?.type === 'PERSIST_EQ') {
    if (req.payload?.eq) chrome.storage.local.set({ currentEq: req.payload.eq }).catch(() => {});
    sendResponse({ ok: true }); return true;
  }
  if (req?.target === 'background' && req?.type === 'PERSIST_VOLUME') {
    const v = req.payload?.volume;
    if (typeof v === 'number' && Number.isFinite(v)) chrome.storage.local.set({ playerVolume: v }).catch(() => {});
    sendResponse({ ok: true }); return true;
  }
  if (req?.target === 'background' && req?.type === 'LOAD_PLAYER_STATE') {
    (async () => {
      try {
        const r = await chrome.storage.local.get(['playerVolume', 'currentEq']);
        sendResponse({
          ok: true,
          volume: typeof r.playerVolume === 'number' ? r.playerVolume : PLAYER_DEFAULTS.volume,
          eq: r.currentEq || null,
        });
      } catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
    })();
    return true;
  }
  if (req?.target === 'background' && req?.type === 'PLAYER_STATE_CHANGED') {
    chrome.runtime.sendMessage({
      target: 'sidepanel', type: 'PLAYER_STATE_CHANGED', payload: req.payload,
    }).catch(() => {});
    sendResponse({ ok: true }); return true;
  }
  if (req?.target === 'background' && typeof req?.type === 'string' && req.type.startsWith('PLAYER_')) {
    sendToOffscreen(req.type, req.payload || {})
      .then(r => sendResponse(r || { ok: true }))
      .catch(e => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }

  /* 音乐平台接口 */
  if (req?.action === 'fetchPlaylists') {
    fetchPlaylists().then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'searchSongs') {
    const keyword = String(req.keyword || '').trim();
    if (!keyword) { sendResponse({ ok: false, error: '搜索词不能为空' }); return true; }
    const limit = Number.isFinite(req.limit) ? req.limit : 30;
    const offset = Number.isFinite(req.offset) ? req.offset : 0;
    const order = req.order === 'time' ? 'time' : 'hot';
    searchSongs(keyword, limit, offset, order)
      .then(r => sendResponse({ ok: true, data: r.songs, songCount: r.songCount, keyword, order }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'deepSearch') {
    const keyword = String(req.keyword || '').trim();
    if (!keyword) { sendResponse({ ok: false, error: '搜索词不能为空' }); return true; }
    const maxPlaylists = Number.isFinite(req.maxPlaylists) ? req.maxPlaylists : 10;
    deepSearchViaPlaylists(keyword, { maxPlaylists })
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'artistAllSongs') {
    const name = String(req.artistName || '').trim();
    if (!name) { sendResponse({ ok: false, error: '歌手名不能为空' }); return true; }
    fetchArtistAllSongs(name)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  /* 保存的播放列表 */
  if (req?.action === 'listSavedPlaylists') {
    getSavedPlaylists().then(list => sendResponse({ ok: true, playlists: list }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'saveCurrentPlaylist') {
    (async () => {
      try {
        const session = await getCurrentSession();
        const songsToSave = (session?.cart && session.cart.length > 0)
          ? session.cart
          : (session?.result?.playlist || []);
        if (!songsToSave.length) {
          const r = await sendToOffscreen('PLAYER_GET_STATE');
          if (!r?.ok || !r.state?.playlist?.length) {
            sendResponse({ ok: false, error: '没有可保存的歌曲' });
            return;
          }
          const saved = await savePlaylist({ name: req.name || '未命名', songs: r.state.playlist, source: 'manual' });
          sendResponse({ ok: true, playlist: saved });
          return;
        }
        const saved = await savePlaylist({ name: req.name || '未命名', songs: songsToSave, source: 'manual' });
        sendResponse({ ok: true, playlist: saved });
      } catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
    })();
    return true;
  }
  if (req?.action === 'deleteSavedPlaylist') {
    deletePlaylist(req.id).then(list => sendResponse({ ok: true, playlists: list }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'renameSavedPlaylist') {
    renamePlaylist(req.id, req.name).then(list => sendResponse({ ok: true, playlists: list }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'playSavedPlaylist') {
    playSavedPlaylist(req.id).then(playlist => sendResponse({ ok: true, playlist }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  /* EQ 预设 */
  if (req?.action === 'listEqPresets') {
    getEqPresets().then(list => sendResponse({ ok: true, presets: list }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'saveEqPreset') {
    (async () => {
      try {
        let eq = req.eq;
        if (!eq) {
          const r = await sendToOffscreen('EQ_GET');
          if (!r?.ok || !r.eq) throw new Error('读不到当前 EQ');
          eq = r.eq;
        }
        const saved = await saveEqPreset({ name: req.name || '未命名调音', eq, source: 'manual' });
        sendResponse({ ok: true, preset: saved });
      } catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
    })();
    return true;
  }
  if (req?.action === 'deleteEqPreset') {
    deleteEqPreset(req.id).then(list => sendResponse({ ok: true, presets: list }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'renameEqPreset') {
    renameEqPreset(req.id, req.name).then(list => sendResponse({ ok: true, presets: list }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'applyEqPreset') {
    applyEqPreset(req.id).then(data => sendResponse({ ok: true, ...data }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  /* EQ 直接操作 */
  if (req?.action === 'getEqState') {
    sendToOffscreen('EQ_GET').then(r => sendResponse(r || { ok: false }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'setEqDirect') {
    sendToOffscreen('EQ_SET', { eq: req.eq }).then(r => sendResponse(r || { ok: true }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'resetEq') {
    sendToOffscreen('EQ_RESET').then(r => sendResponse(r || { ok: true }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  /* 旧入口 */
  if (req?.action === 'eqTuneStart') {
    const userNeed = String(req.userNeed || '').trim();
    if (!userNeed) { sendResponse({ ok: false, error: '需求不能为空' }); return true; }
    if (currentIntentAbort) { try { currentIntentAbort.abort(); } catch {} }
    sendResponse({ ok: true }); runEqTuning(userNeed); return true;
  }
  if (req?.action === 'intentSearchStart') {
    const userNeed = String(req.userNeed || '').trim();
    if (!userNeed) { sendResponse({ ok: false, error: '需求不能为空' }); return true; }
    if (currentIntentAbort) { try { currentIntentAbort.abort(); } catch {} }
    sendResponse({ ok: true }); runIntentSearch(userNeed); return true;
  }
  if (req?.action === 'intentSearchAbort') {
    if (currentIntentAbort) { try { currentIntentAbort.abort(); } catch {} }
    sendResponse({ ok: true }); return true;
  }
  if (req?.action === 'intentSearchGetState') {
    getIntentState().then(state => sendResponse({ ok: true, state }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'intentSearchClear') {
    chrome.storage.session.remove(INTENT_STATE_KEY).then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  /* 对话入口 */
  if (req?.action === 'chatStart') {
    const userNeed = String(req.userNeed || '').trim();
    if (!userNeed) { sendResponse({ ok: false, error: '内容为空' }); return true; }
    if (currentIntentAbort) { try { currentIntentAbort.abort(); } catch {} }
    sendResponse({ ok: true });
    runChatRequest({ userNeed, sessionId: req.sessionId, userMessageId: req.userMessageId });
    return true;
  }
  if (req?.action === 'chatAbort') {
    if (currentIntentAbort) { try { currentIntentAbort.abort(); } catch {} }
    getCurrentSession().then(session => {
      chrome.runtime.sendMessage({
        target: 'sidepanel',
        type: 'CHAT_THINKING_END',
        payload: { sessionId: session?.id, aborted: true },
      }).catch(() => {});
    }).catch(() => {});
    sendResponse({ ok: true }); return true;
  }

  /* Session */
  if (req?.action === 'listSessions') {
    getSessions().then(sessions => sendResponse({ ok: true, sessions }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'getCurrentSession') {
    getCurrentSession().then(session => sendResponse({ ok: true, session }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'createSession') {
    createSession(req.name).then(session => sendResponse({ ok: true, session }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'switchSession') {
    switchSession(req.id).then(session => sendResponse({ ok: true, session }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'deleteSession') {
    deleteSession(req.id).then(sessions => sendResponse({ ok: true, sessions }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'renameSession') {
    renameSession(req.id, req.name).then(session => sendResponse({ ok: true, session }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  /* 购物车 */
  if (req?.action === 'cartAdd') {
    cartAdd(req.sessionId, req.songs).then(r => sendResponse({ ok: true, ...r }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'cartRemove') {
    cartRemove(req.sessionId, req.songIds).then(r => sendResponse({ ok: true, ...r }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'cartReorder') {
    cartReorder(req.sessionId, req.orderedIds).then(r => sendResponse({ ok: true, ...r }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'cartClear') {
    cartClear(req.sessionId).then(r => sendResponse({ ok: true, ...r }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'cartSettle') {
    cartSettle(req.sessionId).then(r => sendResponse({ ok: true, ...r }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'cartSetEq') {
    updateSession(req.sessionId, { cartEq: req.eq || null })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'updateSessionResultSource') {
    (async () => {
      try {
        const sessions = await getSessions();
        const t = sessions.find(s => s.id === req.sessionId);
        if (!t || !t.result) throw new Error('会话或结果不存在');
        if (req.playlistSource !== undefined) t.result.playlistSource = req.playlistSource;
        if (req.eqSource !== undefined) t.result.eqSource = req.eqSource;
        await saveSessions(sessions);
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
    })();
    return true;
  }
  if (req?.action === 'restoreSession') {
    restoreSession(req.id).then(data => sendResponse({ ok: true, ...data }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (req?.action === 'openEqPanel') {
    (async () => {
      try {
        let session = await getCurrentSession();
        if (!session) session = await createSession('新会话');
        const currentEq = session.cartEq || session.result?.eq || defaultEq();
        const msgId = createId('msg');
        await appendSessionMessage(session.id, {
          id: msgId, role: 'agent', kind: 'eq-card',
          eq: currentEq, reason: null, at: Date.now(),
        });
        sendResponse({ ok: true, messageId: msgId });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (req?.action === 'pausePageAudio') {
    (async () => { await pausePageAudio(); sendResponse({ ok: true }); })();
    return true;
  }
});

/* =====================================================
   监听 storage 变化 → 节流同步到文件
   ===================================================== */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const relevantKeys = ['savedPlaylists', 'eqPresets', 'chatSessions', 'currentSessionId'];
  const hit = relevantKeys.some(k => k in changes);
  if (!hit) return;
  scheduleSyncToFolder();
});

/* =====================================================
   扩展启动
   ===================================================== */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  initFs().catch(e => console.warn('[fs-sync] onInstalled initFs 失败：', e));
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  initFs().catch(e => console.warn('[fs-sync] onStartup initFs 失败：', e));
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// service worker 每次被唤醒也尝试 initFs 一次（幂等）
initFs().catch(e => console.warn('[fs-sync] initFs 失败：', e));