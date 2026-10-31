import { EQ_FREQUENCIES } from './src/core/constants.js';
import { defaultEffects, describeEffects } from './src/core/effects.js';
import { defaultEq } from './src/core/eq.js';
import { createId } from './src/core/ids.js';
import {
  BUILTIN_SOUND_PRESETS,
  DEFAULT_SOUND_PRESET_ID,
  groupSoundPresets,
  soundSignature,
} from './src/core/sound-presets.js';

import { $, $$ } from './src/app/dom.js';
import { escapeHtml, fmtClock, fmtDate } from './src/app/sidepanel/format.js';
import { renderAgentBody, renderPlanCard } from './src/app/sidepanel/cards.js';
import { createPlayerControls } from './src/app/sidepanel/player.js';

/* ================= 工具 ================= */
const randId = (prefix = 'id') => createId(prefix);
async function sendMsg(msg) {
  try { return await chrome.runtime.sendMessage(msg); }
  catch (e) { console.warn('[sidepanel] sendMessage 失败', e); return null; }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
  }
}

/* ================= 状态 ================= */
const state = {
  currentSession: null,
  sessions: [],
  eqPresets: [],
  savedPlaylists: [],
  currentEq: null,
  currentEffects: null,
  libraryTab: 'sound',
  messageNodes: new Map(),
  thinkingRecords: [],
  running: false,
};

/* ================= Header ================= */
$('#sessionBtn').addEventListener('click', openSessionDrawer);
$('#cartBtn').addEventListener('click', openCartDrawer);
$('#libraryBtn').addEventListener('click', () => openLibraryDrawer());
$('#logBtn').addEventListener('click', openLogDrawer);
$('#themeBtn').addEventListener('click', toggleTheme);
$('#settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function refreshModelBadge() {
  try {
    const { llmConfig } = await chrome.storage.local.get('llmConfig');
    const badge = $('#modelBadge');
    const nameEl = $('#modelName');
    if (llmConfig && llmConfig.model) {
      nameEl.textContent = llmConfig.model;
      badge.classList.remove('off');
      badge.title = `${llmConfig.model}\n${llmConfig.endpoint}`;
    } else {
      nameEl.textContent = '未配置';
      badge.classList.add('off');
      badge.title = '尚未配置大模型';
    }
  } catch {}
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.llmConfig) refreshModelBadge();
});

/* ================= Session 抽屉 ================= */
function openSessionDrawer() {
  $('#session-drawer').classList.add('open');
  $('#backdrop').classList.add('show');
  refreshSessions();
}
function closeSessionDrawer() {
  $('#session-drawer').classList.remove('open');
  $('#backdrop').classList.remove('show');
}
$('#closeSessionDrawer').addEventListener('click', closeSessionDrawer);

async function refreshSessions() {
  const r = await sendMsg({ action: 'listSessions' });
  if (!r?.ok) return;
  state.sessions = r.sessions;
  renderSessionList();
}
function renderSessionList() {
  const el = $('#sessionList');
  if (!state.sessions.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--fg-3);font-size:12px;padding:30px 0;">还没有会话</div>';
    return;
  }
  const currentId = state.currentSession?.id;
  el.innerHTML = state.sessions.map(s => {
    const active = s.id === currentId ? ' active' : '';
    const count = s.messages?.length || 0;
    const cartCount = Array.isArray(s.cart) ? s.cart.length : 0;
    const resultCount = s.result?.playlist?.length || 0;
    const hasResult = !!(s.result || (s.eq || s.playlistSnapshot));
    const hasEq = (s.result?.eq || s.cartEq) ? '🎛' : '';
    const cartHint = cartCount > 0 ? `· 🎵${cartCount}` : '';
    const resultHint = resultCount > 0 ? `· 结算${resultCount}` : '';
    const restoreBtn = hasResult
      ? `<button data-act="restore" data-id="${s.id}" class="primary">↺ 恢复</button>`
      : '';
    return `
      <div class="session-item${active}" data-id="${s.id}">
        <div class="row">
          <div class="name">${escapeHtml(s.name)}</div>
          ${active ? '<span class="badge">当前</span>' : ''}
        </div>
        <div class="meta">${count} 条 ${hasEq} ${cartHint} ${resultHint} · ${escapeHtml(fmtDate(s.lastActiveAt))}</div>
        <div class="actions">
          ${restoreBtn}
          <button data-act="switch" data-id="${s.id}">切换</button>
          <button data-act="rename" data-id="${s.id}">改名</button>
          <button data-act="delete" data-id="${s.id}" class="danger">删除</button>
        </div>
      </div>
    `;
  }).join('');
}
$('#sessionList').addEventListener('click', async e => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const id = item.getAttribute('data-id');
  const btn = e.target.closest('button');
  const act = btn?.getAttribute('data-act');

  if (act === 'restore') {
    btn.disabled = true; btn.textContent = '恢复中…';
    try {
      const r = await sendMsg({ action: 'restoreSession', id });
      if (r?.ok) {
        pushLog('ok', `已恢复会话：${(r.messages || []).join(' · ')}`);
        const sw = await sendMsg({ action: 'switchSession', id });
        if (sw?.ok) {
          state.currentSession = sw.session;
          state.messageNodes.clear();
          state.thinkingRecords.forEach(rec => rec.timer && clearInterval(rec.timer));
          state.thinkingRecords.length = 0;
          renderCurrentSession();
          updateHeaderSessionName();
          updateCartUI();
        }
        closeSessionDrawer();
        player.refresh();
      } else {
        pushLog('err', '恢复失败：' + (r?.error || '未知'));
      }
    } catch (err) {
      pushLog('err', '恢复失败：' + (err?.message || err));
    }
    btn.disabled = false; btn.textContent = '↺ 恢复';
    return;
  }
  if (act === 'switch') {
    const r = await sendMsg({ action: 'switchSession', id });
    if (r?.ok) {
      state.currentSession = r.session;
      state.messageNodes.clear();
      state.thinkingRecords.forEach(rec => rec.timer && clearInterval(rec.timer));
      state.thinkingRecords.length = 0;
      closeSessionDrawer();
      renderCurrentSession();
      updateHeaderSessionName();
      updateCartUI();
    }
    return;
  }
  if (act === 'rename') {
    const name = prompt('新名字：', item.querySelector('.name').textContent);
    if (name?.trim()) {
      await sendMsg({ action: 'renameSession', id, name: name.trim() });
      refreshSessions();
      if (id === state.currentSession?.id) {
        const r = await sendMsg({ action: 'getCurrentSession' });
        if (r?.ok) { state.currentSession = r.session; updateHeaderSessionName(); }
      }
    }
    return;
  }
  if (act === 'delete') {
    if (!confirm('确定删除这个会话？')) return;
    await sendMsg({ action: 'deleteSession', id });
    refreshSessions();
    const r = await sendMsg({ action: 'getCurrentSession' });
    if (r?.ok) {
      state.currentSession = r.session;
      state.messageNodes.clear();
      state.thinkingRecords.forEach(rec => rec.timer && clearInterval(rec.timer));
      state.thinkingRecords.length = 0;
      updateHeaderSessionName();
      renderCurrentSession();
      updateCartUI();
    }
  }
});

