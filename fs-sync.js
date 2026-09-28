// =====================================================
// 文件系统同步器 v2
// 职责：把 chrome.storage.local 的数据和用户文件夹里的 JSON 双向同步
// 安全原则：
//   1. storage 为空时不覆盖文件夹
//   2. 只有在确实有会话数据时才清理旧会话文件
//   3. 智能同步：自动判断方向
// =====================================================

import {
  loadHandle, saveHandle, clearHandle,
  queryPermissionOnly, ensureSubdir,
  readJson, writeJson, fileExists, removeFile,
} from './fs-manager.js';

const APP_VERSION = '2.4.1';
const FILE_VERSION = 1;

const KEYS = {
  playlists: 'savedPlaylists',
  eqPresets: 'eqPresets',
  sessions: 'chatSessions',
  currentSessionId: 'currentSessionId',
};

let syncTimer = null;
let lastSyncAt = 0;
let syncInProgress = false;
let suppressNextChange = false;

/* ============ 状态 ============ */
export async function getFsStatus() {
  const handle = await loadHandle();
  if (!handle) return { state: 'unbound' };
  const perm = await queryPermissionOnly(handle);
  const name = handle.name || '(未知目录)';
  if (perm === 'granted') return { state: 'bound', name };
  if (perm === 'prompt') return { state: 'need-permission', name };
  return { state: 'denied', name };
}

export function getLastSyncAt() { return lastSyncAt; }

/* ============ 内部：读取文件夹元信息 ============ */
async function readFolderMeta(handle) {
  const meta = await readJson(handle, '.meta.json');
  if (!meta) return { hasData: false, meta: null };
  const hasData =
    (meta.sessionCount || 0) > 0 ||
    (meta.playlistCount || 0) > 0 ||
    (meta.eqPresetCount || 0) > 0;
  return { hasData, meta };
}

/* ============ 内部：读取 storage 概览 ============ */
async function readStorageSummary() {
  const data = await chrome.storage.local.get([
    KEYS.playlists, KEYS.eqPresets, KEYS.sessions,
  ]);
  const playlists = Array.isArray(data[KEYS.playlists]) ? data[KEYS.playlists] : [];
  const eqPresets = Array.isArray(data[KEYS.eqPresets]) ? data[KEYS.eqPresets] : [];
  const sessions = Array.isArray(data[KEYS.sessions]) ? data[KEYS.sessions] : [];
  const isEmpty = playlists.length === 0 && eqPresets.length === 0 && sessions.length === 0;
  return {
    playlists, eqPresets, sessions, isEmpty,
    counts: {
      playlists: playlists.length,
      eqPresets: eqPresets.length,
      sessions: sessions.length,
    },
  };
}

/* ============ 绑定 / 解绑 ============ */
export async function bindFolder() {
  const handle = await loadHandle();
  if (!handle) return { ok: false, reason: 'no-handle' };

  const { hasData, meta } = await readFolderMeta(handle);
  console.log('[fs-sync] bindFolder：文件夹元信息', { hasData, meta });

  if (hasData) {
    console.log('[fs-sync] 文件夹有数据 → 执行 pull');
    const r = await pullFromFolder();
    return { ok: r.ok, mode: 'pull', ...r };
  } else {
    console.log('[fs-sync] 文件夹无数据 → 执行 push');
    const r = await pushToFolder();
    return { ok: r.ok, mode: 'push', ...r };
  }
}

export async function unbindFolder() {
  await clearHandle();
  return { ok: true };
}

