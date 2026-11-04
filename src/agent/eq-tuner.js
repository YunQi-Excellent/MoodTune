import { normalizeEq } from '../core/eq.js';
import { extractJson } from '../core/json.js';
import { EQ_TUNER_SYSTEM } from './prompts.js';

/**
 * 让大模型给出 EQ 调整，并归一化到音频引擎能接受的形状。
 *
 * 只负责「提示词 → JSON → EQ」，应用 EQ 由调用方（chat agent）决定，
 * 这样单独测调音逻辑时不需要播放器。
 */
export async function tuneEq({ llm, userNeed, currentEq, onChunk, signal } = {}) {
  if (!llm) throw new Error('tuneEq 需要 llm');

  const eqContext = currentEq
    ? `\n\n当前 EQ（请在此基础上修改，除非用户说"重新调"）：\n${JSON.stringify({
        preampDb: currentEq.preampDb,
        bands: currentEq.bands,
      }, null, 2)}`
    : '\n\n用户还没有任何 EQ 配置，请从平坦状态开始设计。';

  const messages = [
    { role: 'system', content: EQ_TUNER_SYSTEM },
    { role: 'user', content: `用户需求：${userNeed}${eqContext}\n\n请先分析，再输出调整后的完整 EQ JSON。` },
  ];

  const raw = await llm.stream(messages, { onChunk: onChunk || (() => {}), signal });
  const parsed = extractJson(raw);
  if (!parsed || !parsed.eq) throw new Error('大模型没有给出有效的 EQ JSON');

  return {
    eq: normalizeEq(parsed.eq),
    reason: String(parsed.reason || '').slice(0, 200),
    // 原始流式文本，调用方可以选择持久化下来当思考记录。
    raw,
  };
}