$('#newSessionBtn').addEventListener('click', async () => {
  const name = prompt('会话名（可留空）：', '');
  if (name === null) return;
  const r = await sendMsg({ action: 'createSession', name: name.trim() || '新会话' });
  if (r?.ok) {
    state.currentSession = r.session;
    state.messageNodes.clear();
    state.thinkingRecords.forEach(rec => rec.timer && clearInterval(rec.timer));
    state.thinkingRecords.length = 0;
    closeSessionDrawer();
    renderCurrentSession();
    updateHeaderSessionName();
    updateCartUI();
  }
});

/* ================= 会话歌单 抽屉 ================= */
function openCartDrawer() {
  $('#cart-drawer').classList.add('open');
  $('#backdrop').classList.add('show');
  renderCartList();
}
function closeCartDrawer() {
  $('#cart-drawer').classList.remove('open');
  $('#backdrop').classList.remove('show');
}
$('#closeCartDrawer').addEventListener('click', closeCartDrawer);

function updateCartUI() {
  const cart = state.currentSession?.cart || [];
  const count = cart.length;
  const badge = $('#cartBadge');
  const btn = $('#cartBtn');

  if (count > 0) {
    badge.textContent = `+${count}`;
    badge.classList.remove('hidden');
    btn.classList.add('has-items');
  } else {
    badge.classList.add('hidden');
    btn.classList.remove('has-items');
  }

  $('#cartHeaderCount').textContent = `${count} 首`;
  $('#cartTotalCount').textContent = count;
  $('#cartSettleBtn').disabled = count === 0;

  if ($('#cart-drawer').classList.contains('open')) renderCartList();
}

function renderCartList() {
  const cart = state.currentSession?.cart || [];
  const el = $('#cartList');
  if (cart.length === 0) {
    el.innerHTML = `
      <div style="text-align:center;color:var(--fg-3);font-size:12px;padding:40px 20px;line-height:1.8;">
        会话歌单是空的<br>
        <span style="font-size:11px;">AI 给出候选后，点「加入歌单」把想听的留下<br>再让 AI 继续检索，会避开已有的歌</span>
      </div>`;
    return;
  }
  el.innerHTML = cart.map((s, i) => `
    <div class="cart-item" draggable="true" data-id="${s.id}" data-index="${i}">
      <span class="handle">⋮⋮</span>
      ${s.cover ? `<img class="cover" src="${escapeHtml(s.cover)}" loading="lazy" alt="">` : '<div class="cover"></div>'}
      <div class="info">
        <div class="title">${escapeHtml(s.name)}</div>
        <div class="artist">${escapeHtml(s.artists)}</div>
      </div>
      <button class="remove" data-remove="${s.id}" title="移除">✕</button>
    </div>
  `).join('');
}

function refreshPlanCards() {
  const messages = state.currentSession?.messages || [];
  for (const m of messages) {
    if (m.kind !== 'plan-card') continue;
    const node = state.messageNodes.get(m.id);
    if (!node) continue;
    const body = node.querySelector('.body');
    if (!body) continue;
    const cartIds = new Set((state.currentSession?.cart || []).map(song => song.id));
    body.innerHTML = renderPlanCard(m, { cartIds });
  }
}

$('#cartList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const id = Number(btn.getAttribute('data-remove'));
  if (!Number.isFinite(id)) return;
  const r = await sendMsg({ action: 'cartRemove', sessionId: state.currentSession.id, songIds: [id] });
  if (r?.ok) {
    state.currentSession.cart = (state.currentSession.cart || []).filter(s => s.id !== id);
    renderCartList();
    updateCartUI();
    refreshPlanCards();
  }
});

