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
   * @param {{
   *   onChunk?: (delta: string) => void,
   *   onReasoning?: (delta: string) => void,
   *   signal?: AbortSignal,
   *   maxTokens?: number,
   *   temperature?: number,
   * }} [options]
   * @returns {Promise<string>} 完整文本
   */
  async function stream(messages, {
    onChunk = () => {},
    onReasoning = () => {},
    signal,
    maxTokens,
    temperature: callTemperature,
  } = {}) {
    const config = await getConfig();
    if (!config) throw new Error('未配置大模型');

    const body = {
      model: config.model,
      messages,
      temperature: callTemperature ?? temperature,
      stream: true,
    };
    // 抽取/路由这类短任务必须限制输出长度，否则模型会自由发挥，延迟不可控。
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`大模型 HTTP ${response.status}${detail ? '：' + detail.slice(0, 200) : ''}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('event-stream')) {
      const data = await response.json();
      const message = data?.choices?.[0]?.message || {};
      const reasoning = message.reasoning_content || message.reasoning || '';
      if (reasoning) onReasoning(reasoning);
      const content = message.content || '';
      if (content) onChunk(content);
      return content;
    }

    return readEventStream(response.body, onChunk, onReasoning);
  }

  return { stream };
}

/**
 * 逐块读取 SSE 响应，把 `choices[0].delta.content` 增量交给 onChunk，
 * `delta.reasoning_content`（推理模型的思考流）交给 onReasoning。
 * 单独导出便于直接对解析逻辑做单元测试。
 */
export async function readEventStream(body, onChunk, onReasoning = () => {}) {
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
      const reasoning = parseReasoningLine(line);
      if (reasoning) onReasoning(reasoning);
      const delta = parseDataLine(line);
      if (!delta) continue;
      full += delta;
      onChunk(delta);
    }
  }

  return full;
}

/** 解析一行 `data: {...}` 里的推理增量；非数据行或没有推理字段返回空串。 */
export function parseReasoningLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('data:')) return '';

  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return '';

  try {
    const parsed = JSON.parse(data);
    const delta = parsed?.choices?.[0]?.delta;
    return delta?.reasoning_content || delta?.reasoning || '';
  } catch {
    return '';
  }
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
