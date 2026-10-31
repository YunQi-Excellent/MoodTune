import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(resolve(root, 'sidepanel.js'), 'utf8');

/**
 * sidepanel.js 是 DOM 入口，不好用单测覆盖交互。
 * 但「重置只改了 EQ、忘了效果链」这类 bug 一旦回归，听感会直接错，
 * 所以这里对关键分支做静态守卫，和 offscreen / 页面测试是同一套思路。
 */
describe('调音卡片的重置', () => {
  const block = source.slice(
    source.indexOf("action === 'reset-eq-card'"),
    source.indexOf("action === 'save-eq-card'"),
  );

  it('走「套用原声」，EQ 与效果链一起复位', () => {
    expect(block).toContain('applySoundPreset');
    expect(block).toContain('DEFAULT_SOUND_PRESET_ID');
    // 只写 EQ 会留下空间处理，正是之前的 bug
    expect(block).not.toContain('setEqDirect');
  });
});

describe('音效入口', () => {
  it('卡片不再内嵌 chips，统一从「预设效果」进音效库', () => {
    expect(source).not.toContain('apply-sound-chip');
    expect(source).not.toContain('highlightSoundChips');
  });
});
