import { describe, expect, it } from 'vitest';
import { escapeHtml, fmtClock, fmtDate, fmtDuration, fmtTime } from '../../../src/app/sidepanel/format.js';

describe('escapeHtml', () => {
  it('转义 HTML 特殊字符', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`))
      .toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('null / undefined 变成空串', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('fmtTime', () => {
  it('秒数转 mm:ss', () => {
    expect(fmtTime(0)).toBe('0:00');
    expect(fmtTime(59)).toBe('0:59');
    expect(fmtTime(125)).toBe('2:05');
  });

  it('非法值回落 0:00', () => {
    expect(fmtTime(Number.NaN)).toBe('0:00');
    expect(fmtTime(-1)).toBe('0:00');
    expect(fmtTime(undefined)).toBe('0:00');
  });
});

describe('fmtDuration', () => {
  it('毫秒转 mm:ss', () => {
    expect(fmtDuration(225_000)).toBe('3:45');
    expect(fmtDuration(5_000)).toBe('0:05');
  });

  it('缺省值显示 --:--', () => {
    expect(fmtDuration(0)).toBe('--:--');
    expect(fmtDuration(undefined)).toBe('--:--');
  });
});

describe('时间戳格式', () => {
  const ts = new Date(2024, 4, 6, 9, 5).getTime();

  it('fmtClock 输出时:分', () => {
    expect(fmtClock(ts)).toBe('09:05');
  });

  it('fmtDate 输出月-日 时:分', () => {
    expect(fmtDate(ts)).toBe('05-06 09:05');
    expect(fmtDate(0)).toBe('');
  });
});
