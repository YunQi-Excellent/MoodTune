import { EQ_FREQUENCIES } from '../../core/constants.js';
import { normalizeEffects } from '../../core/effects.js';
import { dbToGain } from '../../core/eq.js';

/**
 * Web Audio 效果链。
 *
 * 结构：
 *
 *   source → preamp → EQ(10 段) → 宽度 → 串音 → 早期反射 → 混响 → 动态 → destination
 *
 * 每个效果块都是「干/湿并行」的可旁路模块：关着时干路全通，等于这根线短接，
 * 因此**默认状态下听感与只有 EQ 时完全一致**。这是这个文件最重要的约束。
 *
 * 这里只做「把参数落到节点上」，不含任何业务判断；参数归一化在 core/effects.js。
 */

const RAMP_SECONDS = 0.02;
const IR_CACHE_LIMIT = 8;
const EARLY_TAPS = Object.freeze([
  { delayMs: 9.7, gain: -0.32, from: 0, to: 1 },
  { delayMs: 15.3, gain: 0.24, from: 1, to: 0 },
  { delayMs: 21.1, gain: -0.18, from: 0, to: 1 },
  { delayMs: 27.7, gain: 0.13, from: 1, to: 0 },
]);

/** 平滑改参数，避免拖动/切换预设时爆音。 */
function setParam(param, value, when) {
  if (!param) return;
  if (typeof param.setTargetAtTime === 'function') {
    if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(when);
    param.setTargetAtTime(value, when, RAMP_SECONDS);
    return;
  }
  param.value = value;
}

/** 干湿并行的可旁路模块：active=false 时干路直通。 */
function createBlock(ctx, build) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  dry.gain.value = 1;
  wet.gain.value = 0;

  const inner = build();

  input.connect(dry);
  dry.connect(output);
  input.connect(inner.input);
  inner.output.connect(wet);
  wet.connect(output);

  return {
    input,
    output,
    dryGain: dry,
    wetGain: wet,
    inner,
    setActive(active, when) {
      setParam(dry.gain, active ? 0 : 1, when);
      setParam(wet.gain, active ? 1 : 0, when);
    },
  };
}

/** 立体声宽度：L' = M + k·S，R' = M − k·S。 */
function buildWidth(ctx) {
  const input = ctx.createGain();
  const split = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);

  const mid = ctx.createGain();
  const side = ctx.createGain();
  const toMidL = ctx.createGain();
  const toMidR = ctx.createGain();
  const toSideL = ctx.createGain();
  const toSideR = ctx.createGain();
  const sideGain = ctx.createGain();
  const sideInv = ctx.createGain();
  const left = ctx.createGain();
  const right = ctx.createGain();

  toMidL.gain.value = 0.5;
  toMidR.gain.value = 0.5;
  toSideL.gain.value = 0.5;
  toSideR.gain.value = -0.5;
  sideGain.gain.value = 1;
  sideInv.gain.value = -1;

  input.connect(split);
  split.connect(toMidL, 0);
  split.connect(toSideL, 0);
  split.connect(toMidR, 1);
  split.connect(toSideR, 1);

  toMidL.connect(mid);
  toMidR.connect(mid);
  toSideL.connect(side);
  toSideR.connect(side);

  mid.connect(left);
  mid.connect(right);
  side.connect(sideGain);
  sideGain.connect(left);
  sideGain.connect(sideInv);
  sideInv.connect(right);

  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);

  return {
    input,
    output: merger,
    nodes: { sideGain, mid, side },
    update(params, when) {
      setParam(sideGain.gain, params.amount, when);
    },
  };
}

/**
 * 串音：对侧信号低通 + 极短延时后混回本侧。
 * 这是「声音在额前而不是脑中」的关键，纯 EQ 做不到。
 */
