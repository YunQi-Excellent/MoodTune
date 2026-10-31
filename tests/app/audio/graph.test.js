import { describe, expect, it, vi } from 'vitest';
import { createAudioGraph } from '../../../src/app/audio/graph.js';
import { EQ_FREQUENCIES } from '../../../src/core/constants.js';
import { defaultEffects, normalizeEffects } from '../../../src/core/effects.js';
import { dbToGain } from '../../../src/core/eq.js';
import { collectNodes, createFakeAudioContext } from '../../helpers/fake-audio-context.js';

function setup() {
  const { ctx } = createFakeAudioContext();
  const source = ctx.createGain();
  const graph = createAudioGraph({ ctx, source, destination: ctx.destination });
  return { ctx, source, graph };
}

describe('createAudioGraph 结构', () => {
  it('搭出一条 source → EQ → destination 的链', () => {
    const { ctx, source, graph } = setup();

    expect(graph.filters).toHaveLength(EQ_FREQUENCIES.length);
    expect(graph.filters.map(f => f.frequency.value)).toEqual([...EQ_FREQUENCIES]);
    expect(graph.filters.every(f => f.type === 'peaking')).toBe(true);
    expect(graph.preamp).toBeTruthy();

    const reachable = collectNodes(source);
    expect(reachable).toContain(ctx.destination);
    expect(reachable).toContain(graph.filters[0]);
  });

  it('缺少必要依赖时直接报错', () => {
    const { ctx, source } = setup();
    expect(() => createAudioGraph({ ctx, source })).toThrow('需要 destination');
    expect(() => createAudioGraph({ ctx, destination: ctx.destination })).toThrow('需要 source');
    expect(() => createAudioGraph({ source, destination: ctx.destination })).toThrow('需要 AudioContext');
  });

  it('效果块缺 API 时跳过而不是整条链失败', () => {
    const { ctx } = createFakeAudioContext();
    delete ctx.createConvolver;
    const source = ctx.createGain();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const graph = createAudioGraph({ ctx, source, destination: ctx.destination });
    warn.mockRestore();

    expect(graph.blocks.reverb).toBeUndefined();
    expect(graph.blocks.width).toBeTruthy();
    expect(graph.filters).toHaveLength(EQ_FREQUENCIES.length);
  });
});

describe('applyEq', () => {
  it('把前级与各段增益落到节点上', () => {
    const { graph } = setup();

    graph.applyEq({
      enabled: true,
      preampDb: 6,
      bands: [
        { frequencyHz: 1000, gainDb: 3 },
        { frequencyHz: 62, gainDb: -4 },
      ],
    });

    expect(graph.preamp.gain.value).toBeCloseTo(dbToGain(6), 5);
    const at = frequency => graph.filters[EQ_FREQUENCIES.indexOf(frequency)].gain.value;
    expect(at(1000)).toBe(3);
    expect(at(62)).toBe(-4);
    expect(at(16000)).toBe(0);
  });

  it('关闭 EQ 时前级归零、所有段归零', () => {
    const { graph } = setup();

    graph.applyEq({ enabled: false, preampDb: 6, bands: [{ frequencyHz: 1000, gainDb: 3 }] });

    expect(graph.preamp.gain.value).toBe(1);
    expect(graph.filters.every(f => f.gain.value === 0)).toBe(true);
  });
});

describe('applyEffects 默认必须完全旁路', () => {
  it('默认效果链不改声音：所有块干路全通', () => {
    const { graph } = setup();

    graph.applyEffects(defaultEffects());

    for (const [name, block] of Object.entries(graph.blocks)) {
      expect(block.dryGain.gain.value, name).toBe(1);
      expect(block.wetGain.gain.value, name).toBe(0);
    }
  });

  it('总开关关闭时即使块被启用也不处理', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.enabled = false;
    effects.width.enabled = true;

    graph.applyEffects(effects);

    expect(graph.blocks.width.dryGain.gain.value).toBe(1);
    expect(graph.blocks.width.wetGain.gain.value).toBe(0);
  });

  it('只启用某一个块时，其他块保持旁路', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.width.enabled = true;

    graph.applyEffects(effects);

    expect(graph.blocks.width.dryGain.gain.value).toBe(0);
    expect(graph.blocks.width.wetGain.gain.value).toBe(1);
    expect(graph.blocks.reverb.wetGain.gain.value).toBe(0);
    expect(graph.blocks.spatial.wetGain.gain.value).toBe(0);
  });
});

describe('安全限幅器', () => {
  it('默认（全旁路）时限幅器不接入', () => {
    const { graph } = setup();

    graph.applyEffects(defaultEffects());

    expect(graph.limiter.dryGain.gain.value).toBe(1);
    expect(graph.limiter.wetGain.gain.value).toBe(0);
  });

  it('有任何一个效果块启用时接入，参数是只压峰值的设定', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.width.enabled = true;

    graph.applyEffects(effects);

    expect(graph.limiter.dryGain.gain.value).toBe(0);
    expect(graph.limiter.wetGain.gain.value).toBe(1);
    expect(graph.limiter.inner.nodes.compressor.threshold.value).toBe(-1);
    expect(graph.limiter.inner.nodes.compressor.ratio.value).toBe(20);
  });

  it('总开关关闭时限幅器跟着退出', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.enabled = false;
    effects.width.enabled = true;

    graph.applyEffects(effects);

    expect(graph.limiter.dryGain.gain.value).toBe(1);
    expect(graph.limiter.wetGain.gain.value).toBe(0);
  });
});

