/**
 * 大模型客户端：只负责发请求、处理流式/非流式响应，不掺任何业务。
 *
 * `getConfig` 与 `fetchImpl` 都注入，所以可以在没有网络、没有 chrome 的
 * 环境里用假 fetch 完整测出流式拼接与错误处理。
 *
 * 配置形状：`{ endpoint, model, apiKey }`。
 *
 * @param {object} options
 * @param {() => Promise<{endpoint: string, model: string, apiKey: string} | null>} options.getConfig
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.temperature]
 */
export function createLLMClient({
  getConfig,
  fetchImpl = (...args) => fetch(...args),
  temperature = 0.3,
} = {}) {
  if (typeof getConfig !== 'function') throw new Error('createLLMClient 需要 getConfig');
  if (typeof fetchImpl !== 'function') throw new Error('createLLMClient 需要 fetchImpl');

  /**
   * @param {{ role: string, content: string }[]} messages
   * @param {{ onChunk?: (delta: string) => void, signal?: AbortSignal }} [options]
   * @returns {Promise<string>} 完整文本
   */
  async function stream(messages, { onChunk = () => {}, signal } = {}) {
    const config = await getConfig();
    if (!config) throw new Error('未配置大模型');

    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`大模型 HTTP ${response.status}${detail ? '：' + detail.slice(0, 200) : ''}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('event-stream')) {
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (content) onChunk(content);
      return content;
    }

    return readEventStream(response.body, onChunk);
  }

  return { stream };
}

/**
 * 逐块读取 SSE 响应，把 `choices[0].delta.content` 增量交给 onChunk。
 * 单独导出便于直接对解析逻辑做单元测试。
 */
export async function readEventStream(body, onChunk) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const delta = parseDataLine(line);
      if (!delta) continue;
      full += delta;
      onChunk(delta);
    }
  }

  return full;
}

/** 解析一行 `data: {...}`，返回增量文本；非数据行或坏数据返回空串。 */
export function parseDataLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('data:')) return '';

  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return '';

  try {
    const parsed = JSON.parse(data);
    return parsed?.choices?.[0]?.delta?.content || '';
  } catch {
    return '';
  }
}
