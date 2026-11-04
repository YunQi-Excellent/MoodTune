import { EQ_FREQUENCIES } from '../../core/constants.js';
import { findPresetByState, groupSoundPresets } from '../../core/sound-presets.js';
import { escapeHtml, fmtDuration } from './format.js';

/**
 * 消息卡片渲染：只产出 HTML 字符串，不读写 DOM、不请求数据。
 *
 * 侧边栏只负责把结果塞进节点，卡片逻辑因此可以直接单测
 * （尤其是转义与「已在歌单」的勾选状态）。
 */

/** 按消息类型渲染卡片主体。 */
export function renderAgentBody(message, { cartIds = new Set(), showThinking = true } = {}) {
  const kind = message?.kind;

  if (kind === 'text' || kind === 'ack') return `<div>${escapeHtml(message.text || '')}</div>`;

  if (kind === 'error') {
    // 失败时把「哪个阶段花了多久」直接摆在卡片上：
    // 超时到底是模型慢还是检索慢，用户一眼能看出来，也方便我们定位。
    const timings = String(message.timingsText || '').trim();
    const timingLine = timings
      ? `<div class="error-meta">阶段耗时：${escapeHtml(timings)}</div>`
      : '';
    return `${showThinking ? renderThinkingHistory(message.thinking) : ''}
      <div class="error-card"><span>⚠️</span><div>${escapeHtml(message.text || '')}</div></div>
      ${timingLine}`;
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

  if (kind === 'plan-card') return renderPlanCard(message, { cartIds, showThinking });
  if (kind === 'eq-card') return renderEqCard(message, { showThinking });

  return `<div>${escapeHtml(message?.text || '')}</div>`;
}

/**
 * 持久化的思考记录。默认折叠，点开才看完整流式输出。
 * 和侧边栏里实时的思考节点视觉保持一致（黄色、等宽、可滚动）。
 */
export function renderThinkingHistory(thinking) {
  const text = String(thinking?.text || '').trim();
  if (!text) return '';

  const elapsed = Number(thinking?.elapsedMs);
  const meta = Number.isFinite(elapsed) && elapsed > 0
    ? `<span class="thinking-history-elapsed">${(elapsed / 1000).toFixed(1)}s</span>`
    : '';

  return `
    <details class="thinking-history">
      <summary class="thinking-history-toggle">
        <span class="chevron">▶</span>
        <span>🧠 思考记录</span>
        ${meta}
      </summary>
      <div class="thinking-history-content">${escapeHtml(text)}</div>
    </details>`;
}

/** 推荐临时歌单：候选勾选框 + 统计行。 */
export function renderPlanCard(message, { cartIds = new Set(), showThinking = true } = {}) {
  const picks = message.picks || [];
  const stats = message.stats || {};
  const thinkingHtml = showThinking ? renderThinkingHistory(message.thinking) : '';

  // 默认全选：只要还有可选（未进歌单）的歌，按钮就该显示「取消全选」。
  const selectableCount = picks.filter(pick => !cartIds.has(pick.id)).length;
  const selectAllLabel = selectableCount > 0 ? '取消全选' : '全选';

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
    ${thinkingHtml}
    <div class="plan-header">
      <div class="plan-title">
        <span>✨ 推荐临时歌单</span>
      </div>
      <span class="badge">${picks.length} 首</span>
    </div>
    <div class="stats-line">
      <span>候选 ${stats.total || 0} 首 · 精排 ${stats.filtered || 0} 首${stats.direct ? ' · 原文直搜' : ''}${stats.rerankSkipped ? ' · 未精排' : ''}${stats.carried ? ` · 含上轮 ${stats.carried} 首` : ''}${cartIds.size > 0 ? ` · 会话歌单已有 ${cartIds.size} 首` : ''}</span>
      <button class="link-btn" data-action="toggle-select-all" data-msg-id="${message.id}"
              ${selectableCount > 0 ? '' : 'disabled'}>${selectAllLabel}</button>
    </div>
    <div class="track-list">${tracksHtml || '<div style="color:var(--fg-3);text-align:center;padding:12px;">没有歌曲</div>'}</div>
    <div class="card-actions">
      <button class="btn" data-action="add-to-cart" data-msg-id="${message.id}">🎵 加入歌单</button>
    </div>
  `;
}

/** 声学 EQ 调校卡片：前级 + 10 段滑杆。 */
export function renderEqCard(message, { showThinking = true } = {}) {
  const eq = message.eq || { preampDb: 0, bands: [] };
  const reason = message.reason || '';
  const preamp = Number(eq.preampDb) || 0;
  const thinkingHtml = showThinking ? renderThinkingHistory(message.thinking) : '';

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

  // 预设面板默认收起：标题就写着当前是哪套（或「自定义」），
  // 点开是卡片内联的分组列表，不弹抽屉，选完立刻同步下面的滑杆。
  const activePreset = findPresetByState({ eq, effects: message.effects });
  const presetLabel = activePreset ? activePreset.name : '自定义';

  const presetGroups = groupSoundPresets().map(section => `
    <div class="eq-presets-group">
      <div class="eq-presets-title">${escapeHtml(section.group)}</div>
      <div class="eq-presets-grid">
        ${section.presets.map((preset) => {
          const isActive = activePreset?.id === preset.id;
          return `<button class="eq-preset-chip${isActive ? ' active' : ''}"
                    data-action="apply-sound-chip" data-sound-id="${escapeHtml(preset.id)}"
                    data-msg-id="${message.id}"
                    title="${escapeHtml(preset.tagline || '')}">${escapeHtml(preset.name)}</button>`;
        }).join('')}
      </div>
    </div>
  `).join('');

  return `
    ${thinkingHtml}
    <div class="eq-header">
      <div class="title">
        <span>🎛 声学 EQ 调校</span>
      </div>
      <div class="eq-header-right">
        <button class="eq-link" data-action="toggle-eq-presets" data-msg-id="${message.id}" aria-expanded="false">
          <span class="eq-link-label">预设效果 · ${escapeHtml(presetLabel)}</span><span class="caret">▾</span>
        </button>
        <span class="badge yellow">${preamp > 0 ? '+' : ''}${preamp} dB 前级</span>
      </div>
    </div>
    <div class="eq-presets" hidden>${presetGroups}</div>
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
