/**
 * 网易云当前账号。扩展里依赖 music.163.com 的 cookie；
 * 未来宿主可以换成扫码/手动 cookie，只要提供同样的 client 方法。
 * @param {ReturnType<import('./client.js').createNeteaseClient>} client
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<import('../types.js').UserSummary>}
 */
export async function getCurrentUser(client, { signal } = {}) {
  const data = await client.getAccount({ signal });
  const uid = data?.profile?.userId || data?.account?.id;
  if (!uid) throw new Error('未拿到用户 ID —— 通常是未登录');
  return {
    uid,
    nickname: data?.profile?.nickname || '',
  };
}

/**
 * @param {ReturnType<import('./client.js').createNeteaseClient>} client
 * @param {{limit?: number, offset?: number, signal?: AbortSignal}} [options]
 */
export async function listUserPlaylists(client, { limit = 1000, offset = 0, signal } = {}) {
  const user = await getCurrentUser(client, { signal });
  const playlists = await client.getUserPlaylists(user.uid, { limit, offset, signal });
  return { user, playlists };
}
