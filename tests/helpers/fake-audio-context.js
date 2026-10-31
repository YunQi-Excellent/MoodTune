/**
 * 最小 AudioContext 替身：只实现 src/app/audio/graph.js 用到的那部分。
 *
 * 不做真实音频处理，只记录图结构与参数，方便断言「开关是否真的旁路」
 * 这类最容易出错、又最难在浏览器里肉眼验证的行为。
 */

function createParam(value = 0) {
  return {
    value,
    setTargetAtTime(next) { this.value = next; },
    cancelScheduledValues() {},
  };
}

function createNode(kind, extra = {}) {
  return {
    kind,
    connections: [],
    connect(destination, outputIndex = 0, inputIndex = 0) {
      this.connections.push({ destination, outputIndex, inputIndex });
      return destination;
    },
    disconnect() {
      this.connections.length = 0;
    },
    ...extra,
  };
}

export function createFakeAudioContext({ sampleRate = 48000, currentTime = 0 } = {}) {
  const created = [];

  const track = node => {
    created.push(node);
    return node;
  };

  const ctx = {
    sampleRate,
    currentTime,
    destination: createNode('destination'),
    state: 'running',

    createGain: () => track(createNode('gain', { gain: createParam(1) })),

    createBiquadFilter: () => track(createNode('biquad', {
      type: 'lowpass',
      frequency: createParam(350),
      Q: createParam(1),
      gain: createParam(0),
    })),

    createDelay: () => track(createNode('delay', { delayTime: createParam(0) })),

    createChannelSplitter: channels => track(createNode('splitter', {
      numberOfOutputs: channels,
    })),

    createChannelMerger: channels => track(createNode('merger', {
      numberOfInputs: channels,
    })),

    createWaveShaper: () => track(createNode('shaper', { curve: null, oversample: 'none' })),

    createDynamicsCompressor: () => track(createNode('compressor', {
      threshold: createParam(-24),
      knee: createParam(30),
      ratio: createParam(12),
      attack: createParam(0.003),
      release: createParam(0.25),
    })),

    createConvolver: () => track(createNode('convolver', { buffer: null, normalize: true })),

    createBuffer: (channels, length, rate) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        getChannelData: index => data[index],
      };
    },

    resume: async () => {},
  };

  return { ctx, created };
}

/** 收集整张图里所有节点，方便断言某类节点是否出现。 */
export function collectNodes(root) {
  const seen = new Set();
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    for (const edge of node.connections || []) queue.push(edge.destination);
  }
  return [...seen];
}
