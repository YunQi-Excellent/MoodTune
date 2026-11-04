import { describe, expect, it, vi } from 'vitest';
import {
  createLLMClient,
  parseDataLine,
  parseReasoningLine,
  readEventStream,
} from '../../src/agent/llm.js';

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

  it('短任务可以限制输出长度与温度', async () => {
    const { client, fetchImpl } = setup(jsonResponse('{}'));

    await client.stream([], { maxTokens: 80, temperature: 0 });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(80);
    expect(body.temperature).toBe(0);
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

describe('推理模型流', () => {
  it('reasoning_content 单独回调，不混进正文', async () => {
    const { client } = setup(sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"先想一下"}}]}\n',
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n',
    ]));
    const content = [];
    const reasoning = [];

    const result = await client.stream([], {
      onChunk: chunk => content.push(chunk),
      onReasoning: chunk => reasoning.push(chunk),
    });

    expect(reasoning).toEqual(['先想一下']);
    expect(content).toEqual(['{"ok":true}']);
    // 正文只包含答案，JSON 解析不会被思考过程污染。
    expect(result).toBe('{"ok":true}');
  });

  it('非流式响应里的 reasoning_content 也会回调', async () => {
    const onReasoning = vi.fn();
    const { client } = setup({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { reasoning_content: '想一想', content: '答案' } }] }),
      text: async () => '',
    });

    await expect(client.stream([], { onReasoning })).resolves.toBe('答案');
    expect(onReasoning).toHaveBeenCalledWith('想一想');
  });

  it('parseReasoningLine 只认推理字段', () => {
    expect(parseReasoningLine('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}')).toBe('想');
    expect(parseReasoningLine('data: {"choices":[{"delta":{"reasoning":"想"}}]}')).toBe('想');
    expect(parseReasoningLine('data: {"choices":[{"delta":{"content":"答案"}}]}')).toBe('');
    expect(parseReasoningLine('data: [DONE]')).toBe('');
    expect(parseReasoningLine('event: ping')).toBe('');
    expect(parseReasoningLine('')).toBe('');
  });
});
