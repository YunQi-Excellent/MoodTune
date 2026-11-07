import { defaultEq as makeDefaultEq } from '../../core/eq.js';
import { createId } from '../../core/ids.js';

/**
 * 会话服务：会话本身、购物车、结算与恢复。
 *
 * 仓储只负责「存」，这里负责「存之前之后还要做什么」：
 * 结算要推歌单给播放器、恢复要重新应用 EQ、打开 EQ 面板要插入一张卡片。
 *
 * @param {object} options
 * @param {object} options.store 会话仓储（src/app/storage/sessions.js）
 * @param {object} options.player 播放器服务（src/app/services/player.js）
 * @param {(song: object) => object} options.normalizeSong 歌曲归一化
 * @param {() => object} [options.defaultEq] 平坦 EQ 构造器
 * @param {(prefix: string) => string} [options.newId]
 * @param {() => number} [options.now]
 */
export function createSessionService({
  store,
  player,
  normalizeSong,
  defaultEq = makeDefaultEq,
  newId = prefix => createId(prefix),
  now = () => Date.now(),
} = {}) {
  if (!store) throw new Error('createSessionService 需要 store');
  if (!player) throw new Error('createSessionService 需要 player');
  if (typeof normalizeSong !== 'function') throw new Error('createSessionService 需要 normalizeSong');

  const requireSession = async (sessionId) => {
    const session = await store.get(sessionId);
    if (!session) throw new Error('找不到会话');
    return session;
  };

  const service = {
    /* ---- 基本操作 ---- */
    list: () => store.list(),
    current: () => store.getCurrent(),
    get: id => store.get(id),
    create: name => store.create(name),
    switchTo: id => store.switchTo(id),
    remove: id => store.remove(id),
    rename: (id, name) => store.rename(id, name),
    appendMessage: (id, message) => store.appendMessage(id, message),
    update: (id, patch) => store.update(id, patch),

    updateResultSource(sessionId, { playlistSource, eqSource } = {}) {
      return store.mutate(sessionId, session => {
        if (!session.result) throw new Error('会话或结果不存在');
        if (playlistSource !== undefined) session.result.playlistSource = playlistSource;
        if (eqSource !== undefined) session.result.eqSource = eqSource;
      }, { notFoundMessage: '会话或结果不存在' });
    },

    /* ---- 购物车 ---- */
    cart: {
      async add(sessionId, songs) {
        if (!Array.isArray(songs) || songs.length === 0) return null;
        return store.mutate(sessionId, session => {
          session.cart = Array.isArray(session.cart) ? session.cart : [];
          const existing = new Set(session.cart.map(song => song.id));
          let added = 0;
          for (const song of songs) {
            if (existing.has(song.id)) continue;
            session.cart.push(normalizeSong(song));
            existing.add(song.id);
            added += 1;
          }
          return { added, total: session.cart.length };
        });
      },

      remove(sessionId, songIds) {
        const removeSet = new Set(songIds);
        return store.mutate(sessionId, session => {
          session.cart = (session.cart || []).filter(song => !removeSet.has(song.id));
          return { total: session.cart.length };
        });
      },

      reorder(sessionId, orderedIds) {
        return store.mutate(sessionId, session => {
          const cartById = new Map((session.cart || []).map(song => [song.id, song]));
          const next = [];
          for (const id of orderedIds) {
            const song = cartById.get(id);
            if (song) {
              next.push(song);
              cartById.delete(id);
            }
          }
          for (const song of cartById.values()) next.push(song);
          session.cart = next;
          return { total: next.length };
        });
      },

      clear(sessionId) {
        return store.mutate(sessionId, session => {
          session.cart = [];
          return { total: 0 };
        });
      },

      setEq(sessionId, eq) {
        return store.update(sessionId, { cartEq: eq || null });
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
        await store.update(sessionId, { result, songCount: cart.length });
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
      return result;
    },

    /** 聊天里「打开调音台」：确保有会话，然后插入一张 EQ 卡片。 */
    async openEqPanel() {
      let session = await store.getCurrent();
      if (!session) session = await store.create('新会话');
      const currentEq = session.cartEq || session.result?.eq || defaultEq();
      const messageId = newId('msg');
      await store.appendMessage(session.id, {
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
