import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(resolve(root, 'sidepanel.js'), 'utf8');

/** 取出一个顶层函数的完整源码（按花括号配对，能容忍嵌套）。 */
function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

/**
 * sidepanel.js 是 DOM 入口，交互没法直接单测。
 * 但「换了音效滑杆没跟着动」「重置只复位了一半」这类 bug 一旦回归，
 * 用户看到的就是界面与声音对不上，所以这里对关键路径做静态守卫。
 */
describe('音效应用后的同步', () => {
  it('卡片内选音效后同步所有调音卡片', () => {
    expect(functionBody('applySoundChip')).toContain('syncEqCards');
  });

  it('从音效库选音效后同样同步', () => {
    expect(functionBody('applySoundPresetCard')).toContain('syncEqCards');
  });

  it('重置走「套用原声」，EQ 与效果链一起复位', () => {
    const block = source.slice(
      source.indexOf("action === 'reset-eq-card'"),
      source.indexOf("action === 'save-eq-card'"),
    );

    expect(block).toContain('applySoundPreset');
    expect(block).toContain('DEFAULT_SOUND_PRESET_ID');
    expect(block).toContain('syncEqCards');
    // 只写 EQ 会留下空间处理，正是之前的 bug
    expect(block).not.toContain('setEqDirect');
  });

  it('同步函数覆盖滑杆、预设高亮与标题', () => {
    const body = functionBody('syncEqCards');
    expect(body).toContain('syncEqCardInputs');
    expect(body).toContain('updateEqPresetChips');
  });
});

/**
 * 中断回归守卫：之前 agent 在规划后就发 THINKING_END，
 * 侧边栏把停止按钮收起来，用户在长时间挖歌时完全没法中断。
 */
describe('中断', () => {
  it('停止按钮与 Esc 都走同一个中断入口', () => {
    expect(source).toContain("stopBtn.addEventListener('click', abortRunning)");
    expect(source).toContain("e.key === 'Escape'");
  });

  it('中断入口会通知后台取消', () => {
    expect(functionBody('abortRunning')).toContain('chatAbort');
  });

  it('思考阶段事件会保持运行态，不会把发送按钮换回来', () => {
    const start = source.indexOf("msg.type === 'CHAT_THINKING_START'");
    const end = source.indexOf("msg.type === 'CHAT_THINKING_END'");
    const block = source.slice(start, end);

    expect(block).toContain('setRunningUI(true)');
  });

  it('中断后忽略迟到的进度事件', () => {
    expect(source).toContain('state.stopped');
  });
});

/**
 * 全选快捷按钮：卡片上直接能一键清空/全选，不用一个个点。
 */
describe('全选快捷按钮', () => {
  it('点击只切换勾选状态，不同步写歌单', () => {
    const start = source.indexOf("action === 'toggle-select-all'");
    const end = source.indexOf("action === 'toggle-eq-presets'");
    const block = source.slice(start, end);

    expect(block).toContain('track-cb:not(:disabled)');
    expect(block).toContain('syncSelectAllLabel');
    expect(block).not.toContain('cartAdd');
  });

  it('单个勾选框变化时同步按钮文案', () => {
    expect(source).toContain("closest('.track-cb')");
    expect(functionBody('syncSelectAllLabel')).toContain('取消全选');
  });
});