function buildCrossfeed(ctx) {
  const input = ctx.createGain();
  const split = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);

  const directL = ctx.createGain();
  const directR = ctx.createGain();
  directL.gain.value = 1;
  directR.gain.value = 1;

  const delayL = ctx.createDelay(0.01);
  const delayR = ctx.createDelay(0.01);
  const lowpassL = ctx.createBiquadFilter();
  const lowpassR = ctx.createBiquadFilter();
  const crossL = ctx.createGain(); // 左声道 → 右耳
  const crossR = ctx.createGain(); // 右声道 → 左耳
  crossL.gain.value = 0;
  crossR.gain.value = 0;

  lowpassL.type = 'lowpass';
  lowpassR.type = 'lowpass';

  input.connect(split);
  split.connect(directL, 0);
  split.connect(delayL, 0);
  split.connect(directR, 1);
  split.connect(delayR, 1);

  directL.connect(merger, 0, 0);
  directR.connect(merger, 0, 1);
  delayL.connect(lowpassL);
  lowpassL.connect(crossL);
  crossL.connect(merger, 0, 1);
  delayR.connect(lowpassR);
  lowpassR.connect(crossR);
  crossR.connect(merger, 0, 0);

  return {
    input,
    output: merger,
    nodes: { crossL, crossR, lowpassL, lowpassR, delayL, delayR },
    update(params, when) {
      setParam(crossL.gain, params.amount * 0.6, when);
      setParam(crossR.gain, params.amount * 0.6, when);
      setParam(lowpassL.frequency, params.cutoffHz, when);
      setParam(lowpassR.frequency, params.cutoffHz, when);
      setParam(delayL.delayTime, params.delayMs / 1000, when);
      setParam(delayR.delayTime, params.delayMs / 1000, when);
    },
  };
}

/** 早期反射：交叉声道短延时抽头，制造包围感（不是混响）。 */
function buildSpatial(ctx) {
  const input = ctx.createGain();
  const split = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);

  const taps = EARLY_TAPS.map((tap) => {
    const delay = ctx.createDelay(0.1);
    const gain = ctx.createGain();
    delay.delayTime.value = tap.delayMs / 1000;
    gain.gain.value = 0;
    delay.connect(gain);
    gain.connect(merger, 0, tap.to);
    return { delay, gain, config: tap };
  });

  // 交叉取声道：左声道反射进右耳，反之亦然，才有包围感而不是单点回声
  taps.forEach((tap) => {
    split.connect(tap.delay, tap.config.from);
  });

  input.connect(split);

  return {
    input,
    output: merger,
    nodes: { taps },
    update(params, when) {
      taps.forEach((tap) => {
        setParam(tap.gain.gain, tap.config.gain * params.amount, when);
      });
    },
  };
}

/** 一阶低通 + 指数衰减的噪声，合成混响 IR（不打包音频文件）。 */
function createImpulseResponse(ctx, { durationMs, decay }) {
  const rate = ctx.sampleRate || 44100;
  const length = Math.max(1, Math.floor((durationMs / 1000) * rate));
  const buffer = ctx.createBuffer(2, length, rate);

  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let seed = 0x2f6e2b1 + channel * 7919;
    let lowpassed = 0;
    for (let i = 0; i < length; i++) {
      // 固定种子的 LCG：左右声道噪声不同，卷积后不会把声像收窄
      seed = (seed * 1664525 + 1013904223) % 0x100000000;
      const noise = (seed / 0x100000000) * 2 - 1;
      lowpassed = lowpassed * 0.62 + noise * 0.38;
      const progress = i / length;
      data[i] = lowpassed * Math.exp(-decay * 6 * progress);
    }
  }

  // 归一化能量，保证湿声与干声大致同量级
  let energy = 0;
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) energy += data[i] * data[i];
  }
  const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }

  return buffer;
}

function buildReverb(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const preDelay = ctx.createDelay(0.5);
  const convolver = ctx.createConvolver();

  dry.gain.value = 1;
  wet.gain.value = 0;

  input.connect(dry);
  dry.connect(output);
  input.connect(preDelay);
  preDelay.connect(convolver);
  convolver.connect(wet);
  wet.connect(output);

  const irCache = new Map();

  const getIr = ({ durationMs, decay }) => {
    const key = `${durationMs}|${decay}`;
    if (irCache.has(key)) return irCache.get(key);
    const buffer = createImpulseResponse(ctx, { durationMs, decay });
    if (irCache.size >= IR_CACHE_LIMIT) irCache.delete(irCache.keys().next().value);
    irCache.set(key, buffer);
    return buffer;
  };

  return {
    input,
    output,
    nodes: { dry, wet, preDelay, convolver },
    update(params, when) {
      setParam(dry.gain, 1 - params.wet, when);
      setParam(wet.gain, params.wet, when);
      setParam(preDelay.delayTime, params.preDelayMs / 1000, when);
      const buffer = getIr(params);
      if (buffer && convolver.buffer !== buffer) convolver.buffer = buffer;
    },
  };
}

