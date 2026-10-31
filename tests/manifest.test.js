import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

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
});
