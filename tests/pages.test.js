import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(resolve(root, file), 'utf8');

const PAGES = [
  { html: 'sidepanel.html', css: 'sidepanel.css' },
  { html: 'options.html', css: 'options.css' },
];

describe('页面资源', () => {
  it('样式表已经外置并被引用', () => {
    for (const { html, css } of PAGES) {
      const source = read(html);

      expect(source, `${html} 仍有内联 <style>`).not.toContain('<style>');
      expect(source, `${html} 没有引用 ${css}`).toContain(`href="${css}"`);
      expect(existsSync(resolve(root, css)), `缺少 ${css}`).toBe(true);

      const sheet = read(css);
      expect(sheet.length).toBeGreaterThan(1000);
      expect(sheet).toContain(':root');
    }
  });

  it('页面里没有内联事件处理属性', () => {
    for (const { html } of PAGES) {
      const source = read(html);
      const inline = source.match(/\son[a-z]+="/g) || [];
      expect(inline, `${html} 存在内联事件：${inline.join(', ')}`).toHaveLength(0);
    }
  });
});
