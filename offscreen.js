// Offscreen 播放器：在后台独立运行，侧边栏关闭后音乐继续播放
// 同时承载 Web Audio EQ 处理
// 注意：不直接访问 chrome.storage（某些环境不可用），持久化通过 background 中继

import { DEFAULT_PROVIDER_ID, PLAYER_DEFAULTS } from './src/core/constants.js';
import { defaultEq, isEqValid, normalizeEq } from './src/core/eq.js';
import { defaultEffects, isEffectsValid, normalizeEffects } from './src/core/effects.js';
import {
  PLAYBACK_ACTIONS,
  createPlaybackNavigator,
  normalizePlaybackMode,
} from './src/core/playback.js';
import { trackKey } from './src/core/track.js';
import { createAudioGraph } from './src/app/audio/graph.js';

const audioEl = document.getElementById('offscreenAudio');

/* =====================================================
   状态
   ===================================================== */
const state = {
  playlist: [],
  currentIndex: -1,
  currentSong: null,
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: PLAYER_DEFAULTS.volume,
  loading: false,
  eq: null,
  effects: null
};

const playback = createPlaybackNavigator({ mode: PLAYER_DEFAULTS.playbackMode });

// 加载偏好是异步的；用户已经手动切过模式时，别让迟到的默认值覆盖它。
let modeChangedByUser = false;
// 播放失败后的换歌计时器：重新加载前要清掉，避免旧计时器把新歌顶掉。
let advanceTimer = null;
// 每次换歌自增；网络返回时用它判断这次加载是否已经过期。
// 快速连点下一首时，先发出的请求可能后返回，不拦住就会把新歌覆盖回旧歌。
let loadToken = 0;

// 音频图
let audioCtx = null;
let graph = null;
let pendingEq = null; // 音频图建立前的缓存
let pendingEffects = null;

/* =====================================================
   与 background 通信的辅助
   ===================================================== */
async function sendToBackground(type, payload) {
  try {
    return await chrome.runtime.sendMessage({
      target: 'background',
      type,
      payload
    });
  } catch (e) {
    console.warn(`[Offscreen] 发送 ${type} 给 background 失败：`, e?.message || e);
    return null;
  }
}

/* =====================================================
   启动时向 background 拉取初始状态
   ===================================================== */
(async () => {
  const r = await sendToBackground('LOAD_PLAYER_STATE');
  if (r?.ok) {
    if (typeof r.volume === 'number') {
      state.volume = r.volume;
      audioEl.volume = r.volume;
    }
    if (r.eq && isEqValid(r.eq)) {
      state.eq = normalizeEq(r.eq);
      pendingEq = state.eq;
    }
    if (r.effects && isEffectsValid(r.effects)) {
      state.effects = normalizeEffects(r.effects);
      pendingEffects = state.effects;
    }
    if (r.playbackMode && !modeChangedByUser) {
      playback.setMode(normalizePlaybackMode(r.playbackMode));
      broadcastState();
    }
  }
})();

/* =====================================================
   音频图
   ===================================================== */
async function ensureAudioGraph() {
  if (graph) return;

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('[Offscreen] 浏览器不支持 AudioContext，跳过 EQ 与效果链');
      return;
    }

    audioCtx = new Ctx();

    let sourceNode = null;
    try {
      sourceNode = audioCtx.createMediaElementSource(audioEl);
    } catch (e) {
      console.warn('[Offscreen] 无法创建 MediaElementSource：', e?.message || e);
      audioCtx = null;
      return;
    }

    graph = createAudioGraph({
      ctx: audioCtx,
      source: sourceNode,
      destination: audioCtx.destination
    });

    if (pendingEq) {
      graph.applyEq(pendingEq);
      pendingEq = null;
    }
    if (pendingEffects) {
      graph.applyEffects(pendingEffects);
      pendingEffects = null;
    }

    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (e) {
        console.warn('[Offscreen] AudioContext resume 失败：', e);
      }
    }
  } catch (e) {
    console.warn('[Offscreen] 初始化音频图失败：', e);
    graph = null;
    audioCtx = null;
  }
}