/** 激励曲线：drive=0 时保持线性，避免无谓染色。 */
function createDriveCurve(drive) {
  const samples = 1024;
  const curve = new Float32Array(samples);
  const k = 1 + drive * 7;
  const norm = Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

function buildDynamics(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const compressor = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();

  makeup.gain.value = 1;
  compressor.knee.value = 6;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.25;

  input.connect(shaper);
  shaper.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(output);

  let driveApplied = 0;

  return {
    input,
    output,
    nodes: { shaper, compressor, makeup },
    update(params, when) {
      setParam(compressor.threshold, params.thresholdDb, when);
      setParam(compressor.ratio, params.ratio, when);
      setParam(makeup.gain, dbToGain(params.makeupDb), when);
      // 曲线重建比较贵，只在 drive 真的变了时才动
      if (Math.abs(params.drive - driveApplied) > 0.001) {
        driveApplied = params.drive;
        shaper.curve = params.drive > 0 ? createDriveCurve(params.drive) : null;
      }
    },
  };
}

const BLOCK_BUILDERS = Object.freeze({
  width: buildWidth,
  crossfeed: buildCrossfeed,
  spatial: buildSpatial,
  reverb: buildReverb,
  dynamics: buildDynamics,
});

const BLOCK_ORDER = Object.freeze(Object.keys(BLOCK_BUILDERS));

/**
 * 搭一条完整播放链。
 *
 * 某个效果块在当前环境不可用时（缺 API）会被整体跳过，
 * 只损失那一个效果，不影响播放和 EQ。
 *
 * @param {object} options
 * @param {AudioContext} options.ctx
 * @param {AudioNode} options.source
 * @param {AudioNode} options.destination
 * @param {() => number} [options.now]
 */
export function createAudioGraph({ ctx, source, destination, now = () => ctx.currentTime } = {}) {
  if (!ctx) throw new Error('createAudioGraph 需要 AudioContext');
  if (!source) throw new Error('createAudioGraph 需要 source');
  if (!destination) throw new Error('createAudioGraph 需要 destination');

  const preamp = ctx.createGain();
  preamp.gain.value = 1;

  const filters = EQ_FREQUENCIES.map((frequency) => {
    const filter = ctx.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.value = frequency;
    filter.Q.value = 1;
    filter.gain.value = 0;
    return filter;
  });

  let tail = source;
  tail.connect(preamp);
  tail = preamp;
  for (const filter of filters) {
    tail.connect(filter);
    tail = filter;
  }

  const blocks = {};
  for (const name of BLOCK_ORDER) {
    const build = BLOCK_BUILDERS[name];
    let block = null;
    try {
      block = createBlock(ctx, () => build(ctx));
    } catch (error) {
      console.warn(`[AudioGraph] 跳过效果块 ${name}：`, error?.message || error);
    }
    if (!block) continue;
    tail.connect(block.input);
    tail = block.output;
    blocks[name] = block;
  }

  tail.connect(destination);

  function applyEq(eq) {
    const when = now();
    const enabled = eq?.enabled !== false;
    setParam(preamp.gain, enabled ? dbToGain(eq?.preampDb || 0) : 1, when);

    for (let i = 0; i < filters.length; i++) {
      const frequency = EQ_FREQUENCIES[i];
      const band = (eq?.bands || []).find(item => Number(item.frequencyHz) === frequency);
      const gain = enabled && band ? Number(band.gainDb) || 0 : 0;
      setParam(filters[i].gain, gain, when);
    }
  }

  function applyEffects(effects) {
    const when = now();
    const normalized = normalizeEffects(effects);
    const master = normalized.enabled !== false;

    for (const name of BLOCK_ORDER) {
      const block = blocks[name];
      if (!block) continue;
      const params = normalized[name];
      const active = master && params.enabled === true;
      block.setActive(active, when);
      // 旁路的块不更新参数：省掉建 IR 之类的开销，重新启用时再算一次
      if (active) block.inner.update(params, when);
    }
  }

  return {
    ctx,
    preamp,
    filters,
    blocks,
    applyEq,
    applyEffects,
  };
}