let dragSrcId = null;
$('#cartList').addEventListener('dragstart', e => {
  const item = e.target.closest('.cart-item');
  if (!item) return;
  dragSrcId = Number(item.getAttribute('data-id'));
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
$('#cartList').addEventListener('dragend', e => {
  const item = e.target.closest('.cart-item');
  if (item) item.classList.remove('dragging');
  document.querySelectorAll('.cart-item.drag-over').forEach(el => el.classList.remove('drag-over'));
});
$('#cartList').addEventListener('dragover', e => {
  e.preventDefault();
  const item = e.target.closest('.cart-item');
  if (!item) return;
  document.querySelectorAll('.cart-item.drag-over').forEach(el => {
    if (el !== item) el.classList.remove('drag-over');
  });
  item.classList.add('drag-over');
});
$('#cartList').addEventListener('drop', async e => {
  e.preventDefault();
  const item = e.target.closest('.cart-item');
  if (!item || dragSrcId === null) return;
  const targetId = Number(item.getAttribute('data-id'));
  if (targetId === dragSrcId) return;

  const cart = state.currentSession.cart || [];
  const srcIdx = cart.findIndex(s => s.id === dragSrcId);
  const dstIdx = cart.findIndex(s => s.id === targetId);
  if (srcIdx < 0 || dstIdx < 0) return;

  const next = [...cart];
  const [moved] = next.splice(srcIdx, 1);
  next.splice(dstIdx, 0, moved);

  state.currentSession.cart = next;
  renderCartList();
  updateCartUI();

  await sendMsg({
    action: 'cartReorder',
    sessionId: state.currentSession.id,
    orderedIds: next.map(s => s.id),
  });
  dragSrcId = null;
});

$('#cartClearBtn').addEventListener('click', async () => {
  if (!state.currentSession) return;
  const cart = state.currentSession.cart || [];
  if (cart.length === 0) return;
  if (!confirm(`清空会话歌单（${cart.length} 首）？`)) return;
  const r = await sendMsg({ action: 'cartClear', sessionId: state.currentSession.id });
  if (r?.ok) {
    state.currentSession.cart = [];
    renderCartList();
    updateCartUI();
    refreshPlanCards();
  }
});

$('#cartSettleBtn').addEventListener('click', async () => {
  if (!state.currentSession) return;
  const btn = $('#cartSettleBtn');
  btn.disabled = true; btn.textContent = '加载中…';
  try {
    const r = await sendMsg({ action: 'cartSettle', sessionId: state.currentSession.id });
    if (r?.ok) {
      pushLog('ok', `已替换播放队列并开始播放 ${r.count} 首`);
      const fresh = await sendMsg({ action: 'getCurrentSession' });
      if (fresh?.ok) {
        state.currentSession = fresh.session;
        updateCartUI();
      }
      closeCartDrawer();
      player.refresh();
    } else {
      pushLog('err', '结算失败：' + (r?.error || '未知'));
    }
  } catch (e) {
    pushLog('err', '结算失败：' + (e?.message || e));
  } finally {
    btn.disabled = false; btn.textContent = '替换播放并开始';
  }
});

/* ================= 我的内容 抽屉 ================= */
/** @param {'sound'|'eq'|'playlists'} [tab] 指定打开时停在哪一页 */
function openLibraryDrawer(tab) {
  if (typeof tab === 'string') {
    state.libraryTab = tab;
    $$('.lib-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-lib') === tab));
  }
  $('#library-drawer').classList.add('open');
  $('#backdrop').classList.add('show');
  refreshLibrary();
}
function closeLibraryDrawer() {
  $('#library-drawer').classList.remove('open');
  $('#backdrop').classList.remove('show');
}
$('#closeLibraryDrawer').addEventListener('click', closeLibraryDrawer);

$$('.lib-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.libraryTab = tab.getAttribute('data-lib');
    $$('.lib-tab').forEach(t => t.classList.toggle('active', t === tab));
    refreshLibrary();
  });
});

async function refreshLibrary() {
  const wantsSoundState = state.libraryTab === 'sound';
  const [eqR, plR, soundR] = await Promise.all([
    sendMsg({ action: 'listEqPresets' }),
    sendMsg({ action: 'listSavedPlaylists' }),
    wantsSoundState
      ? Promise.all([
        sendMsg({ action: 'getEqState' }),
        sendMsg({ action: 'getEffectsState' }),
      ])
      : Promise.resolve(null),
  ]);
  state.eqPresets = eqR?.presets || [];
  state.savedPlaylists = plR?.playlists || [];
  $('#eqCount').textContent = state.eqPresets.length;
  $('#plCount').textContent = state.savedPlaylists.length;

  if (soundR) {
    const [eqState, effectsState] = soundR;
    state.currentEq = eqState?.ok ? eqState.eq : null;
    state.currentEffects = effectsState?.ok ? effectsState.effects : null;
  }

  renderLibraryBody();
}

/** 当前生效的音效（用状态指纹匹配，手动拧过滑块会自动失去「使用中」）。 */
function currentSoundPreset() {
  if (!state.currentEq) return null;
  const signature = soundSignature({ eq: state.currentEq, effects: state.currentEffects });
  return BUILTIN_SOUND_PRESETS.find(
    preset => soundSignature({ eq: preset.eq, effects: preset.effects }) === signature,
  ) || null;
}