/** 降级：音频图没建起来时退回元素默认输出（可播但没有 EQ/效果）。 */
function applyEqToGraph(eq) {
  if (graph) {
    graph.applyEq(eq);
    return;
  }
  pendingEq = eq;
}

function applyEffectsToGraph(effects) {
  if (graph) {
    graph.applyEffects(effects);
    return;
  }
  pendingEffects = effects;
}

function setEq(eq) {
  const normalized = normalizeEq(eq);
  state.eq = normalized;
  applyEqToGraph(normalized);

  // 通过 background 持久化（offscreen 不直接访问 chrome.storage）
  sendToBackground('PERSIST_EQ', { eq: normalized }).catch(() => {});

  broadcastState();
}

function getEq() {
  return state.eq ? { ...state.eq } : defaultEq();
}

function setEffects(effects) {
  const normalized = normalizeEffects(effects);
  state.effects = normalized;
  applyEffectsToGraph(normalized);

  sendToBackground('PERSIST_EFFECTS', { effects: normalized }).catch(() => {});

  broadcastState();
}

function getEffects() {
  return state.effects ? { ...state.effects } : defaultEffects();
}

/** 自检信息：用来确认效果链真的建起来了，而不是只有 UI 状态变了。 */
function effectsDebug() {
  return {
    graph: Boolean(graph),
    context: audioCtx?.state || 'none',
    blocks: graph ? Object.keys(graph.blocks) : [],
    limiter: Boolean(graph?.limiter)
  };
}

/* =====================================================
   Wire
   ===================================================== */
function toWireSong(song) {
  const providerId = song.providerId
    ?? (song.id === undefined || song.id === null ? '' : String(song.id));

  return {
    id: song.id,
    provider: song.provider || DEFAULT_PROVIDER_ID,
    providerId,
    key: trackKey(song),
    name: song.name,
    artists: song.artists,
    album: song.album || '',
    durationMs: song.durationMs,
    cover: song.cover || '',
    link: song.link || ''
  };
}

function toWire() {
  return {
    playlist: state.playlist.map(toWireSong),
    currentIndex: state.currentIndex,
    currentSong: state.currentSong ? toWireSong(state.currentSong) : null,
    playing: state.playing,
    currentTime: state.currentTime,
    duration: state.duration,
    volume: state.volume,
    playbackMode: playback.mode,
    loading: state.loading,
    eq: state.eq ? { ...state.eq } : defaultEq(),
    effects: state.effects ? { ...state.effects } : defaultEffects()
  };
}

function broadcastState() {
  chrome.runtime.sendMessage({
    target: 'background',
    type: 'PLAYER_STATE_CHANGED',
    payload: toWire()
  }).catch(() => {});
}

/* =====================================================
   音频源：由 background / provider 解析
   ===================================================== */

/* =====================================================
   播放控制
   ===================================================== */
function clearAdvanceTimer() {
  if (advanceTimer !== null) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }
}

async function loadAndPlay(index) {
  if (index < 0 || index >= state.playlist.length) return;

  const token = ++loadToken;
  clearAdvanceTimer();
  playback.setCurrent(index);
  state.currentIndex = index;
  const song = state.playlist[index];
  state.currentSong = song;
  state.loading = true;
  broadcastState();

  await ensureAudioGraph();
  if (token !== loadToken) return;

  try {
    const resolved = await sendToBackground('PLAYER_RESOLVE_URL', { song });
    if (token !== loadToken) return;
    if (!resolved?.ok || !resolved.url) {
      throw new Error(resolved?.error || '无法获取播放地址');
    }

    audioEl.src = resolved.url;
    audioEl.load();
    await audioEl.play();
    if (token !== loadToken) return;

    state.playing = true;
    state.loading = false;
    broadcastState();
  } catch (e) {
    // 这次加载已经被后续点击/暂停取代，别用它的失败状态覆盖当前播放。
    if (token !== loadToken) return;

    console.warn('[Offscreen] 播放失败：', e?.message || e);
    state.loading = false;
    state.playing = false;
    broadcastState();
    if (state.playlist.length > 1) {
      // 按当前播放模式跳过失败曲目：顺序播放在队尾停下，随机继续下一首，
      // 单曲循环也不能反复重试同一首（所以用「手动下一首」语义）。
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (state.currentIndex !== index || token !== loadToken) return;
        const step = playback.next({ automatic: false });
        if (step.action === PLAYBACK_ACTIONS.PLAY && step.index !== index) {
          loadAndPlay(step.index);
        }
      }, 1800);
    }
  }
}

