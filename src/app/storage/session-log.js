import { createId } from '../../core/ids.js';
import { CURRENT_SESSION_KEY, SESSIONS_KEY } from './keys.js';
import {
  parseSessionJsonl,
  serializeSessionJsonl,
  sessionJsonlFilename,
} from './session-jsonl.js';

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
const SCHEMA_VERSION = 3;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const NAME_LIMIT = 40;
const DEFAULT_SESSION_NAME = '新会话';
const DEFAULT_RENAME_FALLBACK = '未命名';
const SEARCH_TEXT_LIMIT = 32_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

const META = 'meta';
const SESSIONS = 'sessions';
const MESSAGES = 'messages';
const STATES = 'states';

const META_FIELDS = new Set([
  'id', 'name', 'createdAt', 'updatedAt', 'lastActiveAt',
  'lastSeq', 'messageCount', 'cartCount', 'songCount', 'resultCount',
  'hasResult', 'hasEq', 'archivedAt', 'pinnedAt',
  'summary', 'summaryThroughSeq', 'bytes', 'searchText',
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
    summary: null,
    summaryThroughSeq: null,
    bytes: 0,
    searchText: '',
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

function safeId(value, prefix, newId) {
  const raw = String(value || '');
  return SAFE_ID.test(raw) ? raw : newId(prefix);
}

function publicMeta(meta) {
  const { searchText: _searchText, ...rest } = meta || {};
  return rest;
}

/** 一条消息里值得检索的可见文本。 */
export function searchTextOfMessage(message) {
  if (!message) return '';
  const parts = [
    message.text,
    message.reason,
    message.name,
    message.plan?.topic,
    message.plan?.need,
    message.thinking?.text,
  ];
  if (Array.isArray(message.picks)) {
    for (const pick of message.picks) {
      parts.push(pick?.name, pick?.artists, pick?.reason);
    }
  }
  return parts.filter(part => typeof part === 'string' && part.trim()).join('\n');
}

function appendSearchText(current, addition) {
  const text = `${current || ''}\n${addition || ''}`.trim();
  return text.length > SEARCH_TEXT_LIMIT ? text.slice(-SEARCH_TEXT_LIMIT) : text;
}

function buildSearchText(messages) {
  return (Array.isArray(messages) ? messages : []).reduce(
    (text, message) => appendSearchText(text, searchTextOfMessage(message)),
    '',
  );
}

function estimateBytes(value) {
  try { return JSON.stringify(value ?? null).length; } catch { return 0; }
}

function estimateMessagesBytes(messages) {
  return (Array.isArray(messages) ? messages : [])
    .reduce((sum, message) => sum + estimateBytes(message), 0);
}

function estimateSessionBytes(messages, state) {
  return estimateMessagesBytes(messages) + estimateBytes(state);
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
        const id = safeId(raw?.id, 'sess', newId);
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
          hasEq: Boolean(state.cartEq || state.result?.eq || state.eq),
          archivedAt: raw?.archivedAt ?? null,
          pinnedAt: raw?.pinnedAt ?? null,
          summary: raw?.summary ?? null,
          summaryThroughSeq: Number(raw?.summaryThroughSeq ?? raw?.summary?.throughSeq) || null,
          bytes: estimateSessionBytes(messages, state),
          searchText: buildSearchText(messages),
        };

        sessionStore.put(meta);
        stateStore.put(state);

        messages.forEach((message, index) => {
          const seq = index + 1;
          messageStore.put({
            ...(message && typeof message === 'object' ? message : {}),
            id: safeId(message?.id, 'msg', newId),
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

  const backfillSearchMetadata = async (db) => {
    const tx = db.transaction([META, SESSIONS, MESSAGES], 'readwrite');
    const done = transactionDone(tx);
    const sessionStore = tx.objectStore(SESSIONS);
    const metas = await requestToPromise(sessionStore.getAll());
    const messages = await requestToPromise(tx.objectStore(MESSAGES).getAll());
    const messagesById = new Map();
    for (const message of messages) {
      const list = messagesById.get(message.sessionId) || [];
      list.push(message);
      messagesById.set(message.sessionId, list);
    }

    for (const meta of metas) {
      const list = messagesById.get(meta.id) || [];
      sessionStore.put({
        ...meta,
        bytes: estimateMessagesBytes(list),
        searchText: buildSearchText(list),
      });
    }
    tx.objectStore(META).put(metaRecord('schemaVersion', SCHEMA_VERSION));
    tx.objectStore(META).put(metaRecord('migratedAt', now()));
    await done;
  };

  const migrate = async (db) => {
    const version = Number(await getMetaValue(db, 'schemaVersion'));
    if (version >= SCHEMA_VERSION) return;
    if (version >= 2) {
      await backfillSearchMetadata(db);
      return;
    }

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
      ...publicMeta(meta),
      cart: Array.isArray(state?.cart) ? state.cart : [],
      cartEq: state?.cartEq ?? null,
      result: state?.result ?? null,
      messageCount,
      cartCount: Array.isArray(state?.cart) ? state.cart.length : (Number(meta?.cartCount) || 0),
      resultCount: resultCountOf(state?.result),
      hasResult: hasResultOf(state),
      hasEq: Boolean(state?.cartEq || state?.result?.eq || state?.eq),
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
    hasEq: Boolean(state.cartEq || state.result?.eq || state.eq),
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
          if (includeArchived || !cursor.value.archivedAt) result.push(publicMeta(cursor.value));
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
          searchText: appendSearchText(meta.searchText, searchTextOfMessage(stored)),
          bytes: (Number(meta.bytes) || 0) + estimateBytes(stored),
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
        nextMeta.bytes = Math.max(
          0,
          (Number(meta.bytes) || 0) - estimateBytes(state) + estimateBytes(nextState),
        );

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
        nextMeta.bytes = Math.max(
          0,
          (Number(meta.bytes) || 0) - estimateBytes(state) + estimateBytes(nextState),
        );

        tx.objectStore(STATES).put(nextState);
        tx.objectStore(SESSIONS).put(nextMeta);
        emit('update', sessionId);
        return output === undefined ? compose(nextMeta, nextState) : output;
      });
    },

    async setSummary(sessionId, summary) {
      return runTx([SESSIONS], 'readwrite', async tx => {
        const meta = await getMeta(tx, sessionId);
        if (!meta) throw new Error('找不到会话');
        const nextSummary = summary && typeof summary === 'object'
          ? {
            text: String(summary.text || ''),
            throughSeq: Number(summary.throughSeq) || 0,
            createdAt: Number(summary.createdAt) || now(),
            model: summary.model || null,
          }
          : null;
        const next = {
          ...meta,
          summary: nextSummary,
          summaryThroughSeq: nextSummary?.throughSeq || null,
          updatedAt: now(),
          bytes: Math.max(
            0,
            (Number(meta.bytes) || 0)
              - estimateBytes(meta.summary)
              + estimateBytes(nextSummary),
          ),
        };
        tx.objectStore(SESSIONS).put(next);
        emit('compact', sessionId);
        return publicMeta(next);
      });
    },

    async archive(id) {
      return runTx([META, SESSIONS], 'readwrite', async tx => {
        const meta = await getMeta(tx, id);
        if (!meta) throw new Error('找不到会话');
        const next = { ...meta, archivedAt: now(), updatedAt: now() };
        tx.objectStore(SESSIONS).put(next);

        const current = await requestToPromise(tx.objectStore(META).get(CURRENT_SESSION_KEY));
        if (current?.value === id) {
          const all = await requestToPromise(tx.objectStore(SESSIONS).getAll());
          const candidate = all
            .filter(item => item.id !== id && !item.archivedAt)
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
          if (candidate) {
            tx.objectStore(META).put(metaRecord(CURRENT_SESSION_KEY, candidate.id));
          }
        }
        emit('archive', id);
        return publicMeta(next);
      });
    },

    async unarchive(id) {
      return runTx([SESSIONS], 'readwrite', async tx => {
        const meta = await getMeta(tx, id);
        if (!meta) throw new Error('找不到会话');
        const next = { ...meta, archivedAt: null, updatedAt: now() };
        tx.objectStore(SESSIONS).put(next);
        emit('archive', id);
        return publicMeta(next);
      });
    },

    async search(query, { limit = 50 } = {}) {
      const needle = String(query || '').trim().toLowerCase().slice(0, 80);
      if (!needle) return [];
      const terms = needle.split(/\s+/).filter(Boolean);

      await ensureReady();
      const db = await open();
      const tx = db.transaction(SESSIONS, 'readonly');
      const done = transactionDone(tx);
      const metas = await requestToPromise(tx.objectStore(SESSIONS).getAll());
      await done;

      const results = [];
      for (const meta of metas) {
        const name = String(meta.name || '');
        const text = String(meta.searchText || '');
        const haystack = `${name}\n${text}`.toLowerCase();
        if (!terms.every(term => haystack.includes(term))) continue;

        const nameHit = terms.some(term => name.toLowerCase().includes(term));
        const matchCount = terms.reduce(
          (count, term) => count + (haystack.split(term).length - 1),
          0,
        );
        const index = haystack.indexOf(terms[0]);
        const start = Math.max(0, index - 28);
        const end = Math.min(haystack.length, index + needle.length + 42);
        const snippet = `${index > 0 ? '…' : ''}${`${name}\n${text}`.slice(start, end).replace(/\s+/g, ' ').trim()}${end < haystack.length ? '…' : ''}`;

        results.push({
          ...publicMeta(meta),
          score: matchCount + (nameHit ? 10 : 0),
          matchCount,
          snippet,
        });
      }

      return results
        .sort((a, b) => b.score - a.score || (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, limit);
    },

    async getStorageStats() {
      await ensureReady();
      const db = await open();
      const tx = db.transaction(SESSIONS, 'readonly');
      const done = transactionDone(tx);
      const metas = await requestToPromise(tx.objectStore(SESSIONS).getAll());
      await done;

      const bytes = metas.reduce((sum, meta) => sum + (Number(meta.bytes) || 0), 0);
      const messageCount = metas.reduce((sum, meta) => sum + (Number(meta.messageCount) || 0), 0);
      const top = metas
        .map(meta => ({ id: meta.id, name: meta.name, bytes: Number(meta.bytes) || 0 }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5);

      let usage = null;
      let quota = null;
      try {
        const estimate = await globalThis.navigator?.storage?.estimate?.();
        if (estimate) {
          usage = estimate.usage ?? null;
          quota = estimate.quota ?? null;
        }
      } catch {}

      let chromeBytes = null;
      try {
        const storage = globalThis.chrome?.storage?.local;
        if (storage && typeof storage.getBytesInUse === 'function') {
          chromeBytes = await storage.getBytesInUse(null);
        }
      } catch {}

      return {
        sessions: metas.length,
        archived: metas.filter(meta => meta.archivedAt).length,
        messages: messageCount,
        bytes,
        top,
        usage,
        quota,
        chromeBytes,
      };
    },

    /**
     * 写入一个完整会话（JSONL 导入 / 单会话恢复）。
     * 默认不覆盖同 id 会话：冲突时分配新 id，并可通过 overwrite=true 替换。
     */
    async putSession(raw, { overwrite = false, setCurrent = true } = {}) {
      const at = Number(raw?.createdAt) || now();
      return runTx([META, SESSIONS, MESSAGES, STATES], 'readwrite', async tx => {
        const requestedId = SAFE_ID.test(String(raw?.id || '')) ? String(raw.id) : '';
        let id = requestedId;
        if (!id) {
          do { id = newId('sess'); } while (await getMeta(tx, id));
        }
        let existing = requestedId ? await getMeta(tx, id) : null;
        let replaced = false;

        if (existing && !overwrite) {
          do { id = newId('sess'); } while (await getMeta(tx, id));
        } else if (existing) {
          replaced = true;
          tx.objectStore(MESSAGES).delete(
            keyRange.bound([id, 1], [id, Number.MAX_SAFE_INTEGER]),
          );
          tx.objectStore(STATES).delete(id);
        }

        const messages = Array.isArray(raw?.messages) ? raw.messages : [];
        const stored = messages.map((message, index) => ({
          ...(message && typeof message === 'object' ? message : {}),
          id: safeId(message?.id, 'msg', newId),
          sessionId: id,
          seq: index + 1,
        }));
        const state = {
          sessionId: id,
          cart: Array.isArray(raw?.cart) ? raw.cart : [],
          cartEq: raw?.cartEq ?? null,
          result: raw?.result ?? null,
          eq: raw?.eq ?? null,
          playlistSnapshot: raw?.playlistSnapshot ?? null,
        };
        const summary = raw?.summary && typeof raw.summary === 'object' ? raw.summary : null;
        const meta = {
          ...emptyMeta(id, normalizeName(raw?.name), at),
          updatedAt: Number(raw?.updatedAt || raw?.lastActiveAt) || at,
          lastActiveAt: Number(raw?.lastActiveAt) || at,
          lastSeq: stored.length,
          messageCount: stored.length,
          cartCount: state.cart.length,
          songCount: Number(raw?.songCount) || resultCountOf(state.result),
          resultCount: resultCountOf(state.result),
          hasResult: hasResultOf(state),
          hasEq: Boolean(state.cartEq || state.result?.eq || state.eq),
          archivedAt: raw?.archivedAt ?? null,
          pinnedAt: raw?.pinnedAt ?? null,
          summary,
          summaryThroughSeq: Number(raw?.summaryThroughSeq ?? summary?.throughSeq) || null,
          bytes: estimateSessionBytes(stored, state),
          searchText: buildSearchText(messages),
        };

        tx.objectStore(SESSIONS).put(meta);
        tx.objectStore(STATES).put(state);
        for (const message of stored) tx.objectStore(MESSAGES).put(message);
        if (setCurrent) {
          tx.objectStore(META).put(metaRecord(CURRENT_SESSION_KEY, id));
        }
        emit('import', id);
        return { ...compose(meta, state, { messages: stored.map(stripMessage) }), replaced };
      });
    },

    async exportJsonl(id) {
      const session = await store.get(id);
      if (!session) return null;
      return {
        filename: sessionJsonlFilename(session),
        content: serializeSessionJsonl(session),
      };
    },

    async importJsonl(text, options = {}) {
      const parsed = parseSessionJsonl(text);
      const session = await store.putSession(parsed.session, options);
      return {
        session,
        warnings: parsed.warnings,
        version: parsed.version,
      };
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