/* ============ pull：文件 → storage ============ */
export async function pullFromFolder() {
  const handle = await loadHandle();
  if (!handle) return { ok: false, reason: 'no-handle' };

  const errors = [];
  try {
    suppressNextChange = true;

    const playlistsData = await readJson(handle, 'playlists.json');
    const eqData = await readJson(handle, 'eq-presets.json');
    const sessionsDir = await ensureSubdir(handle, 'sessions');
    const indexData = await readJson(sessionsDir, 'index.json');

    const updates = {};

    if (Array.isArray(playlistsData?.items)) {
      updates[KEYS.playlists] = playlistsData.items;
    } else if (playlistsData !== null) {
      errors.push('playlists.json 结构异常');
    }

    if (Array.isArray(eqData?.items)) {
      updates[KEYS.eqPresets] = eqData.items;
    } else if (eqData !== null) {
      errors.push('eq-presets.json 结构异常');
    }

    if (Array.isArray(indexData?.sessions)) {
      const sessions = [];
      for (const metaItem of indexData.sessions) {
        const sessData = await readJson(sessionsDir, `${metaItem.id}.json`);
        if (sessData?.session) {
          sessions.push(sessData.session);
        } else {
          errors.push(`会话文件 ${metaItem.id}.json 缺失或损坏`);
        }
      }
      if (sessions.length > 0) updates[KEYS.sessions] = sessions;
      if (indexData.currentSessionId) updates[KEYS.currentSessionId] = indexData.currentSessionId;
    } else if (indexData !== null) {
      errors.push('sessions/index.json 结构异常');
    }

    const appliedKeys = Object.keys(updates);
    if (appliedKeys.length > 0) {
      await chrome.storage.local.set(updates);
    }

    lastSyncAt = Date.now();
    return {
      ok: true,
      pulledKeys: appliedKeys,
      counts: {
        playlists: updates[KEYS.playlists]?.length || 0,
        eqPresets: updates[KEYS.eqPresets]?.length || 0,
        sessions: updates[KEYS.sessions]?.length || 0,
      },
      warnings: errors,
    };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  } finally {
    setTimeout(() => { suppressNextChange = false; }, 300);
  }
}

/* ============ push：storage → 文件 ============ */
export async function pushToFolder(opts = {}) {
  const handle = await loadHandle();
  if (!handle) return { ok: false, reason: 'no-handle' };
  if (syncInProgress && !opts.force) return { ok: false, reason: 'in-progress' };

  // === 安全保护：storage 为空时不允许覆盖文件夹 ===
  const summary = await readStorageSummary();
  if (summary.isEmpty && !opts.allowEmptyOverwrite) {
    const { hasData } = await readFolderMeta(handle);
    if (hasData) {
      console.warn('[fs-sync] 阻止空覆盖：storage 为空，但文件夹里有数据');
      return {
        ok: false,
        reason: 'empty-would-overwrite',
        message: '当前插件数据为空，但文件夹里已有数据。为避免覆盖，已阻止同步。请先点「从文件恢复」。',
      };
    }
  }

  syncInProgress = true;
  try {
    const { playlists, eqPresets, sessions } = summary;
    const idR = await chrome.storage.local.get(KEYS.currentSessionId);
    const currentSessionId = idR[KEYS.currentSessionId] || null;

    // 1) playlists.json
    await writeJson(handle, 'playlists.json', {
      version: FILE_VERSION,
      updatedAt: Date.now(),
      items: playlists,
    });

    // 2) eq-presets.json
    await writeJson(handle, 'eq-presets.json', {
      version: FILE_VERSION,
      updatedAt: Date.now(),
      items: eqPresets,
    });

    // 3) sessions/
    const sessionsDir = await ensureSubdir(handle, 'sessions');
    const currentIds = new Set(sessions.map(s => s.id));

    // 安全保护：只在确实有会话时才清理旧文件
    if (sessions.length > 0) {
      try {
        for await (const entry of sessionsDir.values()) {
          if (entry.kind !== 'file') continue;
          if (entry.name === 'index.json') continue;
          if (!entry.name.endsWith('.json')) continue;
          const sid = entry.name.slice(0, -5);
          if (!currentIds.has(sid)) {
            await removeFile(sessionsDir, entry.name);
          }
        }
      } catch (e) {
        console.warn('[fs-sync] 清理旧会话文件失败（不影响同步）', e);
      }
    }

    // index.json
    const metas = sessions.map(s => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      songCount: s.songCount || 0,
      cartCount: Array.isArray(s.cart) ? s.cart.length : 0,
      hasEq: !!(s.cartEq || s.result?.eq),
    }));
    await writeJson(sessionsDir, 'index.json', {
      version: FILE_VERSION,
      updatedAt: Date.now(),
      currentSessionId,
      sessions: metas,
    });

    // 每个会话单独一个文件
    for (const s of sessions) {
      await writeJson(sessionsDir, `${s.id}.json`, {
        version: FILE_VERSION,
        updatedAt: Date.now(),
        session: s,
      });
    }

    // 4) .meta.json
    await writeJson(handle, '.meta.json', {
      version: FILE_VERSION,
      appVersion: APP_VERSION,
      lastSyncAt: Date.now(),
      sessionCount: sessions.length,
      playlistCount: playlists.length,
      eqPresetCount: eqPresets.length,
    });

    lastSyncAt = Date.now();
    return {
      ok: true,
      counts: {
        sessions: sessions.length,
        playlists: playlists.length,
        eqPresets: eqPresets.length,
      },
    };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  } finally {
    syncInProgress = false;
  }
}

