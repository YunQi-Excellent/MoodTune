import { defaultEq as makeDefaultEq } from '../../core/eq.js';
import { createId } from '../../core/ids.js';
import { trackKey } from '../../core/track.js';

/**
 * 会话服务：会话本身、购物车、结算与恢复。
 *
 * 仓储只负责「存」，这里负责「存之前之后还要做什么」：
 * 结算要推歌单给播放器、恢复要重新应用 EQ、打开 EQ 面板要插入一张卡片。
 *
 * @param {object} options
 * @param {object} options.store 会话仓储（src/app/storage/session-log.js）
 * @param {object} options.player 播放器服务（src/app/services/player.js）
 * @param {(song: object) => object} options.normalizeSong 歌曲归一化
 * @param {() => object} [options.defaultEq] 平坦 EQ 构造器
 * @param {(prefix: string) => string} [options.newId]
 * @param {() => number} [options.now]
 * @param {(event: object) => void} [options.onChange] 会话变化通知
 */
export function createSessionService({
  store,
  player,
  normalizeSong,
  defaultEq = makeDefaultEq,
  newId = prefix => createId(prefix),
  now = () => Date.now(),
  onChange = () => {},
} = {}) {
  if (!store) throw new Error('createSessionService 需要 store');
  if (!player) throw new Error('createSessionService 需要 player');
  if (typeof normalizeSong !== 'function') throw new Error('createSessionService 需要 normalizeSong');

  const requireSession = async (sessionId) => {
    const session = await store.get(sessionId);
    if (!session) throw new Error('找不到会话');
    return session;
  };

  const notify = (type, sessionId, extra = {}) => {
    try { onChange({ type, sessionId, ...extra }); } catch {}
  };

  const mutate = async (sessionId, mutator, options) => {
    const result = await store.mutate(sessionId, mutator, options);
    notify('update', sessionId);
    return result;
  };

  const update = async (sessionId, patch) => {
    const result = await store.update(sessionId, patch);
    if (result) notify('update', sessionId);
    return result;
  };

  const appendMessage = async (sessionId, message) => {
    const result = await store.appendMessage(sessionId, message);
    const stored = result?.messages?.[0];
    notify('append', sessionId, { message: stored });
    return result;
  };

  const service = {
    /* ---- 基本操作 ---- */
    list: () => (store.listSummaries ? store.listSummaries() : store.list()),
    current: () => store.getCurrent(),
    currentPage: options => (
      store.getCurrentPage ? store.getCurrentPage(options) : store.getCurrent()
    ),
    get: id => store.get(id),
    state: id => (store.getState ? store.getState(id) : store.get(id)),
    getPage: (id, options) => (
      store.getPage ? store.getPage(id, options) : store.get(id)
    ),
    recent: (id, limit) => (
      store.getRecent ? store.getRecent(id, limit) : store.get(id)
    ),
    recentCurrent: limit => (
      store.getCurrentPage ? store.getCurrentPage({ limit }) : store.getCurrent()
    ),
    exportJsonl: id => (store.exportJsonl ? store.exportJsonl(id) : null),
    importJsonl: (text, options) => (
      store.importJsonl ? store.importJsonl(text, options) : null
    ),

    async loadEarlier(sessionId, beforeSeq, limit) {
      if (!store.getPage) return null;
      const page = await store.getPage(sessionId, { beforeSeq, limit });
      if (!page) return null;
      return {
        messages: page.messages,
        hasMore: page.hasMoreMessages,
        oldestSeq: page.oldestSeq,
        messageCount: page.messageCount,
      };
    },

    async create(name) {
      const session = await store.create(name);
      notify('create', session.id);
      return store.getPage ? ((await store.getPage(session.id)) || session) : session;
    },

    async switchTo(id) {
      const session = await store.switchTo(id);
      notify('switch', id);
      return store.getPage ? ((await store.getPage(id)) || session) : session;
    },

    async remove(id) {
      const remaining = await store.remove(id);
      notify('remove', id);
      return remaining;
    },

    async rename(id, name) {
      const result = await store.rename(id, name);
      notify('rename', id);
      return result;
    },

    appendMessage,
    update,

    updateResultSource(sessionId, { playlistSource, eqSource } = {}) {
      return mutate(sessionId, session => {
        if (!session.result) throw new Error('会话或结果不存在');
        if (playlistSource !== undefined) session.result.playlistSource = playlistSource;
        if (eqSource !== undefined) session.result.eqSource = eqSource;
      }, { notFoundMessage: '会话或结果不存在' });
    },

    /* ---- 购物车 ---- */
    cart: {
      async add(sessionId, songs) {
        if (!Array.isArray(songs) || songs.length === 0) return null;
        return mutate(sessionId, session => {
          session.cart = Array.isArray(session.cart) ? session.cart : [];
          const identityOf = song => trackKey(song) || String(song.id);
          const existing = new Set(session.cart.map(identityOf));
          let added = 0;
          for (const song of songs) {
            if (existing.has(identityOf(song))) continue;
            session.cart.push(normalizeSong(song));
            existing.add(identityOf(song));
            added += 1;
          }
          return { added, total: session.cart.length };
        });
      },

      remove(sessionId, songIds) {
        const removeSet = new Set((Array.isArray(songIds) ? songIds : []).map(String));
        return mutate(sessionId, session => {
          session.cart = (session.cart || []).filter(song => !removeSet.has(String(song.id)));
          return { total: session.cart.length };
        });
      },

      reorder(sessionId, orderedIds) {
        return mutate(sessionId, session => {
          const cartById = new Map((session.cart || []).map(song => [String(song.id), song]));
          const next = [];
          for (const id of orderedIds) {
            const song = cartById.get(String(id));
            if (song) {
              next.push(song);
              cartById.delete(String(id));
            }
          }
          for (const song of cartById.values()) next.push(song);
          session.cart = next;
          return { total: next.length };
        });
      },

      clear(sessionId) {
        return mutate(sessionId, session => {
          session.cart = [];
          return { total: 0 };
        });
      },

      setEq(sessionId, eq) {
        return update(sessionId, { cartEq: eq || null });
      },

      /** 把购物车推给播放器，并把结果快照存进会话。 */
      async settle(sessionId) {
        const session = await requireSession(sessionId);
        const cart = Array.isArray(session.cart) ? session.cart : [];
        if (cart.length === 0) throw new Error('会话歌单是空的');

        let appliedEq = null;
        if (session.cartEq) {
          try {
            const response = await player.setEq(session.cartEq);
            if (response?.ok) appliedEq = response.eq || session.cartEq;
          } catch {}
        }

        await player.pauseExternal();
        await player.setPlaylist(cart, true);

        const result = {
          playlist: cart.map(normalizeSong),
          eq: appliedEq || session.cartEq || null,
          playlistSource: session.result?.playlistSource || null,
          eqSource: session.result?.eqSource || null,
          settledAt: now(),
        };
        await update(sessionId, { result, songCount: cart.length });
        return { ok: true, count: cart.length, result };
      },
    },

    /* ---- 恢复 ---- */
    async restore(id) {
      const session = await requireSession(id);

      const result = { eq: null, songCount: 0, messages: [] };
      const snapshot = session.result;

      if (snapshot) {
        if (snapshot.eq) {
          try {
            const response = await player.setEq(snapshot.eq);
            if (response?.ok) {
              result.eq = response.eq || snapshot.eq;
              result.messages.push('已应用调音快照');
            }
          } catch (e) {
            result.messages.push('恢复调音失败：' + (e?.message || e));
          }
        }
        if (Array.isArray(snapshot.playlist) && snapshot.playlist.length > 0) {
          try {
            await player.pauseExternal();
            await player.setPlaylist(snapshot.playlist, true);
            result.songCount = snapshot.playlist.length;
            result.messages.push(`已恢复 ${snapshot.playlist.length} 首歌`);
          } catch (e) {
            result.messages.push('恢复歌单失败：' + (e?.message || e));
          }
        }
      } else {
        if (session.eq) {
          try {
            const response = await player.setEq(session.eq);
            if (response?.ok) result.eq = response.eq || session.eq;
          } catch {}
        }
        if (Array.isArray(session.playlistSnapshot) && session.playlistSnapshot.length > 0) {
          try {
            await player.pauseExternal();
            await player.setPlaylist(session.playlistSnapshot, true);
            result.songCount = session.playlistSnapshot.length;
          } catch {}
        }
      }

      await store.setCurrent(id);
      notify('switch', id);
      return result;
    },

    /** 聊天里「打开调音台」：确保有会话，然后插入一张 EQ 卡片。 */
    async openEqPanel() {
      let session = await store.getCurrent();
      if (!session) session = await store.create('新会话');
      const currentEq = session.cartEq || session.result?.eq || defaultEq();
      const messageId = newId('msg');
      await service.appendMessage(session.id, {
        id: messageId,
        role: 'agent',
        kind: 'eq-card',
        eq: currentEq,
        reason: null,
        at: now(),
      });
      return { messageId };
    },
  };

  return service;
}
