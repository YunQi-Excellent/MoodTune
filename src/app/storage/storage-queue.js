import { createKeyedQueue } from '../../core/queue.js';

/**
 * 全扩展共享的 storage 写队列。
 *
 * background 的各个仓储（会话 / 播放列表 / 调音预设）和 fs-sync 的
 * 「从文件夹恢复」共用这一把锁，避免两个读改写事务交错后互相覆盖。
 * 队列按 storage key 分片，不同 key 之间仍然并行。
 */
export const storageQueue = createKeyedQueue();
