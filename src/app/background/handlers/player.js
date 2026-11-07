/**
 * target 为 background 的播放器消息。
 *
 * PERSIST_* 是 offscreen 播放状态的回写（发出去就不管），
 * PLAYER_RESOLVE_URL 让播放器不用知道任何平台的接口细节，
 * PLAYER_* 其余指令统一转发给 offscreen。
 */
export function createPlayerHandlers({ player, forwardToSidepanel }) {
  if (!player) throw new Error('createPlayerHandlers 需要 player');
  if (typeof forwardToSidepanel !== 'function') {
    throw new Error('createPlayerHandlers 需要 forwardToSidepanel');
  }

  return {
    types: {
      PERSIST_EQ: (req) => {
        player.saveEq(req.payload?.eq);
        return { ok: true };
      },

      PERSIST_EFFECTS: (req) => {
        player.saveEffects(req.payload?.effects);
        return { ok: true };
      },

      PERSIST_VOLUME: (req) => {
        player.saveVolume(req.payload?.volume);
        return { ok: true };
      },

      LOAD_PLAYER_STATE: () => player.loadPrefs(),

      PLAYER_RESOLVE_URL: async (req) => ({
        ok: true,
        url: await player.resolveStreamUrl(req.payload?.song),
      }),

      PLAYER_STATE_CHANGED: (req) => {
        forwardToSidepanel('PLAYER_STATE_CHANGED', req.payload);
        return { ok: true };
      },
    },

    prefix: {
      prefix: 'PLAYER_',
      handle: async req => (await player.dispatch(req.type, req.payload || {})) || { ok: true },
    },
  };
}
