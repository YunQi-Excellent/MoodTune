/**
 * 对话入口。
 *
 * chatStart 立刻回包，真正的检索流程在 chat agent 里跑并通过 CHAT_* 事件推进度，
 * 所以这里不能 await chat.start，否则侧边栏会等到整个检索结束才收到响应。
 */
export function createChatHandlers({ chat, sessions, forwardToSidepanel }) {
  if (!chat || !sessions) throw new Error('createChatHandlers 需要 chat / sessions');
  if (typeof forwardToSidepanel !== 'function') {
    throw new Error('createChatHandlers 需要 forwardToSidepanel');
  }

  return {
    chatStart: (req) => {
      const userNeed = String(req.userNeed || '').trim();
      if (!userNeed) return { ok: false, error: '内容为空' };
      // start 内部会中止上一轮，这里不用再 abort
      chat.start({
        userNeed,
        sessionId: req.sessionId,
        userMessageId: req.userMessageId,
      });
      return { ok: true };
    },

    compactSession: async (req) => {
      if (!req?.sessionId) return { ok: false, error: '缺少会话 id' };
      if (typeof chat.compact !== 'function') return { ok: false, error: '当前不支持会话压缩' };
      const summary = await chat.compact(req.sessionId);
      return { ok: true, compacted: Boolean(summary), summary: summary || null };
    },

    chatAbort: async () => {
      // 没在跑时不广播结束事件，避免把下一轮的思考节点提前关掉。
      const aborted = chat.abort();
      const session = await sessions.current();
      if (aborted) {
        forwardToSidepanel('CHAT_THINKING_END', {
          sessionId: session?.id,
          aborted: true,
        });
      }
      return { ok: true, aborted };
    },
  };
}