function renderLibraryBody() {
  const body = $('#libraryBody');

  if (state.libraryTab === 'sound') {
    const active = currentSoundPreset();

    const sections = groupSoundPresets().map((section) => {
      const cards = section.presets.map((preset) => {
        const isActive = active?.id === preset.id;
        const usesEffects = Object.values(preset.effects || {}).some(
          block => block && block.enabled === true,
        );
        const meta = `${preset.tagline || ''}${usesEffects ? ' · 含效果链' : ''}`;
        return `
          <button class="sound-card${isActive ? ' active' : ''}"
                  data-sound-id="${escapeHtml(preset.id)}"
                  data-accent="${escapeHtml(preset.accent || 'slate')}">
            <span class="sound-name">${escapeHtml(preset.name)}</span>
            <span class="sound-tag">${escapeHtml(meta)}</span>
            ${isActive ? '<span class="sound-state">使用中</span>' : ''}
          </button>
        `;
      }).join('');

      return `
        <div class="sound-group">
          <div class="sound-group-title">${escapeHtml(section.group)}</div>
          <div class="sound-grid">${cards}</div>
        </div>
      `;
    }).join('');

    const hint = !state.currentEq
      ? ''
      : active
        ? `当前：${escapeHtml(active.name)}`
        : '当前：自定义（在预设基础上手动调过）';

    const chain = describeEffects(state.currentEffects);
    const chainLabel = chain.length ? chain.join(' · ') : '关闭（只走 EQ）';

    body.innerHTML = `
      <div class="sound-intro">点一下就整套切换：EQ + 空间效果。切换后仍然可以拖动 EQ 滑杆微调。</div>
      <div class="sound-chain">效果链：${escapeHtml(chainLabel)}</div>
      ${sections}
      ${hint ? `<div class="sound-hint">${hint}</div>` : ''}
    `;
    return;
  }

  if (state.libraryTab === 'eq') {
    if (!state.eqPresets.length) {
      body.innerHTML = '<div style="text-align:center;color:var(--fg-3);font-size:12px;padding:30px 0;">还没有保存的调音<br><span style="font-size:11px;">跟 Agent 说「把这套调音存成 XX」</span></div>';
      return;
    }
    body.innerHTML = state.eqPresets.map(p => {
      const bandCount = (p.eq?.bands || []).filter(b => Math.abs(Number(b.gainDb)) > 0.01).length;
      const chainCount = describeEffects(p.effects).length;
      const chainHint = chainCount > 0 ? ' · 含效果链' : '';
      const srcLabel = p.source === 'llm' ? 'AI 调音' : '手动保存';
      return `
        <div class="lib-item" data-id="${p.id}">
          <div class="row">
            <div class="name">${escapeHtml(p.name)}</div>
          </div>
          <div class="meta">${bandCount} 段调整 · 前级 ${p.eq?.preampDb || 0}dB${chainHint} · ${escapeHtml(srcLabel)} · ${escapeHtml(fmtDate(p.createdAt))}</div>
          <div class="actions">
            <button data-act="apply" data-id="${p.id}" class="primary">应用到当前</button>
            <button data-act="rename" data-id="${p.id}">改名</button>
            <button data-act="delete" data-id="${p.id}" class="danger">删除</button>
          </div>
        </div>
      `;
    }).join('');
  } else {
    if (!state.savedPlaylists.length) {
      body.innerHTML = '<div style="text-align:center;color:var(--fg-3);font-size:12px;padding:30px 0;">还没有保存的播放列表<br><span style="font-size:11px;">会话歌单结算后，可跟 Agent 说「把当前列表存成 XX」</span></div>';
      return;
    }
    body.innerHTML = state.savedPlaylists.map(p => {
      const count = p.songs?.length || 0;
      const srcLabel = p.source === 'llm' ? 'AI 保存' : '手动保存';
      return `
        <div class="lib-item" data-id="${p.id}">
          <div class="row">
            <div class="name">${escapeHtml(p.name)}</div>
          </div>
          <div class="meta">${count} 首 · ${escapeHtml(srcLabel)} · ${escapeHtml(fmtDate(p.createdAt))}</div>
          <div class="actions">
            <button data-act="load-to-cart" data-id="${p.id}" class="primary">加入会话歌单</button>
            <button data-act="play" data-id="${p.id}">直接播放</button>
            <button data-act="rename" data-id="${p.id}">改名</button>
            <button data-act="delete" data-id="${p.id}" class="danger">删除</button>
          </div>
        </div>
      `;
    }).join('');
  }
}

/** 套用一个内置音效：EQ + 效果链一起落盘。 */
async function applySoundPresetCard(card) {
  const id = card.getAttribute('data-sound-id');
  const preset = BUILTIN_SOUND_PRESETS.find(item => item.id === id);
  if (!preset) return;

  card.classList.add('applying');
  const response = await sendMsg({ action: 'applySoundPreset', id });
  card.classList.remove('applying');

  if (!response?.ok) {
    pushLog('err', '切换音效失败：' + (response?.error || '未知'));
    return;
  }

  state.currentEq = response.eq || state.currentEq;
  state.currentEffects = response.effects || state.currentEffects;

  if (state.currentSession && response.eq) {
    await sendMsg({ action: 'cartSetEq', sessionId: state.currentSession.id, eq: response.eq });
  }

  pushLog('ok', `已切换到「${preset.name}」${describeChainSuffix(response.effects)}`);
  renderLibraryBody();
}

/** 日志里补一句效果链，方便确认「到底有没有生效」。 */
function describeChainSuffix(effects) {
  const chain = describeEffects(effects || state.currentEffects);
  return chain.length ? `（${chain.join(' · ')}）` : '（只走 EQ）';
}