function restartCurrent() {
  if (state.currentIndex < 0) return;
  clearAdvanceTimer();

  const token = ++loadToken;
  if (!audioEl.src) {
    loadAndPlay(state.currentIndex);
    return;
  }

  try { audioEl.currentTime = 0; } catch {}
  state.currentTime = 0;
  audioEl.play().then(() => {
    if (token !== loadToken) return;
    state.playing = true;
    broadcastState();
  }).catch(e => {
    if (token !== loadToken) return;
    // 播放地址可能已过期，重新解析一次而不是卡在这一首。
    console.warn('[Offscreen] 重播失败：', e);
    loadAndPlay(state.currentIndex);
  });
}

function stopPlayback() {
  loadToken += 1;
  clearAdvanceTimer();
  try { audioEl.pause(); } catch {}
  state.playing = false;
  state.loading = false;
  if (Number.isFinite(audioEl.currentTime)) state.currentTime = audioEl.currentTime;
  broadcastState();
}

/** 把导航结果映射成音频动作；导航器本身不知道 audio 元素。 */
function performStep(step) {
  switch (step?.action) {
    case PLAYBACK_ACTIONS.PLAY:
      loadAndPlay(step.index);
      break;
    case PLAYBACK_ACTIONS.REPEAT:
    case PLAYBACK_ACTIONS.RESTART:
      restartCurrent();
      break;
    case PLAYBACK_ACTIONS.STOP:
      stopPlayback();
      break;
    default:
      break;
  }
}

function play() {
  if (!audioEl.src) {
    // 正在解析地址时再点播放，等这一轮加载完成即可，不必重复发请求。
    if (state.loading) return;
    if (state.currentIndex >= 0) loadAndPlay(state.currentIndex);
    else if (state.playlist.length > 0) loadAndPlay(playback.startIndex());
    return;
  }
  const token = loadToken;
  audioEl.play().then(() => {
    if (token !== loadToken) return;
    state.playing = true;
    broadcastState();
  }).catch(e => console.warn('[Offscreen] play 失败：', e));
}

function pause() {
  // 暂停也要作废在途的换歌请求，否则它返回后仍会自动播下一首。
  loadToken += 1;
  clearAdvanceTimer();
  audioEl.pause();
  state.playing = false;
  state.loading = false;
  broadcastState();
}

function toggle() { state.playing ? pause() : play(); }

function next() {
  if (state.playlist.length === 0) return;
  performStep(playback.next({ automatic: false }));
}

function prev() {
  if (state.playlist.length === 0) return;
  // 不再用「超过 3 秒先回到本曲开头」拦第一次点击：
  // 上一首就是上一首，避免用户要点两次才切歌。
  performStep(playback.prev());
}

function setPlaybackMode(mode) {
  modeChangedByUser = true;
  const applied = playback.setMode(normalizePlaybackMode(mode));
  sendToBackground('PERSIST_PLAYBACK_MODE', { mode: applied }).catch(() => {});
  broadcastState();
  return applied;
}

function cyclePlaybackMode() {
  modeChangedByUser = true;
  const applied = playback.cycleMode();
  sendToBackground('PERSIST_PLAYBACK_MODE', { mode: applied }).catch(() => {});
  broadcastState();
  return applied;
}

function setPlaylist(songs, autoPlay = true) {
  loadToken += 1;
  clearAdvanceTimer();
  state.playlist = Array.isArray(songs) ? songs.slice() : [];
  playback.setPlaylist(state.playlist.length);
  state.currentIndex = -1;
  state.currentSong = null;
  state.playing = false;
  state.loading = false;
  state.currentTime = 0;
  state.duration = 0;
  try { audioEl.pause(); } catch {}
  audioEl.removeAttribute('src');
  audioEl.load();
  broadcastState();

  if (state.playlist.length > 0 && autoPlay) {
    // 随机模式下新歌单从随机一首开始，而不是永远第一首。
    loadAndPlay(playback.startIndex());
  }
}

