/**
 * 文件系统同步相关的消息处理。
 *
 * fs-sync 的失败约定是 `{ ok: false, reason }`，这里统一兜住，
 * 避免每个分支重复 try/catch。
 */
export function createFsHandlers(fs) {
  if (!fs) throw new Error('createFsHandlers 需要 fs 依赖');

  const reasonify = handler => async (req) => {
    try {
      return await handler(req);
    } catch (e) {
      return { ok: false, reason: e?.message || String(e) };
    }
  };

  return {
    fsGetStatus: async () => {
      try {
        return { ok: true, ...(await fs.getStatus()), lastSyncAt: fs.getLastSyncAt() };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },

    fsBindFolder: reasonify(() => fs.bind()),
    fsUnbindFolder: reasonify(() => fs.unbind()),
    fsSyncNow: reasonify(() => fs.syncNow()),
    fsForcePush: reasonify(req => fs.forcePush({ force: true, allowEmptyOverwrite: !!req.allowEmpty })),
    fsPullFromFolder: reasonify(() => fs.pull()),
  };
}
