import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../../src/providers/netease/http.js';

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

describe('createHttpClient', () => {
  it('拼接 URL、编码参数并携带 cookie', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 200, result: {} }));
    const http = createHttpClient({ fetchImpl });

    const data = await http.requestJson('/api/search/get/web', {
      params: { s: '周杰伦 晴天', type: 1, offset: 0, ignore: undefined },
    });

    expect(data.code).toBe(200);
    const [url, options] = fetchImpl.mock.calls[0];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://music.163.com/api/search/get/web');
    expect(parsed.searchParams.get('s')).toBe('周杰伦 晴天');
    expect(parsed.searchParams.get('type')).toBe('1');
    expect(parsed.searchParams.get('ignore')).toBeNull();
    expect(options.credentials).toBe('include');
  });

  it('支持自定义 baseUrl 与 credentials', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 200 }));
    const http = createHttpClient({
      fetchImpl,
      baseUrl: 'https://example.com',
      credentials: 'omit',
      headers: { 'x-test': '1' },
    });

    await http.requestJson('/api/x');

    expect(fetchImpl.mock.calls[0][0]).toBe('https://example.com/api/x');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      credentials: 'omit',
      headers: { 'x-test': '1' },
    });
  });

  it('HTTP 非 2xx 抛错', async () => {
    const http = createHttpClient({
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 500 }),
    });

    await expect(http.requestJson('/api/x')).rejects.toThrow('HTTP 500');
  });

  it('业务 code 非 200 抛错', async () => {
    const http = createHttpClient({
      fetchImpl: async () => jsonResponse({ code: 400 }),
    });

    await expect(http.requestJson('/api/x')).rejects.toThrow('code=400');
  });

  it('返回非 JSON 时抛错', async () => {
    const http = createHttpClient({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error('bad json'); },
      }),
    });

    await expect(http.requestJson('/api/x')).rejects.toThrow('返回非 JSON');
  });

  it('没有 fetch 时给出明确错误', async () => {
    const http = createHttpClient({ fetchImpl: null });

    await expect(http.requestJson('/api/x')).rejects.toThrow('没有可用的 fetch');
  });
});