$('#libraryBody').addEventListener('click', async e => {
  const soundCard = e.target.closest('[data-sound-id]');
  if (soundCard) {
    await applySoundPresetCard(soundCard);
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  const id = btn.getAttribute('data-id');

  if (state.libraryTab === 'eq') {
    if (act === 'apply') {
      btn.disabled = true; btn.textContent = '应用中…';
      const r = await sendMsg({ action: 'applyEqPreset', id });
      if (r?.ok) {
        if (state.currentSession) {
          await sendMsg({ action: 'cartSetEq', sessionId: state.currentSession.id, eq: r.eq });
        }
        pushLog('ok', '已应用调音');
      } else {
        pushLog('err', '应用失败：' + (r?.error || '未知'));
      }
      btn.disabled = false; btn.textContent = '应用到当前';
      return;
    }
    if (act === 'rename') {
      const p = state.eqPresets.find(x => x.id === id);
      if (!p) return;
      const name = prompt('新名字：', p.name);
      if (!name?.trim()) return;
      await sendMsg({ action: 'renameEqPreset', id, name: name.trim() });
      refreshLibrary();
      return;
    }
    if (act === 'delete') {
      const p = state.eqPresets.find(x => x.id === id);
      if (!p) return;
      if (!confirm(`确定删除调音「${p.name}」？`)) return;
      await sendMsg({ action: 'deleteEqPreset', id });
      refreshLibrary();
    }
    return;
  }

  if (act === 'load-to-cart') {
    const p = state.savedPlaylists.find(x => x.id === id);
    if (!p || !state.currentSession) return;
    btn.disabled = true; btn.textContent = '加入中…';
    const r = await sendMsg({
      action: 'cartAdd',
      sessionId: state.currentSession.id,
      songs: p.songs || [],
    });
    if (r?.ok) {
      pushLog('ok', `已加入 ${r.added} 首到会话歌单`);
      const fresh = await sendMsg({ action: 'getCurrentSession' });
      if (fresh?.ok) {
        state.currentSession = fresh.session;
        updateCartUI();
        refreshPlanCards();
      }
    } else {
      pushLog('err', '加入失败：' + (r?.error || '未知'));
    }
    btn.disabled = false; btn.textContent = '加入会话歌单';
    return;
  }

  if (act === 'play') {
    btn.disabled = true; btn.textContent = '加载中…';
    try {
      await sendMsg({ action: 'pausePageAudio' });
      const r = await sendMsg({ action: 'playSavedPlaylist', id });
      if (r?.ok) pushLog('ok', `开始播放「${r.playlist.name}」`);
      else pushLog('err', '播放失败：' + (r?.error || '未知'));
    } catch (err) {
      pushLog('err', '播放失败：' + (err?.message || err));
    }
    btn.disabled = false; btn.textContent = '直接播放';
    return;
  }
  if (act === 'rename') {
    const p = state.savedPlaylists.find(x => x.id === id);
    if (!p) return;
    const name = prompt('新名字：', p.name);
    if (!name?.trim()) return;
    await sendMsg({ action: 'renameSavedPlaylist', id, name: name.trim() });
    refreshLibrary();
    return;
  }
  if (act === 'delete') {
    const p = state.savedPlaylists.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`确定删除「${p.name}」？`)) return;
    await sendMsg({ action: 'deleteSavedPlaylist', id });
    refreshLibrary();
  }
});

/* ================= 日志抽屉 ================= */
const logs = [];
function pushLog(level, text) {
  logs.push({ level, text, at: Date.now() });
  if (logs.length > 300) logs.shift();
  if ($('#log-drawer').classList.contains('open')) renderLogs();
}
function renderLogs() {
  const el = $('#logContent');
  el.innerHTML = logs.map(l => `
    <div class="log-line">
      <span class="log-time">${fmtClock(l.at)}</span>
      <span class="log-level-${l.level}">${escapeHtml(l.text)}</span>
    </div>
  `).join('');
  el.scrollTop = el.scrollHeight;
}
function openLogDrawer() {
  $('#log-drawer').classList.add('open');
  $('#backdrop').classList.add('show');
  renderLogs();
}
function closeLogDrawer() {
  $('#log-drawer').classList.remove('open');
  $('#backdrop').classList.remove('show');
}
$('#closeLogDrawer').addEventListener('click', closeLogDrawer);
$('#copyLogsBtn').addEventListener('click', async () => {
  const text = logs.map(l => `[${fmtClock(l.at)}] [${l.level}] ${l.text}`).join('\n');
  await copyText(text);
  pushLog('ok', '已复制日志');
});

/* ================= 工具箱 ================= */
function openDock() {
  $('#dock-drawer').classList.add('open');
  $('#backdrop').classList.add('show');
}
function closeDock() {
  $('#dock-drawer').classList.remove('open');
  $('#backdrop').classList.remove('show');
}
$('#dockToggle').addEventListener('click', openDock);
$('#closeDockBtn').addEventListener('click', closeDock);

$('#dock-drawer').addEventListener('click', async e => {
  const item = e.target.closest('.dock-item');
  if (!item) return;
  const dock = item.getAttribute('data-dock');
  closeDock();

  if (dock === 'sound') {
    openLibraryDrawer('sound');
    return;
  }
  if (dock === 'eq') {
    const r = await sendMsg({ action: 'openEqPanel' });
    if (!r?.ok) {
      pushLog('err', '打开调音台失败：' + (r?.error || '未知'));
    }
    return;
  }
  if (dock === 'save-list') { $('#userInput').value = '把会话歌单保存成一个歌单'; $('#userInput').focus(); return; }
  if (dock === 'save-eq') { $('#userInput').value = '把当前调音保存下来'; $('#userInput').focus(); return; }
  if (dock === 'search-artist') {
    const ar = prompt('歌手名：');
    if (ar) { $('#userInput').value = `拉取 ${ar} 的全部歌曲`; sendChat(); }
    return;
  }
  if (dock === 'my-playlists') { $('#userInput').value = '从我的歌单里挑一些歌'; $('#userInput').focus(); return; }
  if (dock === 'scan') { $('#userInput').value = '拉取我全部歌单里的歌曲，作为候选'; sendChat(); return; }
});

/* ================= 主渲染 (严密的 Git 树状态流) ================= */
function renderCurrentSession() {
  const stream = $('#chatStream');
  stream.innerHTML = '';
  state.messageNodes.clear();
  state.thinkingRecords.forEach(rec => rec.timer && clearInterval(rec.timer));
  state.thinkingRecords.length = 0;

  if (!state.currentSession) {
    stream.innerHTML = `
      <div class="empty-chat" id="emptyChat">
        <div class="big-icon">🎵</div>
        <div class="hint">对我说出你想听的场景，或者让我调整听感。<br>试试 <code>深夜写代码的歌</code><br><code>低频再轻一点</code></div>
      </div>`;
    return;
  }
  const messages = state.currentSession.messages || [];
  if (messages.length === 0) {
    stream.innerHTML = `
      <div class="empty-chat" id="emptyChat">
        <div class="big-icon">✨</div>
        <div class="hint">新会话已就绪。试试说<br><code>来点有节奏感的歌</code><br><code>人声更清晰一点</code></div>
      </div>`;
    return;
  }
  for (const m of messages) appendMessageNode(m);
  scrollToBottom();
}
function removeEmptyChat() {
  const empty = $('#emptyChat');
  if (empty) empty.remove();
}

