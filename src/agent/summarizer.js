import { SUMMARY_SYSTEM } from './prompts.js';

/**
 * 会话压缩：只生成摘要投影，不删除原始消息。
 *
 * 阈值按“消息条数或字符数”判断；字符数比 token 便宜且无需额外依赖，
 * 对当前中文短对话足够用。
 */
export const COMPACTION_CONFIG = Object.freeze({
  minMessages: 60,
  maxChars: 24_000,
  keepRecent: 20,
  maxSummaryChars: 1_800,
  maxInputChars: 20_000,
  maxMessageChars: 1_200,
});

function messageText(message) {
  const parts = [
    message?.text,
    message?.reason,
    message?.name,
    message?.plan?.topic,
    message?.plan?.need,
    message?.thinking?.text,
  ];
  if (Array.isArray(message?.picks)) {
    for (const pick of message.picks) parts.push(pick?.name, pick?.artists, pick?.reason);
  }
  return parts.filter(part => typeof part === 'string' && part.trim()).join(' ');
}

/** 只统计消息正文，避免把整张 plan-card 的 JSON 都算进去。 */
export function estimateMessagesChars(messages) {
  return (Array.isArray(messages) ? messages : [])
    .reduce((sum, message) => sum + messageText(message).length, 0);
}

/**
 * 选出“可以压进摘要、但还没被摘要覆盖”的旧消息。
 * 返回 null 表示当前不需要压缩。
 */
export function selectCompactionRange(messages, {
  summaryThroughSeq = 0,
  keepRecent = COMPACTION_CONFIG.keepRecent,
  minMessages = COMPACTION_CONFIG.minMessages,
  maxChars = COMPACTION_CONFIG.maxChars,
  force = false,
} = {}) {
  const all = (Array.isArray(messages) ? messages : [])
    .filter(message => (Number(message?.seq) || 0) > Number(summaryThroughSeq || 0));
  const totalChars = estimateMessagesChars(all);
  if (!force && all.length < minMessages && totalChars < maxChars) return null;

  const keep = Math.max(0, Number(keepRecent) || 0);
  if (all.length <= keep) return null;

  const target = all.slice(0, all.length - keep);
  if (target.length === 0) return null;

  const last = target[target.length - 1];
  return {
    messages: target,
    throughSeq: Number(last?.seq) || Number(summaryThroughSeq || 0) + target.length,
    totalChars,
  };
}

function buildTranscript(messages, maxChars) {
  const lines = [];
  for (const message of messages) {
    const text = messageText(message).slice(0, COMPACTION_CONFIG.maxMessageChars);
    if (!text) continue;
    const role = message?.role || 'agent';
    const kind = message?.kind ? `/${message.kind}` : '';
    lines.push(`[${role}${kind}] ${text}`);
  }
  const transcript = lines.join('\n');
  return transcript.length > maxChars ? transcript.slice(-maxChars) : transcript;
}

/**
 * 调一次模型生成摘要。失败由调用方决定是否保留旧摘要。
 * @returns {Promise<string>}
 */
export async function summarizeSession({
  llm,
  messages,
  previousSummary = '',
  signal,
  maxTokens = 700,
  config = COMPACTION_CONFIG,
}) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('缺少大模型客户端');
  const transcript = buildTranscript(messages, config.maxInputChars);
  if (!transcript) return '';

  const input = [
    previousSummary ? `已有摘要：\n${String(previousSummary).slice(0, config.maxSummaryChars)}` : '',
    `需要压缩的较早对话：\n${transcript}`,
  ].filter(Boolean).join('\n\n');

  const raw = await llm.stream(
    [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: input },
    ],
    { signal, maxTokens, temperature: 0.2 },
  );
  return String(raw || '').trim().slice(0, config.maxSummaryChars);
}
