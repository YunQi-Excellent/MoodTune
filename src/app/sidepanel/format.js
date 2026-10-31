/** 纯格式化工具：不碰 DOM，也不依赖 chrome。 */

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/** 转义要拼进 innerHTML 的文本。 */
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPES[char]);

/** 毫秒时长 → `3:45`；无效值返回 `--:--`。 */
export function fmtDuration(ms) {
  if (!ms || ms <= 0) return '--:--';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 秒数 → `3:45`；无效值返回 `0:00`。 */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 时间戳 → `09:05`。 */
export function fmtClock(ts) {
  const date = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 时间戳 → `09-05 14:30`。 */
export function fmtDate(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