function seek(time) {
  if (!Number.isFinite(time)) return;
  try { audioEl.currentTime = time; } catch {}
}

function setVolume(v) {
  const n = Math.max(0, Math.min(1, Number(v)));
  if (!Number.isFinite(n)) return;
  state.volume = n;
  audioEl.volume = n;
  // 通过 background 持久化
  sendToBackground('PERSIST_VOLUME', { volume: n }).catch(() => {});
  broadcastState();
}

/* =====================================================
   audio 事件
   ===================================================== */
audioEl.addEventListener('play', () => { state.playing = true; broadcastState(); });
audioEl.addEventListener('pause', () => { state.playing = false; broadcastState(); });
audioEl.addEventListener('ended', () => performStep(playback.next({ automatic: true })));
audioEl.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audioEl.duration)) state.duration = audioEl.duration;
  broadcastState();
});

let lastBroadcast = 0;
audioEl.addEventListener('timeupdate', () => {
  state.currentTime = audioEl.currentTime;
  if (Number.isFinite(audioEl.duration)) state.duration = audioEl.duration;
  const now = Date.now();
  if (now - lastBroadcast > 500) {
    lastBroadcast = now;
    broadcastState();
  }
});

audioEl.addEventListener('error', () => {
  console.warn('[Offscreen] audio error', audioEl.error);
});

/* =====================================================
   消息处理
   ===================================================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  switch (msg.type) {
    case 'PLAYER_SET_PLAYLIST':
      setPlaylist(msg.payload.songs, msg.payload.autoPlay !== false);
      sendResponse({ ok: true });
      break;

    case 'PLAYER_TOGGLE': toggle(); sendResponse({ ok: true }); break;
    case 'PLAYER_PLAY': play(); sendResponse({ ok: true }); break;
    case 'PLAYER_PAUSE': pause(); sendResponse({ ok: true }); break;
    case 'PLAYER_NEXT': next(); sendResponse({ ok: true, state: toWire() }); break;
    case 'PLAYER_PREV': prev(); sendResponse({ ok: true, state: toWire() }); break;
    case 'PLAYER_SET_MODE': {
      const mode = setPlaybackMode(msg.payload?.mode);
      sendResponse({ ok: true, mode, state: toWire() });
      break;
    }
    case 'PLAYER_CYCLE_MODE': {
      const mode = cyclePlaybackMode();
      sendResponse({ ok: true, mode, state: toWire() });
      break;
    }
    case 'PLAYER_SEEK': seek(msg.payload.time); sendResponse({ ok: true }); break;
    case 'PLAYER_SET_VOLUME': setVolume(msg.payload.volume); sendResponse({ ok: true }); break;
    case 'PLAYER_GET_STATE': sendResponse({ ok: true, state: toWire() }); break;

    case 'EQ_SET':
      try {
        setEq(msg.payload.eq);
        sendResponse({ ok: true, eq: getEq() });
      } catch (e) {
        console.error('[Offscreen] EQ_SET 失败：', e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      break;

    case 'EQ_GET':
      sendResponse({ ok: true, eq: getEq() });
      break;

    case 'EQ_RESET':
      try {
        setEq(defaultEq());
        sendResponse({ ok: true, eq: getEq() });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      break;

    case 'EFFECTS_SET':
      try {
        setEffects(msg.payload?.effects);
        sendResponse({ ok: true, effects: getEffects(), debug: effectsDebug() });
      } catch (e) {
        console.error('[Offscreen] EFFECTS_SET 失败：', e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      break;

    case 'EFFECTS_GET':
      sendResponse({ ok: true, effects: getEffects(), debug: effectsDebug() });
      break;

    case 'EFFECTS_RESET':
      try {
        setEffects(defaultEffects());
        sendResponse({ ok: true, effects: getEffects() });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      break;

    default:
      sendResponse({ ok: false, error: 'unknown type: ' + msg.type });
  }
  return true;
});