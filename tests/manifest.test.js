import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

describe('manifest.json', () => {
  it('使用 Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('包含扩展运行所需的基础字段', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Array.isArray(manifest.permissions)).toBe(true);
    expect(Array.isArray(manifest.host_permissions)).toBe(true);
  });

  it('所有入口文件都真实存在', () => {
    const entries = [
      manifest.background?.service_worker,
      manifest.side_panel?.default_path,
      manifest.options_ui?.page,
    ].filter(Boolean);

    expect(entries.length).toBe(3);
    for (const entry of entries) {
      expect(existsSync(resolve(root, entry)), `缺少入口文件：${entry}`).toBe(true);
    }
  });

  it('页面脚本以 ES module 方式加载', () => {
    for (const page of ['sidepanel.html', 'offscreen.html', 'options.html']) {
      const html = readFileSync(resolve(root, page), 'utf8');
      expect(html, `${page} 缺少 type="module" 脚本`).toMatch(
        /<script[^>]*type="module"[^>]*src="[^"]+\.js"/,
      );
    }
  });

  it('权限保持最小集：不再申请 cookies', () => {
    // 登录态靠 host_permissions + fetch credentials 复用，不需要 chrome.cookies
    expect(manifest.permissions).not.toContain('cookies');
    expect(manifest.permissions).toContain('storage');
  });

  it('声明最低 Chrome 版本（runtime.getContexts 需要 116）', () => {
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(116);
  });

  it('版本号只有一个来源，且与 package.json 一致', () => {
    expect(manifest.version).toBe(pkg.version);

    const fsSync = readFileSync(resolve(root, 'fs-sync.js'), 'utf8');
    expect(fsSync, 'fs-sync 不应硬编码应用版本').not.toMatch(/APP_VERSION/);
    expect(fsSync).toContain('getManifest');
  });

  it('CSP 不允许 eval 与远程脚本', () => {
    const csp = manifest.content_security_policy?.extension_pages || '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
  });
});

describe('依赖与脚本', () => {
  it('保留零构建：没有打包/转译脚本', () => {
    expect(pkg.type).toBe('module');
    const scripts = Object.keys(pkg.scripts || {});
    expect(scripts).toEqual(expect.arrayContaining(['lint', 'test', 'check']));
    expect(scripts.some(name => /build|bundle|webpack|vite build/.test(name))).toBe(false);
  });
});
