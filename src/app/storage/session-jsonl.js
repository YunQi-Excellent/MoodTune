/**
 * 会话 JSONL 导入导出。
 *
 * 格式与 Claude Code / Codex / DSH 的“每会话一个日志文件”对齐：
 * - 第一行必须是 session 头
 * - state 行保存购物车/结算等投影
 * - message 行按 seq 排列
 * - summary 行预留给压缩摘要
 *
 * 解析器对坏行采取“跳过并记录 warning”的策略，方便导入外部文件；
 * 但缺少 session 头或版本过高会直接报错，避免把无关文件当会话导入。
 */

export const SESSION_JSONL_VERSION = 2;

export class SessionJsonlError extends Error {
  constructor(message, line) {
    super(line ? `${message}（第 ${line} 行）` : message);
    this.name = 'SessionJsonlError';
    this.line = line || null;
  }
}

function finiteSeq(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeHeader(header) {
  return {
    id: typeof header.id === 'string' ? header.id : '',
    name: typeof header.name === 'string' ? header.name : '',
    createdAt: Number(header.createdAt) || null,
    updatedAt: Number(header.updatedAt) || null,
    lastActiveAt: Number(header.lastActiveAt) || null,
    archivedAt: header.archivedAt ?? null,
    pinnedAt: header.pinnedAt ?? null,
  };
}

function stripEnvelope(record) {
  const { type: _type, ...rest } = record;
  return rest;
}

/**
 * 生成可下载的安全文件名。
 * @param {object} session
 * @returns {string}
 */
export function sessionJsonlFilename(session) {
  const id = String(session?.id || 'session');
  const base = String(session?.name || '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || id;
  return `${base}-${id}.jsonl`;
}

/**
 * 把一个完整会话（含 messages）序列化成 JSONL。
 * @param {object} session
 * @returns {string}
 */
export function serializeSessionJsonl(session) {
  if (!session || typeof session !== 'object') {
    throw new SessionJsonlError('需要会话对象');
  }

  const header = {
    type: 'session',
    version: SESSION_JSONL_VERSION,
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActiveAt: session.lastActiveAt,
    archivedAt: session.archivedAt ?? null,
    pinnedAt: session.pinnedAt ?? null,
  };

  const lines = [JSON.stringify(header)];
  lines.push(JSON.stringify({
    type: 'state',
    cart: Array.isArray(session.cart) ? session.cart : [],
    cartEq: session.cartEq ?? null,
    result: session.result ?? null,
    eq: session.eq ?? null,
    playlistSnapshot: session.playlistSnapshot ?? null,
  }));

  const messages = Array.isArray(session.messages) ? [...session.messages] : [];
  messages.sort((a, b) => (finiteSeq(a?.seq) ?? 0) - (finiteSeq(b?.seq) ?? 0));

  messages.forEach((message, index) => {
    const { sessionId: _sessionId, type: _type, ...rest } = message || {};
    lines.push(JSON.stringify({
      type: 'message',
      seq: finiteSeq(rest.seq) ?? index + 1,
      ...rest,
    }));
  });

  if (session.summary && (session.summary.text || session.summary)) {
    const summary = typeof session.summary === 'object' ? session.summary : { text: String(session.summary) };
    lines.push(JSON.stringify({
      type: 'summary',
      throughSeq: finiteSeq(summary.throughSeq),
      text: summary.text ?? '',
      createdAt: summary.createdAt ?? null,
      model: summary.model ?? null,
    }));
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 解析 JSONL。返回的 session 已经合并 state / summary，并带 messages。
 * @param {string} text
 * @param {{ strict?: boolean }} [options]
 * @returns {{ session: object, warnings: string[], version: number }}
 */
export function parseSessionJsonl(text, { strict = false } = {}) {
  if (typeof text !== 'string') throw new SessionJsonlError('JSONL 内容必须是字符串');

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const warnings = [];
  const messages = [];
  let header = null;
  let state = {};
  let summary = null;
  let version = 1;

  const fail = (message, line) => {
    if (strict) throw new SessionJsonlError(message, line);
    warnings.push(line ? `${message}（第 ${line} 行）` : message);
  };

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.trim();
    if (!line) return;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail('JSON 解析失败，已跳过', lineNumber);
      return;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      fail('不是 JSON 对象，已跳过', lineNumber);
      return;
    }

    if (!header) {
      if (record.type !== 'session') {
        throw new SessionJsonlError('第一行必须是 type=session 的会话头', lineNumber);
      }
      header = normalizeHeader(record);
      version = Number(record.version) || 1;
      if (version > SESSION_JSONL_VERSION) {
        throw new SessionJsonlError(
          `不支持的会话格式版本 ${version}，当前最高支持 ${SESSION_JSONL_VERSION}`,
          lineNumber,
        );
      }
      if (!header.id) warnings.push('会话头缺少 id，导入时会自动生成');
      return;
    }

    if (record.type === 'state') {
      state = stripEnvelope(record);
      return;
    }

    if (record.type === 'summary') {
      summary = {
        throughSeq: finiteSeq(record.throughSeq),
        text: String(record.text ?? ''),
        createdAt: Number(record.createdAt) || null,
        model: record.model ?? null,
      };
      return;
    }

    if (record.type === 'message') {
      const { seq, ...message } = stripEnvelope(record);
      const normalized = {
        ...message,
        seq: finiteSeq(seq),
      };
      if (!normalized.id) warnings.push(`消息缺少 id（第 ${lineNumber} 行），导入时会自动生成`);
      messages.push(normalized);
      return;
    }

    fail(`未知记录类型 ${String(record.type)}，已跳过`, lineNumber);
  });

  if (!header) throw new SessionJsonlError('文件为空或不包含会话头');

  const byId = new Map();
  const withoutId = [];
  for (const message of messages) {
    if (!message.id) {
      withoutId.push(message);
      continue;
    }
    if (byId.has(message.id)) warnings.push(`重复的 message.id：${message.id}，保留最后一条`);
    byId.set(message.id, message);
  }

  const ordered = [...byId.values(), ...withoutId]
    .sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));

  if (summary && summary.throughSeq !== null && ordered.length > 0) {
    const maxSeq = Math.max(...ordered.map(message => finiteSeq(message.seq) ?? 0));
    if (summary.throughSeq > maxSeq) {
      warnings.push(`summary.throughSeq=${summary.throughSeq} 超过最大消息序号 ${maxSeq}`);
    }
  }

  return {
    session: {
      ...header,
      ...state,
      messages: ordered,
      summary,
    },
    warnings,
    version,
  };
}
