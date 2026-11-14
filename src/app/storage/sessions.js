import { SESSION_CONFIG } from '../../core/constants.js';
import { createId } from '../../core/ids.js';
import { storageQueue } from './storage-queue.js';
import { CURRENT_SESSION_KEY, SESSIONS_KEY } from './keys.js';

export { CURRENT_SESSION_KEY, SESSIONS_KEY };

const NAME_LIMIT = 40;
const DEFAULT_SESSION_NAME = '新会话';
const DEFAULT_RENAME_FALLBACK = '未命名';

function normalizeName(value, fallback) {
  return String(value || fallback).trim().slice(0, NAME_LIMIT) || fallback;
}

function emptySession(id, name, createdAt) {
  return {
    id,
    name,
    createdAt,
    messages: [],
    cart: [],
    cartEq: null,
    result: null,
    songCount: 0,
    lastActiveAt: createdAt,
  };
}

/**
 * 旧版 v1 会话仓储（chatSessions 单数组）。
 *
 * 生产运行时已经切到 src/app/storage/session-log.js 的 IndexedDB 日志仓储；
 * 这个文件保留为迁移对照/回归测试，并作为没有 IndexedDB 的环境的参考实现。
 *
 * 所有方法都经过 storage 队列，因此并发调用不会丢写：
 * 例如 LLM 追加消息与用户把歌加入购物车同时发生时，
 * 后提交的事务一定能看到前一个事务的结果。
 *
 * @param {object} options
 * @param {{ get: Function, set: Function, remove: Function }} options.area
 * @param {{ run: Function }} [options.queue]
 * @param {() => number} [options.now]
 * @param {(prefix: string) => string} [options.newId]
 * @param {number} [options.maxSessions]
 * @param {number} [options.maxMessages]
 */
export function createSessionStore({
  area,
  queue = storageQueue,
  now = Date.now,
  newId = prefix => createId(prefix, now()),
  maxSessions = SESSION_CONFIG.maxSessions,
  maxMessages = SESSION_CONFIG.maxMessagesPerSession,
} = {}) {
  if (!area || typeof area.get !== 'function') {
    throw new Error('createSessionStore 需要 storage area');
  }

  const readSessions = async () => {
    const data = await area.get(SESSIONS_KEY);
    return Array.isArray(data?.[SESSIONS_KEY]) ? data[SESSIONS_KEY] : [];
  };
  const readCurrentId = async () => {
    const data = await area.get(CURRENT_SESSION_KEY);
    return data?.[CURRENT_SESSION_KEY] || null;
  };
  const writeSessions = sessions => area.set({ [SESSIONS_KEY]: sessions });
  const writeCurrentId = id => (id
    ? area.set({ [CURRENT_SESSION_KEY]: id })
    : area.remove(CURRENT_SESSION_KEY));

  /**
   * 在 chatSessions 这把锁里执行一段读改写逻辑。
   * 注意：task 内部不要再调用本仓储的其他方法，否则会等待自己造成死锁。
   */
  const transaction = task => queue.run(SESSIONS_KEY, task);

  const store = {
    /** 全部会话（数组顺序即侧边栏顺序）。 */
    list() {
      return transaction(readSessions);
    },

    currentId() {
      return transaction(readCurrentId);
    },

    get(id) {
      return transaction(async () => {
        const sessions = await readSessions();
        return sessions.find(s => s.id === id) || null;
      });
    },

    getCurrent() {
      return transaction(async () => {
        const currentId = await readCurrentId();
        if (!currentId) return null;
        const sessions = await readSessions();
        return sessions.find(s => s.id === currentId) || null;
      });
    },

    create(name) {
      return transaction(async () => {
        const sessions = await readSessions();
        const createdAt = now();
        const session = emptySession(
          newId('sess'),
          normalizeName(name, DEFAULT_SESSION_NAME),
          createdAt,
        );
        sessions.unshift(session);
        if (sessions.length > maxSessions) sessions.length = maxSessions;
        await writeSessions(sessions);
        await writeCurrentId(session.id);
        return session;
      });
    },

    switchTo(id) {
      return transaction(async () => {
        const sessions = await readSessions();
        const target = sessions.find(s => s.id === id);
        if (!target) throw new Error('找不到这个会话');
        await writeCurrentId(id);
        return target;
      });
    },

    /** 只改 currentSessionId，不校验会话是否存在（用于恢复流程）。 */
    setCurrent(id) {
      return transaction(() => writeCurrentId(id));
    },

    remove(id) {
      return transaction(async () => {
        const sessions = await readSessions();
        const next = sessions.filter(s => s.id !== id);
        await writeSessions(next);
        if ((await readCurrentId()) === id) {
          await writeCurrentId(next.length > 0 ? next[0].id : null);
        }
        return next;
      });
    },

    rename(id, name) {
      return transaction(async () => {
        const sessions = await readSessions();
        const target = sessions.find(s => s.id === id);
        if (!target) throw new Error('找不到会话');
        target.name = normalizeName(name, DEFAULT_RENAME_FALLBACK);
        await writeSessions(sessions);
        return target;
      });
    },

    appendMessage(sessionId, message) {
      return transaction(async () => {
        const sessions = await readSessions();
        const target = sessions.find(s => s.id === sessionId);

        if (!target) {
          const createdAt = now();
          const fresh = emptySession(
            sessionId || `sess-${createdAt.toString(36)}`,
            DEFAULT_SESSION_NAME,
            createdAt,
          );
          fresh.messages.push(message);
          fresh.lastActiveAt = createdAt;
          sessions.unshift(fresh);
          await writeSessions(sessions);
          return fresh;
        }

        if (message?.id && target.messages?.some(m => m.id === message.id)) return target;

        target.messages = Array.isArray(target.messages) ? target.messages : [];
        target.messages.push(message);
        if (target.messages.length > maxMessages) {
          target.messages = target.messages.slice(-maxMessages);
        }
        target.lastActiveAt = now();
        await writeSessions(sessions);
        return target;
      });
    },

    update(sessionId, patch) {
      return transaction(async () => {
        const sessions = await readSessions();
        const target = sessions.find(s => s.id === sessionId);
        if (!target) return null;
        Object.assign(target, patch);
        target.lastActiveAt = now();
        await writeSessions(sessions);
        return target;
      });
    },

    /**
     * 在锁内直接修改会话对象。mutator 必须是同步的，
     * 返回值会透传（返回 undefined 时透传会话本身）。
     */
    mutate(sessionId, mutator, { notFoundMessage = '找不到会话' } = {}) {
      return transaction(async () => {
        const sessions = await readSessions();
        const target = sessions.find(s => s.id === sessionId);
        if (!target) throw new Error(notFoundMessage);
        const output = mutator(target);
        target.lastActiveAt = now();
        await writeSessions(sessions);
        return output === undefined ? target : output;
      });
    },

    /**
     * 整表替换（供「从文件夹恢复」使用）。
     * @param {object[]} sessions
     * @param {string} [currentId] 传 undefined 表示不动 currentSessionId
     */
    replaceAll(sessions, currentId) {
      return transaction(async () => {
        const list = Array.isArray(sessions) ? sessions : [];
        await writeSessions(list);
        if (currentId !== undefined) await writeCurrentId(currentId || null);
        return list;
      });
    },
  };

  return store;
}
