import { NETEASE_BASE_URL } from './constants.js';

/**
 * 网易云 HTTP 客户端。fetch、credentials、headers 都可注入，便于测试和未来宿主适配。
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   baseUrl?: string,
 *   credentials?: RequestCredentials,
 *   headers?: Record<string, string>,
 * }} [options]
 */
export function createHttpClient({
  fetchImpl = globalThis.fetch,
  baseUrl = NETEASE_BASE_URL,
  credentials = 'include',
  headers = {},
} = {}) {
  /**
   * @param {string|URL} path
   * @param {{params?: Record<string, unknown>, signal?: AbortSignal, expectCode?: number}} [options]
   * @returns {Promise<any>}
   */
  async function requestJson(path, { params, signal, expectCode = 200 } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('当前环境没有可用的 fetch');
    }

    const url = path instanceof URL ? path : new URL(path, baseUrl);
    if (params && typeof params === 'object') {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), { credentials, headers, signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new Error(`[netease] 请求失败：${error?.message || error}`, { cause: error });
    }

    if (!response.ok) {
      throw new Error(`[netease] ${url.pathname} HTTP ${response.status}`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`[netease] ${url.pathname} 返回非 JSON`);
    }

    if (typeof data?.code === 'number' && data.code !== expectCode) {
      throw new Error(`[netease] ${url.pathname} code=${data.code}`);
    }
    return data;
  }

  return { requestJson };
}
