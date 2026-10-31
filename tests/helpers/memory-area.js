/**
 * 内存版 chrome.storage.local。
 *
 * - get / set / remove 都是异步的，语义与扩展一致
 * - 读写都做结构化克隆，贴近真实 chrome.storage 的隔离行为
 *   （调用方拿到的是副本，改副本不会影响存储）
 * - delay > 0 时人为拉长每次读写，用来暴露「读改写」竞态
 */
export function createMemoryArea({ delay = 0, data = {} } = {}) {
  const state = structuredClone(data);
  const wait = () => (delay > 0 ? new Promise(resolve => setTimeout(resolve, delay)) : Promise.resolve());

  function pick(keys) {
    if (keys === undefined || keys === null) return structuredClone(state);
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) {
      if (key in state) out[key] = structuredClone(state[key]);
    }
    return out;
  }

  return {
    /** 当前全部数据（副本），断言用。 */
    snapshot() {
      return structuredClone(state);
    },
    async get(keys) {
      await wait();
      return pick(keys);
    },
    async set(items) {
      await wait();
      for (const [key, value] of Object.entries(items)) {
        if (value === undefined) delete state[key];
        else state[key] = structuredClone(value);
      }
    },
    async remove(keys) {
      await wait();
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
  };
}
