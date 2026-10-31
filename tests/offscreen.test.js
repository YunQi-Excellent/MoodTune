import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'offscreen.js'), 'utf8');

describe('offscreen 平台无关性', () => {
  it('不直接访问网易云 API', () => {
    expect(source).not.toContain('music.163.com');
    expect(source).not.toContain('fetchSongUrl');
    expect(source).not.toContain('enhance/player/url');
  });

  it('播放地址通过 background 解析', () => {
    expect(source).toContain('PLAYER_RESOLVE_URL');
  });
});
