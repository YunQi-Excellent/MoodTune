/**
 * 网易云当前账号。扩展里依赖 music.163.com 的 cookie；
 * 未来宿主可以换成扫码/手动 cookie，只要提供同样的 client 方法。
 * @param {ReturnType<import('./client.js').createNeteaseClient>} client
 * @returns {Promise<import('../types.js').UserSummary>}
 */
export async function getCurrentUser(client) {
  const data = await client.getAccount();
  const uid = data?.profile?.userId || data?.account?.id;
  if (!uid) throw new Error('未拿到用户 ID —— 通常是未登录');
  return {
    uid,
    nickname: data?.profile?.nickname || '',
  };
}

/**
 * @param {ReturnType<import('./client.js').createNeteaseClient>} client
 * @param {{limit?: number, offset?: number}} [options]
 */
export async function listUserPlaylists(client, { limit = 1000, offset = 0 } = {}) {
  const user = await getCurrentUser(client);
  const playlists = await client.getUserPlaylists(user.uid, { limit, offset });
  return { user, playlists };
}
