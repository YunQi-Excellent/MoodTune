import { describe, expect, it, vi } from 'vitest';
import { createLLMClient, parseDataLine, readEventStream } from '../../src/agent/llm.js';

const CONFIG = { endpoint: 'https://llm.test/v1/chat', model: 'mock', apiKey: 'sk-test' };

function jsonResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  };
}

function sseResponse(chunks) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length
          ? { done: false, value: new TextEncoder().encode(chunks[index++]) }
          : { done: true }),
      }),
    },
  };
}

function setup(response, config = CONFIG) {
  const fetchImpl = vi.fn(async () => response);
  const client = createLLMClient({ getConfig: async () => config, fetchImpl });
  return { client, fetchImpl };
}

describe('createLLMClient', () => {
  it('需要 getConfig', () => {
    expect(() => createLLMClient()).toThrow('getConfig');
  });

  it('没有配置时直接报错，不发请求', async () => {
    const { client, fetchImpl } = setup(null, null);

    await expect(client.stream([{ role: 'user', content: 'hi' }])).rejects.toThrow('未配置大模型');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('发送带鉴权的流式请求', async () => {
    const { client, fetchImpl } = setup(jsonResponse('好'));
    const controller = new AbortController();

    await client.stream([{ role: 'user', content: 'hi' }], { signal: controller.signal });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(CONFIG.endpoint);
    expect(init.headers.authorization).toBe('Bearer sk-test');
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'mock',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('非流式响应一次性回传内容', async () => {
    const { client } = setup(jsonResponse('完整回答'));
    const onChunk = vi.fn();

    await expect(client.stream([], { onChunk })).resolves.toBe('完整回答');
    expect(onChunk).toHaveBeenCalledWith('完整回答');
  });

  it('流式响应按增量回调并拼出完整文本', async () => {
    const { client } = setup(sseResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\ndata: [DONE]\n',
    ]));
    const chunks = [];

    await expect(client.stream([], { onChunk: chunk => chunks.push(chunk) })).resolves.toBe('你好');
    expect(chunks).toEqual(['你', '好']);
  });

  it('HTTP 失败带上状态码与响应片段', async () => {
    const { client } = setup({
      ok: false,
      status: 500,
      headers: { get: () => 'text/plain' },
      text: async () => 'upstream exploded',
    });

    await expect(client.stream([])).rejects.toThrow('大模型 HTTP 500：upstream exploded');
  });
});

describe('readEventStream', () => {
  it('跨块拆分的 data 行也能正确拼接', async () => {
    const chunks = [];

    const body = {
      getReader: () => {
        const parts = ['data: {"choices":[{"del', 'ta":{"content":"半"}}]}\n'];
        let index = 0;
        return {
          read: async () => (index < parts.length
            ? { done: false, value: new TextEncoder().encode(parts[index++]) }
            : { done: true }),
        };
      },
    };

    await expect(readEventStream(body, chunk => chunks.push(chunk))).resolves.toBe('半');
    expect(chunks).toEqual(['半']);
  });
});

describe('parseDataLine', () => {
  it('提取 delta 内容', () => {
    expect(parseDataLine('data: {"choices":[{"delta":{"content":"a"}}]}')).toBe('a');
  });

  it('忽略 [DONE]、非 data 行、坏 JSON 与空增量', () => {
    expect(parseDataLine('data: [DONE]')).toBe('');
    expect(parseDataLine('event: ping')).toBe('');
    expect(parseDataLine('data: {oops')).toBe('');
    expect(parseDataLine('data: {"choices":[{"delta":{}}]}')).toBe('');
    expect(parseDataLine('')).toBe('');
  });
});