function appendMessageNode(m, { animate = false } = {}) {
  if (!m || !m.id) return;
  if (state.messageNodes.has(m.id)) return;
  const stream = $('#chatStream');
  removeEmptyChat();
  const node = document.createElement('div');
  node.setAttribute('data-msg-id', m.id);

  if (m.role === 'user') {
    node.className = 'msg-user';
    // 用户节点：主轴线 X=10px，主干圆点 X=4px，卡片靠左展宽
    node.innerHTML = `
      <div class="user-track">
        <div class="git-trunk-line"></div>
        <div class="git-trunk-dot"></div>
      </div>
      <div class="bubble">
        <div class="user-meta">
          <span class="tag">// USER_INTENT</span>
          <span>${fmtClock(m.at)}</span>
        </div>
        <div class="text">${escapeHtml(m.text)}</div>
      </div>`;
  } else if (m.role === 'agent') {
    // 状态检测：查找前一个消息节点，若前一个是用户消息，则本条必须平滑分叉！
    const msgNodes = [...stream.children].filter(el => el.classList.contains('msg-user') || el.classList.contains('msg-agent'));
    const lastNode = msgNodes[msgNodes.length - 1];
    const isBranchStart = !lastNode || lastNode.classList.contains('msg-user');

    node.className = `msg-agent ${m.kind || ''}${isBranchStart ? ' branch-start' : ''}`;
    const cartIds = new Set((state.currentSession?.cart || []).map(song => song.id));
    const body = renderAgentBody(m, { cartIds });
    
    // AI 节点：46px 轨道，分支线 X=32px，卡片向右深度缩进 22px
    node.innerHTML = `
      <div class="agent-track">
        <div class="git-trunk-line"></div>
        ${isBranchStart ? `
          <svg class="git-branch-curve" viewBox="0 0 46 32">
            <path d="M 11.5 -8 C 11.5 8, 33.5 4, 33.5 16" fill="none" stroke="var(--brand-500)" stroke-width="3" stroke-linecap="round"/>
          </svg>
        ` : ''}
        <div class="git-branch-line"></div>
        <div class="git-branch-dot"></div>
      </div>
      <div class="body">${body}</div>`;
  }
  stream.appendChild(node);
  state.messageNodes.set(m.id, node);
  if (animate) scrollToBottom();
}

/* ================= 卡片交互 ================= */
/** 把一张 EQ 卡片的滑杆同步成给定 EQ。 */
function syncEqCardInputs(msgId, eq) {
  const node = state.messageNodes.get(msgId);
  if (!node) return;

  const preamp = Number(eq?.preampDb) || 0;
  const preampInput = node.querySelector('[data-eq-band="preamp"]');
  if (preampInput) {
    preampInput.value = preamp;
    const val = preampInput.parentElement.querySelector('.value');
    if (val) val.textContent = `${preamp > 0 ? '+' : ''}${preamp} dB`;
  }

  for (const frequency of EQ_FREQUENCIES) {
    const band = (eq?.bands || []).find(item => Number(item.frequencyHz) === frequency);
    const gain = Number(band?.gainDb) || 0;
    const input = node.querySelector(`[data-eq-band="${frequency}"]`);
    if (!input) continue;
    input.value = gain;
    const val = input.parentElement.querySelector('.value');
    if (val) val.textContent = `${gain > 0 ? '+' : ''}${gain} dB`;
  }

  const badge = node.querySelector('.eq-header .badge:last-child');
  if (badge) badge.textContent = `${preamp > 0 ? '+' : ''}${preamp} dB 前级`;
}

