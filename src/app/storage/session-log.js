import { createId } from '../../core/ids.js';
import { CURRENT_SESSION_KEY, SESSIONS_KEY } from './keys.js';

/**
 * 日志型会话仓储（IndexedDB）。
 *
 * 存储模型：
 * - sessions：会话元数据（列表只读这一层）
 * - messages：按 [sessionId, seq] 追加的消息记录
 * - states：购物车 / 结算结果等可变投影，和消息分开写
 * - meta：schemaVersion、currentSessionId、迁移状态
 *
 * 它替代了旧版「一个 chatSessions 数组整包读改写」的仓储：
 * 追加一条消息只写一条记录，列表不再携带消息体。
 */

const DB_NAME = 'moodtune-sessions';
const DB_VERSION = 2;
const SCHEMA_VERSION = 2;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const NAME_LIMIT = 40;
const DEFAULT_SESSION_NAME = '新会话';
const DEFAULT_RENAME_FALLBACK = '未命名';

const META = 'meta';
const SESSIONS = 'sessions';
const MESSAGES = 'messages';
const STATES = 'states';

const META_FIELDS = new Set([
  'id', 'name', 'createdAt', 'updatedAt', 'lastActiveAt',
  'lastSeq', 'messageCount', 'cartCount', 'songCount', 'resultCount',
  'hasResult', 'hasEq', 'archivedAt', 'pinnedAt',
]);

function normalizeName(value, fallback = DEFAULT_SESSION_NAME) {
  return String(value || fallback).trim().slice(0, NAME_LIMIT) || fallback;
}

function normalizePageSize(value, fallback = DEFAULT_PAGE_SIZE) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(n)));
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
  });
}

function openDatabase(indexedDB, dbName, onVersionChange = () => {}) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(SESSIONS)) {
        const store = db.createObjectStore(SESSIONS, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
        store.createIndex('archivedAt', 'archivedAt');
        store.createIndex('name', 'name');
      }
      if (!db.objectStoreNames.contains(MESSAGES)) {
        const store = db.createObjectStore(MESSAGES, { keyPath: ['sessionId', 'seq'] });
        store.createIndex('sessionId', 'sessionId');
        store.createIndex('sessionAt', ['sessionId', 'at']);
        store.createIndex('sessionMessageId', ['sessionId', 'id']);
      }
      if (!db.objectStoreNames.contains(STATES)) {
        db.createObjectStore(STATES, { keyPath: 'sessionId' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        onVersionChange();
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('打开会话数据库失败'));
    request.onblocked = () => reject(new Error('会话数据库被其他页面阻塞'));
  });
}

function metaRecord(key, value) {
  return { key, value };
}

function resultCountOf(result) {
  return Array.isArray(result?.playlist) ? result.playlist.length : 0;
}

function hasResultOf(state = {}) {
  return Boolean(state.result || state.eq || state.playlistSnapshot);
}

function emptyMeta(id, name, at) {
  return {
    id,
    name,
    createdAt: at,
    updatedAt: at,
    lastActiveAt: at,
    lastSeq: 0,
    messageCount: 0,
    cartCount: 0,
    songCount: 0,
    resultCount: 0,
    hasResult: false,
    hasEq: false,
    archivedAt: null,
    pinnedAt: null,
  };
}

function emptyState(sessionId, at) {
  return {
    sessionId,
    cart: [],
    cartEq: null,
    result: null,
    updatedAt: at,
  };
}

function stripMessage(record) {
  if (!record) return null;
  const { sessionId: _sessionId, ...message } = record;
  return message;
}

/**
 * @param {object} options
 * @param {{ get: Function, set: Function, remove: Function }} options.area 旧数据迁移来源
 * @param {IDBFactory} [options.indexedDB]
 * @param {typeof IDBKeyRange} [options.IDBKeyRange]
 * @param {() => number} [options.now]
 * @param {(prefix: string) => string} [options.newId]
 * @param {string} [options.dbName]
 * @param {number} [options.pageSize]
 * @param {(event: { type: string, sessionId?: string, message?: object }) => void} [options.onChange]
 */
