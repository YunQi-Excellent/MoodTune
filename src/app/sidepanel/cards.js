import { EQ_FREQUENCIES } from '../../core/constants.js';
import { escapeHtml, fmtDuration } from './format.js';

/**
 * 消息卡片渲染：只产出 HTML 字符串，不读写 DOM、不请求数据。
 *
 * 侧边栏只负责把结果塞进节点，卡片逻辑因此可以直接单测
 * （尤其是转义与「已在歌单」的勾选状态）。
 */

/** 按消息类型渲染卡片主体。 */
export function renderAgentBody(message, { cartIds = new Set() } = {}) {
  const kind = message?.kind;

  if (kind === 'text' || kind === 'ack') return `<div>${escapeHtml(message.text || '')}</div>`;

  if (kind === 'error') {
    return `<div class="error-card"><span>⚠️</span><div>${escapeHtml(message.text || '')}</div></div>`;
  }

  if (kind === 'save-card') {
    const label = message.cardType === 'eq' ? '调音' : '播放列表';
    const count = message.count ? ` · ${message.count} 首` : '';
    return `
      <div class="save-card">
        <div class="icon">💾</div>
        <div class="text">已保存${label} <b>「${escapeHtml(message.name)}」</b>${count}<br>
        <span style="color:var(--fg-3);font-size:11px;">可在 📚 我的内容里查看</span></div>
      </div>`;
  }

  if (kind === 'plan-card') return renderPlanCard(message, { cartIds });
  if (kind === 'eq-card') return renderEqCard(message);

  return `<div>${escapeHtml(message?.text || '')}</div>`;
}

/** 推荐临时歌单：候选勾选框 + 统计行。 */
export function renderPlanCard(message, { cartIds = new Set() } = {}) {
  const picks = message.picks || [];
  const stats = message.stats || {};

  const tracksHtml = picks.map((pick) => {
    const inCart = cartIds.has(pick.id);
    const duration = fmtDuration(pick.durationMs);
    const meta = escapeHtml(pick.artists)
      + (duration && duration !== '--:--' ? ` · ${duration}` : '');

    return `
      <label class="track-item" style="${inCart ? 'opacity:0.55;' : ''}">
        <input type="checkbox" class="track-cb" data-track-id="${pick.id}" ${inCart ? '' : 'checked'} ${inCart ? 'disabled' : ''}>
        ${pick.cover ? `<img class="cover" src="${escapeHtml(pick.cover)}" loading="lazy" alt="">` : '<div class="cover"></div>'}
        <div class="info">
          <div class="title">${escapeHtml(pick.name)} ${inCart ? '<span style="font-size:10px;color:var(--brand-600);font-weight:500;">· 已在歌单</span>' : ''}</div>
          <div class="artist">${meta}</div>
          ${pick.reason ? `<div class="reason">💡 ${escapeHtml(pick.reason)}</div>` : ''}
        </div>
      </label>
    `;
  }).join('');

  return `
    <div class="plan-header">
      <div class="plan-title">
        <span>✨ 推荐临时歌单</span>
      </div>
      <span class="badge">${picks.length} 首</span>
    </div>
    <div class="stats-line">
      候选 ${stats.total || 0} 首 · 精排 ${stats.filtered || 0} 首${cartIds.size > 0 ? ` · 会话歌单已有 ${cartIds.size} 首` : ''}
    </div>
    <div class="track-list">${tracksHtml || '<div style="color:var(--fg-3);text-align:center;padding:12px;">没有歌曲</div>'}</div>
    <div class="card-actions">
      <button class="btn" data-action="add-to-cart" data-msg-id="${message.id}">🎵 加入歌单</button>
    </div>
  `;
}

/** 声学 EQ 调校卡片：前级 + 10 段滑杆。 */
export function renderEqCard(message) {
  const eq = message.eq || { preampDb: 0, bands: [] };
  const reason = message.reason || '';
  const preamp = Number(eq.preampDb) || 0;

  const preampHtml = `
    <div class="eq-slider">
      <span class="label strong">前级</span>
      <input type="range" min="-12" max="3" step="1" value="${preamp}"
             data-eq-band="preamp" data-msg-id="${message.id}">
      <span class="value">${preamp > 0 ? '+' : ''}${preamp} dB</span>
    </div>
  `;

  const bandsHtml = EQ_FREQUENCIES.map((frequency) => {
    const band = (eq.bands || []).find(item => Number(item.frequencyHz) === frequency);
    const gain = band ? Number(band.gainDb) : 0;
    const label = frequency >= 1000 ? `${frequency / 1000} kHz` : `${frequency} Hz`;

    return `
      <div class="eq-slider">
        <span class="label">${label}</span>
        <input type="range" min="-12" max="12" step="1" value="${gain}"
               data-eq-band="${frequency}" data-msg-id="${message.id}">
        <span class="value">${gain > 0 ? '+' : ''}${gain} dB</span>
      </div>
    `;
  }).join('');

  return `
    <div class="eq-header">
      <div class="title">
        <span>🎛 声学 EQ 调校</span>
      </div>
      <div class="eq-header-right">
        <button class="eq-link" data-action="open-sound-library" data-msg-id="${message.id}">预设效果 ›</button>
        <span class="badge yellow">${preamp > 0 ? '+' : ''}${preamp} dB 前级</span>
      </div>
    </div>
    ${reason ? `<div class="stats-line yellow">💡 ${escapeHtml(reason)}</div>` : ''}
    <div style="margin: 8px 0 10px;">
      ${preampHtml}
      <hr class="eq-divider">
      ${bandsHtml}
    </div>
    <div class="card-actions">
      <button class="btn ghost" data-action="reset-eq-card" data-msg-id="${message.id}" style="flex:0.5;">重置</button>
      <button class="btn" data-action="save-eq-card" data-msg-id="${message.id}" style="flex:1;">💾 保存这套调音</button>
    </div>
  `;
}
