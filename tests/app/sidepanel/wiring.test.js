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
