import { $ } from '../dom.js';
import { fmtTime } from './format.js';
import { PLAYBACK_MODE_META, normalizePlaybackMode } from '../../core/playback.js';

/**
 * 播放栏控制器：绑定按钮、同步状态。
 *
 * `send` 注入（侧边栏传 chrome.runtime.sendMessage 包装），
 * 这样这个模块本身不依赖 chrome，也不会在导入时碰 DOM。
 */
export function createPlayerControls({ send } = {}) {
  if (typeof send !== 'function') throw new Error('createPlayerControls 需要 send');

  const els = {
    cover: $('#playerCover'),
    title: $('#playerTitle'),
    artist: $('#playerArtist'),
    current: $('#playerCurrent'),
    duration: $('#playerDuration'),
    seek: $('#playerSeek'),
    play: $('#playerPlay'),
    prev: $('#playerPrev'),
    next: $('#playerNext'),
    volume: $('#playerVolume'),
    mode: $('#playerMode'),
    modeIcon: $('#playerModeIcon'),
    modeLabel: $('#playerModeLabel'),
  };

  let seeking = false;

  // 封面加载失败时隐藏，交给 onerror 属性会破坏 CSP 友好性
  els.cover.addEventListener('error', () => { els.cover.style.visibility = 'hidden'; });

  els.play.addEventListener('click', () => send({ target: 'background', type: 'PLAYER_TOGGLE' }));
  els.next.addEventListener('click', () => send({ target: 'background', type: 'PLAYER_NEXT' }));
  els.prev.addEventListener('click', () => send({ target: 'background', type: 'PLAYER_PREV' }));

  // 播放模式由 offscreen 持有，这里只请求切换并用返回状态立即刷新按钮。
  els.mode.addEventListener('click', async () => {
    const response = await send({ target: 'background', type: 'PLAYER_CYCLE_MODE' });
    if (response?.ok && response.state) applyState(response.state);
  });

  els.seek.addEventListener('pointerdown', () => { seeking = true; });
  els.seek.addEventListener('input', () => {
    els.current.textContent = fmtTime(parseFloat(els.seek.value));
  });
  els.seek.addEventListener('change', () => {
    const time = parseFloat(els.seek.value);
    send({ target: 'background', type: 'PLAYER_SEEK', payload: { time } });
    setTimeout(() => { seeking = false; }, 300);
  });

  els.volume.addEventListener('input', () => {
    const volume = parseFloat(els.volume.value);
    send({ target: 'background', type: 'PLAYER_SET_VOLUME', payload: { volume } });
  });

  function setCover(cover) {
    if (cover) {
      els.cover.src = cover;
      els.cover.style.visibility = 'visible';
    } else {
      els.cover.style.visibility = 'hidden';
    }
  }

  function renderPlaybackMode(mode) {
    const normalized = normalizePlaybackMode(mode);
    const meta = PLAYBACK_MODE_META[normalized];
    els.mode.dataset.mode = normalized;
    els.mode.title = `播放模式：${meta.label}（点击切换）`;
    els.mode.setAttribute('aria-label', `播放模式：${meta.label}`);
    els.modeIcon.textContent = meta.icon;
    els.modeLabel.textContent = meta.shortLabel;
  }

  function applyState(next) {
    if (!next) return;

    if (next.currentSong) {
      setCover(next.currentSong.cover);
      els.title.textContent = next.currentSong.name || '未知';
      els.artist.textContent = next.currentSong.artists || '';
    } else {
      setCover('');
      els.title.textContent = '未播放';
      els.artist.textContent = '播放队列为空';
    }

    if (next.loading) {
      els.play.textContent = '⏳';
      els.play.disabled = true;
    } else {
      els.play.textContent = next.playing ? '⏸' : '▶';
      els.play.disabled = false;
    }

    if (!seeking) {
      els.seek.max = next.duration || 1;
      els.seek.value = next.currentTime || 0;
      els.current.textContent = fmtTime(next.currentTime);
    }
    els.duration.textContent = fmtTime(next.duration);
    if (typeof next.volume === 'number') els.volume.value = next.volume;
    renderPlaybackMode(next.playbackMode);
  }

  async function refresh() {
    const response = await send({ target: 'background', type: 'PLAYER_GET_STATE' });
    if (response?.ok && response.state) applyState(response.state);
  }

  return { applyState, refresh, elements: els };
}
