/**
 * 会话与购物车消息。
 *
 * 只做「请求 → 服务方法 → 响应」，业务规则都在 sessionService 里。
 */
export function createSessionHandlers(sessions) {
  if (!sessions) throw new Error('createSessionHandlers 需要 sessions');

  return {
    listSessions: async () => ({ ok: true, sessions: await sessions.list() }),
    getCurrentSession: async () => ({
      ok: true,
      session: await (sessions.currentPage ? sessions.currentPage() : sessions.current()),
    }),
    getSessionState: async (req) => ({ ok: true, session: await sessions.state(req.sessionId) }),
    loadEarlierMessages: async (req) => ({
      ok: true,
      ...(await sessions.loadEarlier(req.sessionId, req.beforeSeq, req.limit)),
    }),
    createSession: async (req) => ({ ok: true, session: await sessions.create(req.name) }),
    switchSession: async (req) => ({ ok: true, session: await sessions.switchTo(req.id) }),
    deleteSession: async (req) => ({ ok: true, sessions: await sessions.remove(req.id) }),
    renameSession: async (req) => ({ ok: true, session: await sessions.rename(req.id, req.name) }),

    cartAdd: async (req) => ({ ok: true, ...(await sessions.cart.add(req.sessionId, req.songs)) }),
    cartRemove: async (req) => ({ ok: true, ...(await sessions.cart.remove(req.sessionId, req.songIds)) }),
    cartReorder: async (req) => ({ ok: true, ...(await sessions.cart.reorder(req.sessionId, req.orderedIds)) }),
    cartClear: async (req) => ({ ok: true, ...(await sessions.cart.clear(req.sessionId)) }),
    cartSettle: async (req) => ({ ok: true, ...(await sessions.cart.settle(req.sessionId)) }),

    cartSetEq: async (req) => {
      await sessions.cart.setEq(req.sessionId, req.eq);
      return { ok: true };
    },

    updateSessionResultSource: async (req) => {
      await sessions.updateResultSource(req.sessionId, {
        playlistSource: req.playlistSource,
        eqSource: req.eqSource,
      });
      return { ok: true };
    },

    restoreSession: async (req) => ({ ok: true, ...(await sessions.restore(req.id)) }),

    openEqPanel: async () => ({ ok: true, ...(await sessions.openEqPanel()) }),
  };
}
