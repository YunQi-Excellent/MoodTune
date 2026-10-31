import { describe, expect, it } from 'vitest';
import { renderAgentBody, renderEqCard, renderPlanCard } from '../../../src/app/sidepanel/cards.js';
import { EQ_FREQUENCIES } from '../../../src/core/constants.js';
import { BUILTIN_SOUND_PRESETS, findBuiltinSoundPreset } from '../../../src/core/sound-presets.js';

const picks = [
  { id: 1, name: '雨天', artists: 'A', album: 'X', durationMs: 225_000, cover: 'https://img/1.jpg', reason: '很搭' },
  { id: 2, name: '晴天', artists: 'B', durationMs: 0 },
];

describe('renderAgentBody', () => {
  it('普通文本会转义', () => {
    const html = renderAgentBody({ kind: 'text', text: '<script>alert(1)</script>' });
    expect(html).toBe('<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>');
  });

  it('error 走错误卡片', () => {
    const html = renderAgentBody({ kind: 'error', text: '失败了' });
    expect(html).toContain('class="error-card"');
    expect(html).toContain('失败了');
  });

  it('save-card 区分调音与歌单并带上数量', () => {
    expect(renderAgentBody({ kind: 'save-card', cardType: 'eq', name: '低音' }))
      .toContain('已保存调音');
    const list = renderAgentBody({ kind: 'save-card', cardType: 'playlist', name: '夜跑', count: 12 });
    expect(list).toContain('已保存播放列表');
    expect(list).toContain('12 首');
  });

  it('未知类型退回文本渲染', () => {
    expect(renderAgentBody({ text: '兜底' })).toBe('<div>兜底</div>');
    expect(renderAgentBody(undefined)).toBe('<div></div>');
  });
});

describe('renderPlanCard', () => {
  it('渲染候选、统计与加入按钮', () => {
    const html = renderPlanCard(
      { id: 'msg-1', picks, stats: { total: 20, filtered: 8 } },
      { cartIds: new Set() },
    );

    expect(html).toContain('推荐临时歌单');
    expect(html).toContain('候选 20 首 · 精排 8 首');
    expect(html).toContain('data-msg-id="msg-1"');
    expect(html.match(/class="track-cb"/g)).toHaveLength(2);
    expect(html.match(/checked/g)).toHaveLength(2);
    expect(html).toContain('3:45');
  });

  it('已在会话歌单的候选被禁用并标注', () => {
    const html = renderPlanCard(
      { id: 'msg-2', picks, stats: {} },
      { cartIds: new Set([2]) },
    );

    expect(html).toContain('会话歌单已有 1 首');
    expect(html).toContain('已在歌单');
    expect(html).toContain('opacity:0.55;');
    expect(html).toContain('disabled');
  });

  it('封面与歌名都经过转义', () => {
    const html = renderPlanCard({
      id: 'm',
      picks: [{ id: 3, name: '<b>', artists: '"x"', cover: 'x" onerror="alert(1)' }],
      stats: {},
    });

    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&quot;x&quot;');
    expect(html).not.toContain('onerror="alert(1)"');
  });

  it('没有候选时给出占位', () => {
    expect(renderPlanCard({ id: 'm', picks: [] }, {})).toContain('没有歌曲');
  });
});

describe('renderEqCard', () => {
  it('渲染前级与全部频段滑杆', () => {
    const html = renderEqCard({ id: 'msg-9', eq: { preampDb: -3, bands: [{ frequencyHz: 1000, gainDb: 5 }] } });

    expect(html.match(/data-eq-band=/g)).toHaveLength(EQ_FREQUENCIES.length + 1);
    expect(html).toContain('-3 dB 前级');
    expect(html).toContain('data-eq-band="preamp"');
    expect(html).toContain('data-msg-id="msg-9"');
    expect(html).toContain('1 kHz');
  });

  it('理由会转义，缺省时不渲染', () => {
    expect(renderEqCard({ id: 'm', eq: {}, reason: '<b>亮</b>' })).toContain('&lt;b&gt;亮&lt;/b&gt;');
    expect(renderEqCard({ id: 'm', eq: {} })).not.toContain('stats-line yellow');
  });

  it('预设面板默认收起，标题直接写出当前音效', () => {
    const flat = findBuiltinSoundPreset('flat');
    const html = renderEqCard({ id: 'm', eq: flat.eq, effects: flat.effects });

    expect(html).toContain('data-action="toggle-eq-presets"');
    expect(html).toContain('<div class="eq-presets" hidden>');
    expect(html).toContain('预设效果 · 原声');
    expect(html.match(/data-sound-id=/g)).toHaveLength(BUILTIN_SOUND_PRESETS.length);
    expect(html).toContain('eq-preset-chip active');
  });

  it('EQ 对不上任何预设时标题显示自定义、也没有勾选', () => {
    const eq = {
      preampDb: 0,
      bands: EQ_FREQUENCIES.map(frequencyHz => ({ frequencyHz, gainDb: 1 })),
    };

    const html = renderEqCard({ id: 'm', eq });

    expect(html).toContain('预设效果 · 自定义');
    expect(html).not.toContain('eq-preset-chip active');
  });

  it('缺 EQ 时按平坦渲染，不抛错', () => {
    const html = renderEqCard({ id: 'm' });
    expect(html).toContain('0 dB 前级');
    expect(html.match(/value="0"/g)).toHaveLength(EQ_FREQUENCIES.length + 1);
  });
});