/* ============ 智能同步：自动判断方向 ============ */
export async function smartSync() {
  const handle = await loadHandle();
  if (!handle) return { ok: false, reason: 'no-handle' };

  const summary = await readStorageSummary();
  const { hasData: folderHasData } = await readFolderMeta(handle);

  console.log('[fs-sync] smartSync 决策', {
    storageEmpty: summary.isEmpty,
    folderHasData,
  });

  // 场景 1：storage 空 + 文件夹有数据 → pull（恢复）
  if (summary.isEmpty && folderHasData) {
    const r = await pullFromFolder();
    return {
      ok: r.ok,
      direction: 'pull',
      ...r,
      message: `从文件夹恢复了 ${r.counts?.sessions || 0} 个会话、${r.counts?.playlists || 0} 个歌单、${r.counts?.eqPresets || 0} 个调音`,
    };
  }

  // 场景 2：storage 有数据 + 文件夹空 → push
  if (!summary.isEmpty && !folderHasData) {
    const r = await pushToFolder();
    return {
      ok: r.ok,
      direction: 'push',
      ...r,
      message: `已上传 ${r.counts?.sessions || 0} 个会话、${r.counts?.playlists || 0} 个歌单、${r.counts?.eqPresets || 0} 个调音`,
    };
  }

  // 场景 3：都有数据 → 默认 push（以 storage 为准）
  if (!summary.isEmpty && folderHasData) {
    const r = await pushToFolder();
    return {
      ok: r.ok,
      direction: 'push',
      ...r,
      message: `两边都有数据，以插件为准上传（${r.counts?.sessions || 0} 会话 / ${r.counts?.playlists || 0} 歌单 / ${r.counts?.eqPresets || 0} 调音）`,
    };
  }

  // 场景 4：都空
  return {
    ok: true,
    direction: 'none',
    message: '两边都没有数据',
  };
}

/* ============ 节流调度 ============ */
export function scheduleSyncToFolder() {
  if (suppressNextChange) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    const status = await getFsStatus();
    if (status.state !== 'bound') return;
    const r = await pushToFolder();
    if (!r.ok && r.reason !== 'empty-would-overwrite') {
      console.warn('[fs-sync] 定时同步失败：', r.reason);
    }
  }, 1500);
}

/* ============ 启动初始化 ============ */
export async function initFs() {
  const status = await getFsStatus();
  if (status.state === 'bound') {
    const summary = await readStorageSummary();
    if (summary.isEmpty) {
      console.log('[fs-sync] storage 为空，尝试从文件夹恢复');
      await pullFromFolder();
    } else {
      console.log('[fs-sync] storage 有数据，启动时不 pull');
    }
  }
  return status;
}

/* ============ options 页存 handle 后调用 ============ */
export async function onHandleSaved() {
  const handle = await loadHandle();
  if (!handle) return { ok: false, reason: 'no-handle' };
  const perm = await queryPermissionOnly(handle);
  if (perm !== 'granted') return { ok: false, reason: 'permission-not-granted' };
  return await bindFolder();
}