describe('applyEffects 参数映射', () => {
  it('宽度：M/S 侧路增益等于 amount', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.width.enabled = true;
    effects.width.amount = 1.5;

    graph.applyEffects(effects);

    expect(graph.blocks.width.inner.nodes.sideGain.gain.value).toBe(1.5);
  });

  it('串音：amount 折算到对侧增益，并落到低通与延时', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.crossfeed.enabled = true;
    effects.crossfeed.amount = 0.5;
    effects.crossfeed.cutoffHz = 900;
    effects.crossfeed.delayMs = 0.5;

    graph.applyEffects(effects);

    const nodes = graph.blocks.crossfeed.inner.nodes;
    expect(nodes.crossL.gain.value).toBeCloseTo(0.3, 5);
    expect(nodes.crossR.gain.value).toBeCloseTo(0.3, 5);
    expect(nodes.lowpassL.frequency.value).toBe(900);
    expect(nodes.delayL.delayTime.value).toBeCloseTo(0.0005, 6);
  });

  it('早期反射：抽头增益按 amount 缩放', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.spatial.enabled = true;
    effects.spatial.amount = 0.5;

    graph.applyEffects(effects);

    const taps = graph.blocks.spatial.inner.nodes.taps;
    expect(taps).toHaveLength(4);
    expect(taps[0].gain.gain.value).toBeCloseTo(-0.16, 5);
  });

  it('混响：合成 IR、干湿比与预延时都生效', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.reverb.enabled = true;
    effects.reverb.wet = 0.4;
    effects.reverb.durationMs = 1000;
    effects.reverb.decay = 3;
    effects.reverb.preDelayMs = 20;

    graph.applyEffects(effects);

    const nodes = graph.blocks.reverb.inner.nodes;
    expect(nodes.wet.gain.value).toBeCloseTo(0.4, 5);
    expect(nodes.dry.gain.value).toBeCloseTo(0.6, 5);
    expect(nodes.preDelay.delayTime.value).toBeCloseTo(0.02, 5);
    expect(nodes.convolver.buffer.length).toBe(48000);
    expect(nodes.convolver.buffer.numberOfChannels).toBe(2);
  });

  it('混响 IR 的尾巴够长：不会几百毫秒就断', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.reverb.enabled = true;
    effects.reverb.durationMs = 2000;
    effects.reverb.decay = 2.4;

    graph.applyEffects(effects);

    const data = graph.blocks.reverb.inner.nodes.convolver.buffer.getChannelData(0);
    const windowRms = (from, to) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / (to - from));
    };
    const head = windowRms(0, 2000);
    const quarter = windowRms(Math.floor(data.length * 0.25), Math.floor(data.length * 0.25) + 2000);
    const tail = windowRms(data.length - 2000, data.length);

    const db = value => 20 * Math.log10(value / head);
    expect(db(quarter)).toBeGreaterThan(-40);
    expect(db(tail)).toBeLessThan(-55);
  });

  it('混响 IR 按参数缓存，不会每次重算', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.reverb.enabled = true;

    graph.applyEffects(effects);
    const first = graph.blocks.reverb.inner.nodes.convolver.buffer;
    graph.applyEffects(effects);

    expect(graph.blocks.reverb.inner.nodes.convolver.buffer).toBe(first);
  });

  it('动态：阈值/压缩比/补偿增益与激励曲线', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.dynamics.enabled = true;
    effects.dynamics.thresholdDb = -24;
    effects.dynamics.ratio = 6;
    effects.dynamics.makeupDb = 3;
    effects.dynamics.drive = 0.5;

    graph.applyEffects(effects);

    const nodes = graph.blocks.dynamics.inner.nodes;
    expect(nodes.compressor.threshold.value).toBe(-24);
    expect(nodes.compressor.ratio.value).toBe(6);
    expect(nodes.makeup.gain.value).toBeCloseTo(dbToGain(3), 5);
    expect(nodes.shaper.curve).not.toBeNull();

    effects.dynamics.drive = 0;
    graph.applyEffects(effects);
    expect(nodes.shaper.curve).toBeNull();
  });

  it('越界参数在落到节点前被归一化', () => {
    const { graph } = setup();
    const effects = defaultEffects();
    effects.width.enabled = true;
    effects.width.amount = 99;

    graph.applyEffects(effects);

    expect(graph.blocks.width.inner.nodes.sideGain.gain.value).toBe(normalizeEffects(effects).width.amount);
    expect(graph.blocks.width.inner.nodes.sideGain.gain.value).toBe(2);
  });
});
