/**
 * 消息路由：把 chrome.runtime.onMessage 的请求分发给注册的处理器。
 *
 * 约定：
 * - 处理器签名 `(req, sender) => response | Promise<response>`
 * - 必须返回完整响应对象（`{ ok: true, ... }` / `{ ok: false, ... }`）
 * - 抛出的异常由路由统一转成 `{ ok: false, error }`，分支里不用重复 try/catch
 * - 返回 `true` 表示接管了消息，需要保持 sendResponse 通道打开
 *
 * 匹配顺序：先按 `target: 'background'` + `type` 精确匹配，
 * 再按 `type` 前缀匹配（目前只有 PLAYER_*），最后按 `action` 匹配。
 *
 * @param {object} routes
 * @param {Record<string, Function>} [routes.actions] action 名 → 处理器
 * @param {Record<string, Function>} [routes.types] target=background 的 type → 处理器
 * @param {{ prefix: string, handle: Function }[]} [routes.typePrefixes]
 */
export function createMessageRouter({ actions = {}, types = {}, typePrefixes = [] } = {}) {
  const actionRoutes = new Map(Object.entries(actions));
  const typeRoutes = new Map(Object.entries(types));
  const prefixes = [...typePrefixes];

  function resolve(req) {
    if (!req || typeof req !== 'object') return null;

    if (req.target === 'background' && typeof req.type === 'string') {
      const exact = typeRoutes.get(req.type);
      if (exact) return exact;
      for (const { prefix, handle } of prefixes) {
        if (req.type.startsWith(prefix)) return handle;
      }
      // 没有匹配的 type 时继续尝试 action（历史消息可能同时带 target 和 action）
    }

    if (typeof req.action === 'string') return actionRoutes.get(req.action) || null;
    return null;
  }

  return function route(req, sender, sendResponse) {
    const handler = resolve(req);
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(req, sender))
      .then(
        (response) => { sendResponse(response === undefined ? { ok: true } : response); },
        (error) => { sendResponse({ ok: false, error: error?.message || String(error) }); },
      );

    return true;
  };
}
