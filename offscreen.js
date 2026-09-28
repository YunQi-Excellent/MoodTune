// Offscreen 播放器：在后台独立运行，侧边栏关闭后音乐继续播放
// 同时承载 Web Audio EQ 处理
// 注意：不直接访问 chrome.storage（某些环境不可用），持久化通过 background 中继

const audioEl = document.getElementById('offscreenAudio');

/* =====================================================
   常量
   ===================================================== */
const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const DEFAULT_EQ = {
  enabled: true,
  preampDb: 0,
  bands: EQ_FREQUENCIES.map(f => ({ frequencyHz: f, gainDb: 0 }))
};

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
  volume: 0.8,
  loading: false,
  eq: null
};

// 音频图
let audioCtx = null;
let sourceNode = null;
let preampNode = null;
let filterNodes = [];
let pendingEq = null; // 音频图建立前的缓存

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
   EQ 工具函数
   ===================================================== */
function isEqValid(eq) {
  if (!eq || typeof eq !== 'object') return false;
  if (!Array.isArray(eq.bands)) return false;
  return eq.bands.length === EQ_FREQUENCIES.length;
}

function normalizeEq(eq) {
  const bands = EQ_FREQUENCIES.map(f => {
    const found = (eq.bands || []).find(b => Number(b.frequencyHz) === f);
    const raw = found ? Number(found.gainDb) : 0;
    const g = Number.isFinite(raw) ? Math.max(-12, Math.min(12, Math.round(raw))) : 0;
    return { frequencyHz: f, gainDb: g };
  });
  const preRaw = Number(eq.preampDb);
  const preampDb = Number.isFinite(preRaw) ? Math.max(-12, Math.min(3, Math.round(preRaw))) : 0;
  return {
    enabled: eq.enabled !== false,
    preampDb,
    bands
  };
}

function defaultEq() {
  return normalizeEq(DEFAULT_EQ);
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
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
  }
})();

/* =====================================================
   音频图
   ===================================================== */
async function ensureAudioGraph() {
  if (audioCtx) return;

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('[Offscreen] 浏览器不支持 AudioContext，跳过 EQ');
      return;
    }

    audioCtx = new Ctx();

    try {
      sourceNode = audioCtx.createMediaElementSource(audioEl);
    } catch (e) {
      console.warn('[Offscreen] 无法创建 MediaElementSource：', e?.message || e);
      audioCtx = null;
      return;
    }

    preampNode = audioCtx.createGain();
    preampNode.gain.value = 1;

    filterNodes = EQ_FREQUENCIES.map(freq => {
      const f = audioCtx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1;
      f.gain.value = 0;
      return f;
    });

    let node = sourceNode;
    node.connect(preampNode);
    node = preampNode;
    for (const filter of filterNodes) {
      node.connect(filter);
      node = filter;
    }
    node.connect(audioCtx.destination);

    if (pendingEq) {
      applyEqToNodes(pendingEq);
      pendingEq = null;
    }

    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (e) {
        console.warn('[Offscreen] AudioContext resume 失败：', e);
      }
    }
  } catch (e) {
    console.warn('[Offscreen] 初始化音频图失败：', e);
    audioCtx = null;
  }
}

function applyEqToNodes(eq) {
  if (!preampNode || filterNodes.length === 0) return;
  const enabled = eq.enabled !== false;

  const preampGain = enabled ? dbToGain(eq.preampDb || 0) : 1;
  preampNode.gain.value = preampGain;

  for (let i = 0; i < filterNodes.length; i++) {
    const freq = EQ_FREQUENCIES[i];
    const band = (eq.bands || []).find(b => Number(b.frequencyHz) === freq);
    const gain = enabled && band ? Number(band.gainDb) || 0 : 0;
    filterNodes[i].gain.value = gain;
  }
}

function setEq(eq) {
  const normalized = normalizeEq(eq);
  state.eq = normalized;

  if (audioCtx) {
    applyEqToNodes(normalized);
  } else {
    pendingEq = normalized;
  }

  // 通过 background 持久化（offscreen 不直接访问 chrome.storage）
  sendToBackground('PERSIST_EQ', { eq: normalized }).catch(() => {});

  broadcastState();
}

function getEq() {
  return state.eq ? { ...state.eq } : defaultEq();
}