$('#chatStream').addEventListener('click', async e => {
  const toggle = e.target.closest('.thinking-toggle');
  if (toggle) {
    const tid = toggle.getAttribute('data-toggle');
    const content = document.querySelector(`.thinking-content[data-content="${tid}"]`);
    if (content) { toggle.classList.toggle('open'); content.classList.toggle('open'); }
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-action');

  if (action === 'open-sound-library') {
    openLibraryDrawer('sound');
    return;
  }

  const msgId = btn.getAttribute('data-msg-id');
  const msg = (state.currentSession?.messages || []).find(x => x.id === msgId);
  if (!msg) return;

  if (action === 'add-to-cart') {
    const picks = msg.picks || [];
    const node = state.messageNodes.get(msgId);
    const checkedIds = new Set(
      [...node.querySelectorAll('.track-cb:checked')].map(cb => Number(cb.getAttribute('data-track-id')))
    );
    const selected = picks.filter(p => checkedIds.has(p.id));
    if (selected.length === 0) { pushLog('err', '没有选中任何歌曲'); return; }
    btn.disabled = true; btn.textContent = '加入中…';
    try {
      const r = await sendMsg({
        action: 'cartAdd',
        sessionId: state.currentSession.id,
        songs: selected,
      });
      if (!r?.ok) throw new Error(r?.error || '加入失败');
      pushLog('ok', `加入会话歌单 ${r.added} 首（共 ${r.total} 首）`);
      const fresh = await sendMsg({ action: 'getCurrentSession' });
      if (fresh?.ok) {
        state.currentSession = fresh.session;
        updateCartUI();
        refreshPlanCards();
      }
    } catch (err) {
      pushLog('err', '加入失败：' + (err?.message || err));
    } finally {
      btn.disabled = false; btn.textContent = '🎵 加入歌单';
    }
    return;
  }

  if (action === 'reset-eq-card') {
    // 重置 = 回到「原声」：EQ 清零，效果链也要一并退出，
    // 否则空间处理会留在链上，听感和 UI 都会对不上。
    btn.disabled = true;
    const response = await sendMsg({ action: 'applySoundPreset', id: DEFAULT_SOUND_PRESET_ID });
    btn.disabled = false;

    const eq = response?.ok ? (response.eq || defaultEq()) : defaultEq();
    const effects = response?.ok ? (response.effects || defaultEffects()) : defaultEffects();
    if (!response?.ok) pushLog('err', '重置失败：' + (response?.error || '未知'));

    msg.eq = eq;
    msg.effects = effects;
    state.currentEq = eq;
    state.currentEffects = effects;

    syncEqCardInputs(msgId, eq);
    if (state.currentSession) {
      await sendMsg({ action: 'cartSetEq', sessionId: state.currentSession.id, eq });
    }
    return;
  }

  if (action === 'save-eq-card') {
    const eq = msg.eq;
    if (!eq) { pushLog('err', '这条消息里没有 EQ'); return; }
    const name = prompt('给这套调音起个名字：', '');
    if (name === null) return;
    const finalName = name.trim() || `调音-${new Date().toLocaleDateString('zh-CN')}`;
    try {
      // 连效果链一起存：只存 EQ 的话，套用时空间处理会丢
      const r = await sendMsg({
        action: 'saveEqPreset',
        name: finalName,
        eq,
        effects: msg.effects || state.currentEffects,
      });
      if (!r?.ok) throw new Error(r?.error || '保存失败');
      pushLog('ok', `已保存调音「${finalName}」`);
    } catch (err) {
      pushLog('err', '保存失败：' + (err?.message || err));
    }
    return;
  }
});

let eqSaveTimer = null;
function scheduleCartEqSave(sessionId, eq) {
  if (eqSaveTimer) clearTimeout(eqSaveTimer);
  eqSaveTimer = setTimeout(() => {
    eqSaveTimer = null;
    sendMsg({ action: 'cartSetEq', sessionId, eq });
  }, 400);
}

$('#chatStream').addEventListener('input', async e => {
  const input = e.target.closest('[data-eq-band]');
  if (!input) return;
  const msgId = input.getAttribute('data-msg-id');
  const band = input.getAttribute('data-eq-band');
  const val = Number(input.value);
  const valEl = input.parentElement.querySelector('.value');
  if (valEl) valEl.textContent = `${val > 0 ? '+' : ''}${val} dB`;

  const msg = (state.currentSession?.messages || []).find(x => x.id === msgId);
  if (!msg) return;
  const node = state.messageNodes.get(msgId);

  const preampInput = node.querySelector(`[data-eq-band="preamp"]`);
  const preampDb = preampInput ? Number(preampInput.value) : 0;
  const bands = EQ_FREQUENCIES.map(f => {
    const i = node.querySelector(`[data-eq-band="${f}"]`);
    return { frequencyHz: f, gainDb: i ? Number(i.value) : 0 };
  });
  const eq = { enabled: true, preampDb, bands };
  msg.eq = eq;
  // 让「我的内容 → 音效」能立刻反映出手动调整
  state.currentEq = eq;

  if (band === 'preamp') {
    const eqHeaderBadge = node.querySelector('.eq-header .badge:last-child');
    if (eqHeaderBadge) eqHeaderBadge.textContent = `${preampDb > 0 ? '+' : ''}${preampDb} dB 前级`;
  }

  sendMsg({ action: 'setEqDirect', eq }).catch(() => {});
  if (state.currentSession) scheduleCartEqSave(state.currentSession.id, eq);
});

/* ================= 输入栏 ================= */
const inputEl = $('#userInput');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 90) + 'px';
});
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
sendBtn.addEventListener('click', sendChat);
stopBtn.addEventListener('click', () => {
  setRunningUI(false);
  finishThinking();
  sendMsg({ action: 'chatAbort' }).catch(() => {});
  pushLog('err', '已中断');
});

function setRunningUI(running) {
  state.running = running;
  sendBtn.style.display = running ? 'none' : 'inline-flex';
  stopBtn.classList.toggle('show', running);
}

async function sendChat() {
  if (state.running) return;
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';

  if (!state.currentSession) {
    const r = await sendMsg({ action: 'createSession', name: text.slice(0, 20) });
    if (!r?.ok) { pushLog('err', '创建会话失败'); return; }
    state.currentSession = r.session;
    updateHeaderSessionName();
    updateCartUI();
  }

  const userMessageId = randId('msg');
  const userMsg = { id: userMessageId, role: 'user', kind: 'text', text, at: Date.now() };
  state.currentSession.messages = state.currentSession.messages || [];
  state.currentSession.messages.push(userMsg);
  appendMessageNode(userMsg, { animate: true });

  pushLog('stage', '发送：' + text);
  createThinkingNode({ stage: 'route' });
  setRunningUI(true);

  sendMsg({
    action: 'chatStart',
    userNeed: text,
    sessionId: state.currentSession.id,
    userMessageId,
  });
}