export function createSessionLogStore({
  area,
  indexedDB: idb = globalThis.indexedDB,
  IDBKeyRange: keyRange = globalThis.IDBKeyRange,
  now = Date.now,
  newId = prefix => createId(prefix, now()),
  dbName = DB_NAME,
  pageSize = DEFAULT_PAGE_SIZE,
  onChange = () => {},
} = {}) {
  if (!area || typeof area.get !== 'function') {
    throw new Error('createSessionLogStore 需要 storage area');
  }
  if (!idb || !keyRange) {
    throw new Error('createSessionLogStore 需要 IndexedDB');
  }

  let dbPromise = null;
  let readyPromise = null;
  let pendingEvents = [];

  const open = () => {
    if (!dbPromise) {
      dbPromise = openDatabase(idb, dbName, () => {
        dbPromise = null;
        readyPromise = null;
      }).catch(error => {
        dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  };

  const getMetaValue = async (db, key) => {
    const tx = db.transaction(META, 'readonly');
    const row = await requestToPromise(tx.objectStore(META).get(key));
    return row?.value;
  };

  const writeAll = async (db, rawSessions, currentId, { clear = false } = {}) => {
    const list = Array.isArray(rawSessions) ? rawSessions : [];
    const tx = db.transaction([META, SESSIONS, MESSAGES, STATES], 'readwrite');
    const done = transactionDone(tx);
    const sessionStore = tx.objectStore(SESSIONS);
    const messageStore = tx.objectStore(MESSAGES);
    const stateStore = tx.objectStore(STATES);
    const metaStore = tx.objectStore(META);

    try {
      if (clear) {
        sessionStore.clear();
        messageStore.clear();
        stateStore.clear();
      }

      let firstSessionId = null;
      for (const raw of list) {
        const at = Number(raw?.createdAt) || now();
        const id = String(raw?.id || newId('sess'));
        const messages = Array.isArray(raw?.messages) ? raw.messages : [];
        const state = {
          sessionId: id,
          cart: Array.isArray(raw?.cart) ? raw.cart : [],
          cartEq: raw?.cartEq ?? null,
          result: raw?.result ?? null,
          eq: raw?.eq,
          playlistSnapshot: raw?.playlistSnapshot,
        };
        const meta = {
          ...emptyMeta(id, normalizeName(raw?.name), at),
          updatedAt: Number(raw?.updatedAt || raw?.lastActiveAt) || at,
          lastActiveAt: Number(raw?.lastActiveAt) || at,
          lastSeq: messages.length,
          messageCount: messages.length,
          cartCount: state.cart.length,
          songCount: Number(raw?.songCount) || resultCountOf(state.result),
          resultCount: resultCountOf(state.result),
          hasResult: hasResultOf(state),
          hasEq: Boolean(state.cartEq || state.result?.eq),
          archivedAt: raw?.archivedAt ?? null,
          pinnedAt: raw?.pinnedAt ?? null,
        };

        sessionStore.put(meta);
        stateStore.put(state);

        messages.forEach((message, index) => {
          const seq = index + 1;
          messageStore.put({
            ...(message && typeof message === 'object' ? message : {}),
            id: message?.id || newId('msg'),
            sessionId: id,
            seq,
          });
        });

        if (!firstSessionId) firstSessionId = id;
      }

      if (currentId !== undefined && currentId !== null) {
        metaStore.put(metaRecord(CURRENT_SESSION_KEY, currentId));
      } else if (currentId === null) {
        metaStore.delete(CURRENT_SESSION_KEY);
      } else if (firstSessionId) {
        metaStore.put(metaRecord(CURRENT_SESSION_KEY, firstSessionId));
      }

      metaStore.put(metaRecord('schemaVersion', SCHEMA_VERSION));
      metaStore.put(metaRecord('migratedAt', now()));
      await done;
    } catch (error) {
      try { tx.abort(); } catch {}
      throw error;
    }
  };

  const migrate = async (db) => {
    const version = Number(await getMetaValue(db, 'schemaVersion'));
    if (version >= SCHEMA_VERSION) return;

    const data = await area.get([SESSIONS_KEY, CURRENT_SESSION_KEY]);
    const legacy = Array.isArray(data?.[SESSIONS_KEY]) ? data[SESSIONS_KEY] : [];
    if (legacy.length === 0) {
      const tx = db.transaction(META, 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore(META).put(metaRecord('schemaVersion', SCHEMA_VERSION));
      tx.objectStore(META).put(metaRecord('migratedAt', now()));
      await done;
      return;
    }

    const currentId = data?.[CURRENT_SESSION_KEY];
    const validCurrentId = legacy.some(item => item?.id === currentId) ? currentId : undefined;
    await writeAll(db, legacy, validCurrentId);
  };

  const ensureReady = () => {
    if (!readyPromise) {
      readyPromise = (async () => {
        const db = await open();
        await migrate(db);
        return db;
      })().catch(error => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  };

  const runTx = async (stores, mode, task) => {
    await ensureReady();
    const db = await open();
    const tx = db.transaction(stores, mode);
    const done = transactionDone(tx);
    try {
      const result = await task(tx);
      await done;
      flushEvents();
      return result;
    } catch (error) {
      pendingEvents = [];
      try { tx.abort(); } catch {}
      throw error;
    }
  };

  const getMeta = (tx, id) => requestToPromise(tx.objectStore(SESSIONS).get(id));
  const getState = async (tx, id) => (
    await requestToPromise(tx.objectStore(STATES).get(id))
  ) || { sessionId: id, cart: [], cartEq: null, result: null };

  const compose = (meta, state = {}, page = {}) => {
    const { sessionId: _sessionId, ...stateValues } = state || {};
    const messages = Array.isArray(page.messages) ? page.messages : [];
    const messageCount = Number(meta?.messageCount) || 0;
    return {
      ...stateValues,
      ...meta,
      cart: Array.isArray(state?.cart) ? state.cart : [],
      cartEq: state?.cartEq ?? null,
      result: state?.result ?? null,
      messageCount,
      cartCount: Array.isArray(state?.cart) ? state.cart.length : (Number(meta?.cartCount) || 0),
      resultCount: resultCountOf(state?.result),
      hasResult: hasResultOf(state),
      hasEq: Boolean(state?.cartEq || state?.result?.eq),
      messages,
      hasMoreMessages: Boolean(page.hasMore),
      oldestSeq: page.oldestSeq ?? (messages[0]?.seq ?? null),
    };
  };

  const readAllMessages = async (tx, id) => {
    const records = await requestToPromise(
      tx.objectStore(MESSAGES).index('sessionId').getAll(keyRange.only(id)),
    );
    return records
      .sort((a, b) => a.seq - b.seq)
      .map(stripMessage);
  };

  const readPage = async (tx, id, { beforeSeq, limit } = {}) => {
    const size = normalizePageSize(limit, pageSize);
    const upper = Number.isFinite(Number(beforeSeq)) ? Number(beforeSeq) - 1 : Number.MAX_SAFE_INTEGER;
    const lower = 1;
    if (upper < lower) {
      return { messages: [], hasMore: false, oldestSeq: null };
    }

    const range = keyRange.bound([id, lower], [id, upper]);
    const store = tx.objectStore(MESSAGES);
    const records = await new Promise((resolve, reject) => {
      const result = [];
      const request = store.openCursor(range, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(result);
          return;
        }
        if (result.length < size + 1) {
          result.push(cursor.value);
          cursor.continue();
        } else {
          resolve(result);
        }
      };
      request.onerror = () => reject(request.error || new Error('读取消息分页失败'));
    });

    const hasMore = records.length > size;
    const page = records.slice(0, size).reverse().map(stripMessage);
    return {
      messages: page,
      hasMore,
      oldestSeq: page[0]?.seq ?? null,
    };
  };

  const applyStateCounts = (meta, state) => ({
    ...meta,
    cartCount: Array.isArray(state.cart) ? state.cart.length : 0,
    resultCount: resultCountOf(state.result),
    hasResult: hasResultOf(state),
    hasEq: Boolean(state.cartEq || state.result?.eq),
  });

  const emit = (type, sessionId, extra = {}) => {
    pendingEvents.push({ type, sessionId, ...extra });
  };

  const flushEvents = () => {
    const events = pendingEvents;
    pendingEvents = [];
    for (const event of events) {
      try { onChange(event); } catch {}
    }
  };

  const store = {
    ready: () => ensureReady(),

    /** 列表只返回元数据，不读消息体。 */
    async listSummaries({ limit = 100, includeArchived = false } = {}) {
      await ensureReady();
      const db = await open();
      const tx = db.transaction(SESSIONS, 'readonly');
      const done = transactionDone(tx);
      const index = tx.objectStore(SESSIONS).index('updatedAt');
      const result = [];

      await new Promise((resolve, reject) => {
        const request = index.openCursor(null, 'prev');
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || result.length >= limit) {
            resolve();
            return;
          }
          if (includeArchived || !cursor.value.archivedAt) result.push(cursor.value);
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('读取会话列表失败'));
      });

      await done;
      return result;
    },

    list(options) {
      return store.listSummaries(options);
    },

    async currentId() {
      await ensureReady();
      const db = await open();
      return (await getMetaValue(db, CURRENT_SESSION_KEY)) || null;
    },

    async get(id, { includeMessages = true } = {}) {
      return runTx([SESSIONS, STATES, MESSAGES], 'readonly', async tx => {
        const meta = await getMeta(tx, id);
        if (!meta) return null;
        const state = await getState(tx, id);
        const messages = includeMessages ? await readAllMessages(tx, id) : [];
        return compose(meta, state, { messages });
      });
    },

    async getCurrent(options) {
      const id = await store.currentId();
      return id ? store.get(id, options) : null;
    },

    /** 只返回元数据 + 购物车/结果，不读消息体。 */
    async getState(id) {
      return runTx([SESSIONS, STATES], 'readonly', async tx => {
        const meta = await getMeta(tx, id);
        if (!meta) return null;
        const state = await getState(tx, id);
        return compose(meta, state);
      });
    },

    async getPage(id, { beforeSeq, limit } = {}) {
      return runTx([SESSIONS, STATES, MESSAGES], 'readonly', async tx => {
        const meta = await getMeta(tx, id);
        if (!meta) return null;
        const state = await getState(tx, id);
        const page = await readPage(tx, id, { beforeSeq, limit });
        return compose(meta, state, page);
      });
    },

    async getCurrentPage(options) {
      const id = await store.currentId();
      return id ? store.getPage(id, options) : null;
    },

    /** 只取最近 N 条，用于聊天上下文，避免加载整段历史。 */
    async getRecent(id, limit = 60) {
      return runTx([SESSIONS, STATES, MESSAGES], 'readonly', async tx => {
        const meta = await getMeta(tx, id);
        if (!meta) return null;
        const state = await getState(tx, id);
        const page = await readPage(tx, id, { limit });
        return compose(meta, state, page);
      });
    },

    async create(name) {
      const at = now();
      return runTx([META, SESSIONS, STATES], 'readwrite', async tx => {
        const id = newId('sess');
        const meta = emptyMeta(id, normalizeName(name), at);
        const state = emptyState(id, at);
        tx.objectStore(SESSIONS).put(meta);
        tx.objectStore(STATES).put(state);
        tx.objectStore(META).put(metaRecord(CURRENT_SESSION_KEY, id));
        emit('create', id);
        return compose(meta, state);
      });
    },

    async switchTo(id) {
      return runTx([META, SESSIONS, STATES], 'readwrite', async tx => {
        const meta = await getMeta(tx, id);
        if (!meta) throw new Error('找不到这个会话');
        tx.objectStore(META).put(metaRecord(CURRENT_SESSION_KEY, id));
        const state = await getState(tx, id);
        emit('switch', id);
        return compose(meta, state);
      });
    },

    async setCurrent(id) {
      return runTx([META], 'readwrite', async tx => {
        if (id) tx.objectStore(META).put(metaRecord(CURRENT_SESSION_KEY, id));
        else tx.objectStore(META).delete(CURRENT_SESSION_KEY);
        emit('switch', id);
      });
    },

    async remove(id) {
      return runTx([META, SESSIONS, MESSAGES, STATES], 'readwrite', async tx => {
        const sessionStore = tx.objectStore(SESSIONS);
        sessionStore.delete(id);
        tx.objectStore(STATES).delete(id);
        tx.objectStore(MESSAGES).delete(keyRange.bound([id, 1], [id, Number.MAX_SAFE_INTEGER]));

        const remaining = await requestToPromise(sessionStore.getAll());
        const next = remaining
          .filter(item => item.id !== id)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        const current = await requestToPromise(tx.objectStore(META).get(CURRENT_SESSION_KEY));
        if (current?.value === id) {
          if (next) tx.objectStore(META).put(metaRecord(CURRENT_SESSION_KEY, next.id));
          else tx.objectStore(META).delete(CURRENT_SESSION_KEY);
        }
        emit('remove', id);
        return remaining.filter(item => item.id !== id);
      });
    },

    async rename(id, name) {
      return runTx([SESSIONS], 'readwrite', async tx => {
        const meta = await getMeta(tx, id);
        if (!meta) throw new Error('找不到会话');
        const next = {
          ...meta,
          name: normalizeName(name, DEFAULT_RENAME_FALLBACK),
          updatedAt: now(),
        };
        tx.objectStore(SESSIONS).put(next);
        emit('rename', id);
        return next;
      });
    },

    async appendMessage(sessionId, message) {
      const at = now();
      return runTx([SESSIONS, MESSAGES, STATES], 'readwrite', async tx => {
        const id = String(sessionId || newId('sess'));
        let meta = await getMeta(tx, id);
        if (!meta) {
          meta = emptyMeta(id, DEFAULT_SESSION_NAME, at);
        }

        const messageId = message?.id || newId('msg');
        const existing = await requestToPromise(
          tx.objectStore(MESSAGES).index('sessionMessageId').get([id, messageId]),
        );
        if (existing) {
          const state = await getState(tx, id);
          return compose(meta, state, { messages: [stripMessage(existing)] });
        }

        const seq = (Number(meta.lastSeq) || 0) + 1;
        const stored = {
          ...(message && typeof message === 'object' ? message : {}),
          id: messageId,
          sessionId: id,
          seq,
        };
        tx.objectStore(MESSAGES).put(stored);

        const nextMeta = {
          ...meta,
          lastSeq: seq,
          messageCount: (Number(meta.messageCount) || 0) + 1,
          lastActiveAt: at,
          updatedAt: at,
        };
        tx.objectStore(SESSIONS).put(nextMeta);

        emit('append', id, { message: stripMessage(stored) });
        return compose(nextMeta, {}, { messages: [stripMessage(stored)] });
      });
    },

    async update(sessionId, patch = {}) {
      return runTx([SESSIONS, STATES], 'readwrite', async tx => {
        const meta = await getMeta(tx, sessionId);
        if (!meta) return null;
        const state = await getState(tx, sessionId);
        const metaPatch = {};
        const statePatch = {};

        for (const [key, value] of Object.entries(patch)) {
          if (META_FIELDS.has(key)) metaPatch[key] = value;
          else statePatch[key] = value;
        }

        const nextState = { ...state, ...statePatch, sessionId };
        const nextMeta = applyStateCounts({
          ...meta,
          ...metaPatch,
          updatedAt: now(),
          lastActiveAt: patch.lastActiveAt ?? now(),
        }, nextState);

        tx.objectStore(STATES).put(nextState);
        tx.objectStore(SESSIONS).put(nextMeta);
        emit('update', sessionId);
        return compose(nextMeta, nextState);
      });
    },

    async mutate(sessionId, mutator, { notFoundMessage = '找不到会话' } = {}) {
      return runTx([SESSIONS, STATES], 'readwrite', async tx => {
        const meta = await getMeta(tx, sessionId);
        if (!meta) throw new Error(notFoundMessage);
        const state = await getState(tx, sessionId);
        const draft = { ...state, ...meta, sessionId };
        const output = mutator(draft);

        const metaPatch = {};
        const statePatch = {};
        for (const [key, value] of Object.entries(draft)) {
          if (key === 'sessionId' || key === 'messages') continue;
          if (META_FIELDS.has(key)) metaPatch[key] = value;
          else statePatch[key] = value;
        }

        const nextState = { ...state, ...statePatch, sessionId };
        const nextMeta = applyStateCounts({
          ...meta,
          ...metaPatch,
          updatedAt: now(),
          lastActiveAt: now(),
        }, nextState);

        tx.objectStore(STATES).put(nextState);
        tx.objectStore(SESSIONS).put(nextMeta);
        emit('update', sessionId);
        return output === undefined ? compose(nextMeta, nextState) : output;
      });
    },

    async replaceAll(sessions, currentId) {
      const db = await ensureReady();
      await writeAll(db, sessions, currentId, { clear: true });
      emit('replace', undefined);
      flushEvents();
      return store.listSummaries();
    },

    async exportAll() {
      return runTx([SESSIONS, STATES, MESSAGES], 'readonly', async tx => {
        const metas = await requestToPromise(tx.objectStore(SESSIONS).getAll());
        const states = await requestToPromise(tx.objectStore(STATES).getAll());
        const records = await requestToPromise(tx.objectStore(MESSAGES).getAll());
        const stateById = new Map(states.map(state => [state.sessionId, state]));
        const messagesById = new Map();
        for (const record of records) {
          const list = messagesById.get(record.sessionId) || [];
          list.push(record);
          messagesById.set(record.sessionId, list);
        }

        return metas
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .map(meta => {
            const state = stateById.get(meta.id) || emptyState(meta.id, meta.createdAt);
            const messages = (messagesById.get(meta.id) || [])
              .sort((a, b) => a.seq - b.seq)
              .map(stripMessage);
            return compose(meta, state, { messages });
          });
      });
    },
  };

  return store;
}

export const SESSION_LOG_DB_VERSION = DB_VERSION;
export const SESSION_LOG_SCHEMA_VERSION = SCHEMA_VERSION;
export const SESSION_LOG_DB_NAME = DB_NAME;
