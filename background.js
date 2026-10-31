import {
  DEFAULT_PROVIDER_ID,
  EQ_CONFIG,
  SESSION_CONFIG,
} from './src/core/constants.js';
import { normalizeEffects } from './src/core/effects.js';
import { normalizeEq } from './src/core/eq.js';
import { sanitizeTrack } from './src/core/track.js';
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
import { createSoundHandlers } from './src/app/background/handlers/sound.js';
import { createEqPresetService, createPlaylistService } from './src/app/services/assets.js';
import { createMusicService } from './src/app/services/music.js';
import { createPlayerService } from './src/app/services/player.js';
import { createPlayerPreferences } from './src/app/services/preferences.js';
import { createSessionService } from './src/app/services/sessions.js';
import { createAssetStore } from './src/app/storage/assets.js';
import { EQ_PRESETS_KEY, SAVED_PLAYLISTS_KEY } from './src/app/storage/keys.js';
import { createSessionStore } from './src/app/storage/sessions.js';

import { createChatAgent } from './src/agent/chat.js';
import { createLLMClient } from './src/agent/llm.js';

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

let offscreenCreating = null;

const SAVED_PLAYLISTS_LIMIT = 100;

/** 往侧边栏推事件；侧边栏没打开时静默失败。 */
const forwardToSidepanel = (type, payload) => {
  chrome.runtime.sendMessage({ target: 'sidepanel', type, payload }).catch(() => {});
};

/* =====================================================
   平台注册表
   ===================================================== */
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
   ===================================================== */
const player = createPlayerService({
  send: (type, payload) => sendToOffscreen(type, payload),
  providers: musicProviders,
  prefs: createPlayerPreferences({ area: chrome.storage.local }),
});

const normalizeSong = song => sanitizeTrack(song, { provider: DEFAULT_PROVIDER_ID });

const sessions = createSessionService({ store: sessionsStore, player, normalizeSong });
const playlists = createPlaylistService({ store: playlistsStore, player, normalizeSong });
const eqPresets = createEqPresetService({
  store: eqPresetsStore,
  player,
  normalizeEq,
  normalizeEffects,
});
const music = createMusicService({ providers: musicProviders });

/* =====================================================
   对话 agent
   ===================================================== */
const llm = createLLMClient({ getConfig: getLLMConfig });

const chatAgent = createChatAgent({
  llm,
  providers: musicProviders,
  sessions,
  playlists,
  eqPresets,
  player,
  notify: forwardToSidepanel,
});

/* =====================================================
   大模型配置 / Offscreen
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
      if (!String(e?.message || '').includes('already')) {
        console.warn('[NeteaseTool] 创建 offscreen 失败：', e);
      }
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
   消息路由
   ===================================================== */
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
      fetchPlaylists: music.fetchPlaylists,
      searchSongs: music.searchSongs,
      deepSearch: music.deepSearch,
      artistAllSongs: music.artistAllSongs,
      pause: () => player.pauseExternal(),
    }),

    ...createPlaylistHandlers({ playlists, sessions, player }),
    ...createEqHandlers({ presets: eqPresets, player }),
    ...createSoundHandlers({ player, presets: eqPresets }),
    ...createChatHandlers({
      chat: chatAgent,
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