/* ================= 思考节点 (首项 AI 动作：必定带分支曲线) ================= */
function stageLabel(stage) {
  return stage === 'rerank' ? '精选歌曲中'
    : stage === 'route' ? '理解意图中'
    : stage === 'eq' ? '设计调音中'
    : '思考中';
}
function createThinkingNode({ stage = 'route' } = {}) {
  for (const rec of state.thinkingRecords) {
    if (!rec.finished) finishThinkingNode(rec);
  }
  state.thinkingRecords = [];
  const stream = $('#chatStream');
  removeEmptyChat();
  const tempId = randId('tmp');
  const node = document.createElement('div');
  
  // 思考节点紧随用户需求之后，必定为分支首项！
  const isBranchStart = true;

  node.className = `msg-agent thinking${isBranchStart ? ' branch-start' : ''}`;
  node.setAttribute('data-tmp-id', tempId);
  node.innerHTML = `
    <div class="agent-track">
      <div class="git-trunk-line"></div>
      <svg class="git-branch-curve" viewBox="0 0 46 32">
        <path d="M 11.5 -8 C 11.5 8, 33.5 4, 33.5 16" fill="none" stroke="var(--brand-500)" stroke-width="3" stroke-linecap="round"/>
      </svg>
      <div class="git-branch-line"></div>
      <div class="git-branch-dot"></div>
    </div>
    <div class="body">
      <div class="thinking-toggle open" data-toggle="${tempId}">
        <span class="chevron">▶</span>
        <span class="spinner"></span>
        <span class="stage-label">${stageLabel(stage)}</span>
        <span class="elapsed"></span>
      </div>
      <div class="thinking-content open cursor" data-content="${tempId}"></div>
    </div>
  `;
  stream.appendChild(node);
  const record = {
    node, tempId, stage,
    startTime: Date.now(),
    buffer: '',
    finished: false,
    timer: setInterval(() => {
      if (record.finished) return;
      const el = node.querySelector('.elapsed');
      if (el) el.textContent = ((Date.now() - record.startTime) / 1000).toFixed(1) + 's';
    }, 200),
  };
  state.thinkingRecords.push(record);
  scrollToBottom();
  return record;
}
function finishThinkingNode(record) {
  if (!record || record.finished) return;
  record.finished = true;
  if (record.timer) clearInterval(record.timer);
  const node = record.node;
  node.classList.add('done');
  const toggle = node.querySelector('.thinking-toggle');
  if (toggle) {
    toggle.classList.remove('open');
    toggle.classList.add('done');
    const spinner = toggle.querySelector('.spinner');
    if (spinner) spinner.remove();
    const label = toggle.querySelector('.stage-label');
    const elapsed = ((Date.now() - record.startTime) / 1000).toFixed(1);
    if (label) label.textContent = `已思考 ${elapsed}s`;
    const elapsedEl = toggle.querySelector('.elapsed');
    if (elapsedEl) elapsedEl.textContent = '';
  }
  const content = node.querySelector('.thinking-content');
  if (content) content.classList.remove('open', 'cursor');
}
function appendThinkingChunk(delta) {
  const record = state.thinkingRecords[state.thinkingRecords.length - 1];
  if (!record || record.finished) return;
  record.buffer += delta;
  const content = record.node.querySelector('.thinking-content');
  if (content) {
    content.textContent = record.buffer;
    content.scrollTop = content.scrollHeight;
  }
  scrollToBottom();
}
function setThinkingStage(stage) {
  const current = state.thinkingRecords[state.thinkingRecords.length - 1];
  if (!current || current.finished) return createThinkingNode({ stage });
  current.stage = stage;
  const label = current.node.querySelector('.stage-label');
  if (label) label.textContent = stageLabel(stage);
}
function finishThinking() {
  for (const rec of state.thinkingRecords) {
    if (!rec.finished) finishThinkingNode(rec);
  }
  setRunningUI(false);
}

/* ================= 监听与同步 ================= */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.target) return;
  if (msg.target === 'sidepanel' && msg.type === 'PLAYER_STATE_CHANGED') {
    player.applyState(msg.payload);
    return;
  }
  if (msg.target === 'sidepanel' && msg.type === 'CHAT_STREAM_CHUNK') {
    const sid = msg.payload?.sessionId;
    if (sid && sid !== state.currentSession?.id) return;
    appendThinkingChunk(msg.payload?.delta || '');
    return;
  }
  if (msg.target === 'sidepanel' && msg.type === 'CHAT_THINKING_START') {
    const sid = msg.payload?.sessionId;
    if (sid && sid !== state.currentSession?.id) return;
    setThinkingStage(msg.payload?.stage || 'route');
    return;
  }
  if (msg.target === 'sidepanel' && msg.type === 'CHAT_THINKING_END') {
    const sid = msg.payload?.sessionId;
    if (sid && sid !== state.currentSession?.id) return;
    finishThinking();
    setRunningUI(false);
    return;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.chatSessions) {
    const sessions = changes.chatSessions.newValue || [];
    state.sessions = sessions;
    const currentId = state.currentSession?.id;
    const updated = sessions.find(s => s.id === currentId);
    if (updated) {
      state.currentSession = updated;
      renderIncremental();
      updateCartUI();
    }
    if ($('#session-drawer').classList.contains('open')) renderSessionList();
  }
  if (area === 'local' && changes.currentSessionId) {
    if (state.currentSession?.id !== changes.currentSessionId.newValue) loadCurrentSession();
  }
  if (area === 'local' && (changes.eqPresets || changes.savedPlaylists)) {
    if ($('#library-drawer').classList.contains('open')) refreshLibrary();
  }
});

function renderIncremental() {
  const messages = state.currentSession?.messages || [];
  for (const m of messages) {
    if (!state.messageNodes.has(m.id)) appendMessageNode(m, { animate: true });
  }
  scrollToBottom();
}
function scrollToBottom() {
  const stream = $('#chatStream');
  requestAnimationFrame(() => { stream.scrollTop = stream.scrollHeight; });
}
function updateHeaderSessionName() {
  $('#sessionName').textContent = state.currentSession?.name || '未命名会话';
}

/* ================= 加载当前会话 ================= */
async function loadCurrentSession() {
  const r = await sendMsg({ action: 'getCurrentSession' });
  if (!r?.ok) return;
  state.currentSession = r.session;
  updateHeaderSessionName();
  renderCurrentSession();
  updateCartUI();
}

/* ================= 播放器 ================= */
const player = createPlayerControls({ send: sendMsg });

/* ================= 主题 ================= */
function applyTheme() {
  const saved = localStorage.getItem('moodtune-theme') || 'light';
  if (saved === 'dark') {
    document.documentElement.classList.add('dark');
    $('#themeBtn').textContent = '☀️';
  } else {
    document.documentElement.classList.remove('dark');
    $('#themeBtn').textContent = '🌙';
  }
}
function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  localStorage.setItem('moodtune-theme', isDark ? 'light' : 'dark');
  applyTheme();
}
applyTheme();

/* ================= 启动 ================= */
(async () => {
  pushLog('info', '侧边栏已启动');
  await refreshModelBadge();
  await refreshSessions();
  await loadCurrentSession();
  await player.refresh();
})();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshModelBadge();
    player.refresh();
    refreshSessions();
  }
});