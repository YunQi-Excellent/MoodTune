import { describe, expect, it, vi } from 'vitest';
import { tuneEq } from '../../src/agent/eq-tuner.js';
import { EQ_CONFIG } from '../../src/core/constants.js';

function setup(raw) {
  const llm = { stream: vi.fn(async () => raw) };
  return { llm };
}

describe('tuneEq', () => {
  it('需要 llm', async () => {
    await expect(tuneEq({})).rejects.toThrow('tuneEq 需要 llm');
  });

  it('把模型输出归一化成固定 10 段并保留理由', async () => {
    const { llm } = setup(JSON.stringify({
      eq: {
        preampDb: -3.4,
        bands: [{ frequencyHz: 31, gainDb: 99 }, { frequencyHz: 1000, gainDb: 4.6 }],
      },
      reason: '低频太重，收一点',
    }));

    const out = await tuneEq({ llm, userNeed: '低频轻一点' });

    expect(out.reason).toBe('低频太重，收一点');
    expect(out.eq.bands).toHaveLength(EQ_CONFIG.frequencies.length);
    expect(out.eq.bands[0]).toEqual({ frequencyHz: 31, gainDb: EQ_CONFIG.maxGainDb });
    expect(out.eq.bands.find(band => band.frequencyHz === 1000).gainDb).toBe(5);
    expect(out.eq.preampDb).toBe(-3);
  });

  it('理由超长时截断到 200 字', async () => {
    const { llm } = setup(JSON.stringify({ eq: { bands: [] }, reason: 'x'.repeat(500) }));
    const out = await tuneEq({ llm, userNeed: '随便' });
    expect(out.reason).toHaveLength(200);
  });

  it('对话里带上当前 EQ，便于增量调整', async () => {
    const { llm } = setup(JSON.stringify({ eq: { bands: [] } }));
    const currentEq = { preampDb: 1, bands: [{ frequencyHz: 31, gainDb: 2 }] };

    await tuneEq({ llm, userNeed: '再暖一点', currentEq });

    const messages = llm.stream.mock.calls[0][0];
    expect(messages[1].content).toContain('当前 EQ');
    expect(messages[1].content).toContain('"preampDb": 1');
  });

  it('没有当前 EQ 时提示从平坦开始', async () => {
    const { llm } = setup(JSON.stringify({ eq: { bands: [] } }));
    await tuneEq({ llm, userNeed: '随便' });
    expect(llm.stream.mock.calls[0][0][1].content).toContain('还没有任何 EQ 配置');
  });

  it('模型输出不是有效 JSON 时报错', async () => {
    const { llm } = setup('我觉得这样挺好');
    await expect(tuneEq({ llm, userNeed: '随便' })).rejects.toThrow('大模型没有给出有效的 EQ JSON');
  });
});
