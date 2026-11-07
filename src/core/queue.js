/**
 * 串行队列：把「读 → 改 → 写」这类不能交错的任务排队执行。
 *
 * background 的多个入口（用户点购物车、LLM 流式追加消息、文件恢复）
 * 会同时操作同一份 storage 数据。chrome.storage 只保证单次 get/set 原子，
 * 不保证跨调用的读改写原子，所以所有写入都必须经过队列。
 *
 * 队列本身不依赖 chrome / DOM，方便单元测试。
 */

function swallow(promise) {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * 全局串行：所有任务按提交顺序逐个执行。
 * 前一个任务失败不会阻断后面的任务，但失败会原样抛给提交者。
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  let size = 0;

  return {
    get size() {
      return size;
    },
    /**
     * @template T
     * @param {() => T | Promise<T>} task
     * @returns {Promise<T>}
     */
    run(task) {
      size += 1;
      const result = tail.then(() => task());
      tail = swallow(result).then(() => {
        size -= 1;
      });
      return result;
    },
  };
}

/**
 * 按键串行：同一个 key 的任务排队，不同 key 之间并行。
 * 用于让各个存储键互不阻塞，同时保证同一键内的读改写有序。
 */
export function createKeyedQueue() {
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();
  /** @type {Map<string, number>} */
  const counts = new Map();

  function release(key) {
    const left = (counts.get(key) || 1) - 1;
    if (left > 0) counts.set(key, left);
    else counts.delete(key);
  }

  return {
    /** 该 key 上尚未完成的任务数（含正在执行与排队中的）。 */
    size(key) {
      return counts.get(key) || 0;
    },
    /** 所有 key 上尚未完成的任务总数。 */
    get total() {
      let total = 0;
      for (const n of counts.values()) total += n;
      return total;
    },
    /**
     * @template T
     * @param {string} key
     * @param {() => T | Promise<T>} task
     * @returns {Promise<T>}
     */
    run(key, task) {
      const previous = tails.get(key) || Promise.resolve();
      counts.set(key, (counts.get(key) || 0) + 1);

      const result = previous.then(() => task());
      const settled = swallow(result).then(() => release(key));

      tails.set(key, settled);
      settled.then(() => {
        if (tails.get(key) === settled) tails.delete(key);
      });

      return result;
    },
  };
}