/* =====================================================
   Wire
   ===================================================== */
function toWire() {
  return {
    playlist: state.playlist.map(s => ({
      id: s.id,
      name: s.name,
      artists: s.artists,
      album: s.album || '',
      durationMs: s.durationMs,
      cover: s.cover || '',
      link: s.link || ''
    })),
    currentIndex: state.currentIndex,
    currentSong: state.currentSong ? {
      id: state.currentSong.id,
      name: state.currentSong.name,
      artists: state.currentSong.artists,
      album: state.currentSong.album || '',
      cover: state.currentSong.cover,
      durationMs: state.currentSong.durationMs,
      link: state.currentSong.link || ''
    } : null,
    playing: state.playing,
    currentTime: state.currentTime,
    duration: state.duration,
    volume: state.volume,
    loading: state.loading,
    eq: state.eq ? { ...state.eq } : defaultEq()
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
   音频源
   ===================================================== */
function normalizeUrl(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/^http:\/\//i, 'https://');
}

async function fetchSongUrl(songId) {
  const tries = [
    `https://music.163.com/api/song/enhance/player/url/v1?ids=[${songId}]&level=exhigh&encodeType=aac`,
    `https://music.163.com/api/song/enhance/player/url?ids=[${songId}]&br=320000`,
    `https://music.163.com/api/song/enhance/player/url?ids=[${songId}]&br=128000`
  ];
  for (const url of tries) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.code === 200) {
        const item = data.data?.[0];
        if (item?.url) return normalizeUrl(item.url);
      }
    } catch {}
  }
  throw new Error('无法获取播放地址（可能是 VIP 或版权限制）');
}

/* =====================================================
   播放控制
   ===================================================== */
async function loadAndPlay(index) {
  if (index < 0 || index >= state.playlist.length) return;

  await ensureAudioGraph();

  state.currentIndex = index;
  const song = state.playlist[index];
  state.currentSong = song;
  state.loading = true;
  broadcastState();

  try {
    const url = await fetchSongUrl(song.id);
    audioEl.src = url;
    audioEl.load();
    await audioEl.play();
    state.playing = true;
    state.loading = false;
    broadcastState();
  } catch (e) {
    console.warn('[Offscreen] 播放失败：', e?.message || e);
    state.loading = false;
    state.playing = false;
    broadcastState();
    if (state.playlist.length > 1) {
      setTimeout(() => {
        if (state.currentIndex === index) {
          loadAndPlay((index + 1) % state.playlist.length);
        }
      }, 1800);
    }
  }
}

function play() {
  if (!audioEl.src) {
    if (state.currentIndex >= 0) loadAndPlay(state.currentIndex);
    else if (state.playlist.length > 0) loadAndPlay(0);
    return;
  }
  audioEl.play().then(() => {
    state.playing = true;
    broadcastState();
  }).catch(e => console.warn('[Offscreen] play 失败：', e));
}

function pause() {
  audioEl.pause();
  state.playing = false;
  broadcastState();
}

function toggle() { state.playing ? pause() : play(); }

function next() {
  if (state.playlist.length === 0) return;
  loadAndPlay((state.currentIndex + 1) % state.playlist.length);
}

function prev() {
  if (state.playlist.length === 0) return;
  if (audioEl.currentTime > 3) {
    audioEl.currentTime = 0;
    broadcastState();
    return;
  }
  loadAndPlay((state.currentIndex - 1 + state.playlist.length) % state.playlist.length);
}

function setPlaylist(songs, autoPlay = true) {
  state.playlist = Array.isArray(songs) ? songs.slice() : [];
  state.currentIndex = -1;
  state.currentSong = null;
  state.playing = false;
  state.currentTime = 0;
  state.duration = 0;
  try { audioEl.pause(); } catch {}
  audioEl.removeAttribute('src');
  audioEl.load();
  broadcastState();

  if (state.playlist.length > 0 && autoPlay) {
    loadAndPlay(0);
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
audioEl.addEventListener('ended', () => next());
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
    case 'PLAYER_NEXT': next(); sendResponse({ ok: true }); break;
    case 'PLAYER_PREV': prev(); sendResponse({ ok: true }); break;
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

    default:
      sendResponse({ ok: false, error: 'unknown type: ' + msg.type });
  }
  return true;
});